import { useState, useEffect, useRef, CSSProperties, useMemo } from 'react';
import { useParams } from 'react-router-dom';

// Default chain RPC used to fetch the target block during verification (full URL, user may override)
const DEFAULT_RPC_URL = 'https://p2p.tangent.cash:18419';

// === Client-side verification of finished giveaway results ===
// Mirrors the server selection algorithm exactly: same digest string, same seed mixing,
// same LCG shuffle and winner selection - so any third party can re-run it.

type VerifyLeaf = {
  h: string;
  ah: string;
  ap: number;
  dx: number;
  xs: number;
};

type VerifyResultRow = {
  rank: number;
  h: string;
  amount: number;
};

type VerifyBundle = {
  version: number;
  hash_id: string;
  target_block: number;
  proof_hash: string;
  winner_ranges: { count: number; amount: number }[];
  discord_reward_amount: number;
  discord_username_mandatory: number;
  total_participants: number;
  participants: VerifyLeaf[];
  results: VerifyResultRow[];
  manifest_hash: string;
};

async function sha256Hex(input: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Same as backend hashAddress: sha256(id + address)
async function hashAddress(id: string, address: string): Promise<string> {
  return sha256Hex(id + address);
}

function manifestDigestInput(bundle: VerifyBundle): string {
  return [
    'gv1',
    bundle.hash_id,
    String(bundle.target_block),
    bundle.proof_hash,
    bundle.winner_ranges.map((r) => `${r.count}:${r.amount}`).join(','),
    String(bundle.discord_reward_amount),
    String(bundle.discord_username_mandatory),
    String(bundle.total_participants),
    bundle.participants.map((p) => `${p.h}:${p.ap}:${p.dx}:${p.xs}`).join(','),
    bundle.results.map((r) => `${r.rank}:${r.h}:${r.amount}`).join(',')
  ].join('\n');
}

async function computeManifestHash(bundle: VerifyBundle): Promise<string> {
  return sha256Hex(manifestDigestInput(bundle));
}

function recomputeResults(bundle: VerifyBundle, proofHex: string): VerifyResultRow[] {
  const seed = BigInt(proofHex);
  let compositeSeed: bigint = seed;
  for (const leaf of bundle.participants) {
    compositeSeed = compositeSeed ^ BigInt(`0x${leaf.ah}`);
  }

  const bitDepth = BigInt(Math.max(seed.toString(2).length + 1, 128));
  const mod = 1n << bitDepth;
  const increment = (1n << (bitDepth - 1n)) + 1n;
  const multiplier = (3n * (1n << (bitDepth - 2n))) + 1n;

  let state = compositeSeed % mod;
  if (state === 0n) state = 1n;

  const shuffled: VerifyLeaf[] = [...bundle.participants];
  for (let i = shuffled.length - 1; i > 0; i--) {
    state = (multiplier * state + increment) % mod;
    const randomIndex = Number(state % (BigInt(i) + 1n));
    const temp = shuffled[i] as VerifyLeaf;
    shuffled[i] = shuffled[randomIndex] as VerifyLeaf;
    shuffled[randomIndex] = temp;
  }

  const lastRange = bundle.winner_ranges[bundle.winner_ranges.length - 1];
  const combinedRanges = lastRange
    ? [...bundle.winner_ranges, { count: bundle.total_participants - lastRange.count, amount: 0 }]
    : [];

  const results: VerifyResultRow[] = [];
  for (const range of combinedRanges) {
    const length = Math.min(range.count, shuffled.length);
    for (let i = results.length; i < length; i++) {
      const item = shuffled[i];
      if (item) {
        let individualAmount = range.amount;
        if (range.amount > 0 && item.dx === 1 && bundle.discord_reward_amount > 0 && (bundle.discord_username_mandatory || item.ap === 1)) {
          individualAmount += bundle.discord_reward_amount;
        }
        results.push({ rank: results.length + 1, h: item.h, amount: individualAmount });
      }
    }
  }

  return results;
}

function resultsEqual(a: VerifyResultRow[], b: VerifyResultRow[]): boolean {
  if (a.length !== b.length)
    return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (!x || !y || x.rank !== y.rank || x.h !== y.h || x.amount !== y.amount)
      return false;
  }
  return true;
}

function firstResultDifference(a: VerifyResultRow[], b: VerifyResultRow[]): string | null {
  if (a.length !== b.length)
    return `row count differs: recomputed ${a.length} vs bundle ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (!x || !y || x.rank !== y.rank || x.h !== y.h || x.amount !== y.amount)
      return `row ${i + 1}: recomputed ${x ? `${x.rank}:${x.h.substring(0, 12)}…:${x.amount}` : 'missing'} vs bundle ${y ? `${y.rank}:${y.h.substring(0, 12)}…:${y.amount}` : 'missing'}`;
  }
  return null;
}

type BlockInfo = {
  number: number;
  hash: string | null;
  proof: string;
};

// JSON-RPC over plain HTTP(S) to a user-provided full URL, so the user decides whether to encrypt.
async function fetchBlockByNumber(rpcUrl: string, blockNumber: number, timeoutMs = 15000): Promise<BlockInfo> {
  let target: URL;
  try {
    target = new URL(rpcUrl);
  } catch {
    throw new Error('RPC URL must be a full URL (http://... or https://...)');
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:')
    throw new Error('RPC URL must use http:// or https://');
  if (typeof location !== 'undefined' && location.protocol === 'https:' && target.protocol === 'http:')
    throw new Error('Cannot call an http:// RPC from an https:// page (blocked as mixed content)');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getblockbynumber', params: [blockNumber] }),
      signal: controller.signal
    });
    if (!response.ok)
      throw new Error(`RPC HTTP ${response.status}`);
    const data = await response.json();
    if (data.error)
      throw new Error(typeof data.error?.message === 'string' ? data.error.message : 'RPC error');
    const result = data.result;
    if (!result || !result.pow || typeof result.pow.proof !== 'string')
      throw new Error('Block response does not contain pow.proof');
    return {
      number: Number(result.number),
      hash: typeof result.hash === 'string' ? result.hash : null,
      proof: result.pow.proof
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      throw new Error('RPC request timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// === end client-side verification ===

function parseEmbeddedURL(input: string) {
  const urlRegex = /\b(https?|ftps?):\/\/[^\s"'<>\[\]_*~]+/i;
  const match = input.match(urlRegex);
  if (!match) {
    return null;
  }

  let extractedUrl = match[0];
  const trailingChars = /[.,;:!?)\]]|[*_~]+$/;
  while (trailingChars.test(extractedUrl)) {
    const lastChar = extractedUrl.slice(-1);
    if (/[.,;:!?)\]]$/.test(lastChar) || /[*_~]$/.test(lastChar)) {
      extractedUrl = extractedUrl.slice(0, -1);
    } else {
      break; 
    }
  }

  if (!extractedUrl) {
    return null;
  }

  let hostname = '[LINK]';
  try {
    const url = new URL(extractedUrl);
    hostname = `[${url.hostname}]`;
  } catch { }

  const modifiedText = input.replace(match[0], hostname);
  return {
    url: extractedUrl,
    modifiedText: modifiedText
  };
}

interface GiveawayData {
  exists: boolean;
  id: string;
  description?: string;
  rules?: any;
  target_block?: number;
  winning_token?: string;
  parsed_winning_token?: string;
  winner_ranges?: string;
  discord_reward_amount?: number;
  discord_username_mandatory?: number;
  x_username_mandatory?: number;
  finished_at?: string;
  participants_count: number;
  winners: any[];
  participants: any[];
  mirror_participants: number;
  hash_id?: string;
  manifest_hash?: string | null;
}

interface GiveawayRef {
  id: string;
  active: boolean;
  created_at: string;
  participants: number;
}

interface WinnerDistribution {
  count: number;
  amount: number;
}

const parseWinnerDistribution = (ranges: any): WinnerDistribution[] => {
  if (typeof ranges === 'string') {
    try {
      return JSON.parse(ranges) as WinnerDistribution[];
    } catch {
      return [];
    }
  }
  return Array.isArray(ranges) ? ranges as WinnerDistribution[] : [];
};

// Reusable Card Component
interface CardProps {
  title?: string;
  children: React.ReactNode;
  className?: string;
  style?: CSSProperties
}

const Card: React.FC<CardProps> = ({ title, children, className = '', style }) => (
  <div className={`card ${className}`} style={style}>
    {title && <h3 className="card-title">{title}</h3>}
    <div className="card-content">{children}</div>
  </div>
);

// Giveaway Description Card
interface GiveawayDescriptionCardProps {
  description?: string | undefined;
  targetBlock?: number | undefined;
  isFinished: boolean;
  winningToken?: string | undefined;
  parsedWinningToken?: string | undefined;
  participants_count?: number,
  mirror_participants?: number,
  rules?: any;
  parsedDistribution: WinnerDistribution[];
  discordRewardAmount?: string | undefined
}

const GiveawayDescriptionCard: React.FC<GiveawayDescriptionCardProps> = ({ description, targetBlock, isFinished, winningToken, parsedWinningToken, rules, participants_count, mirror_participants, parsedDistribution, discordRewardAmount }) => {
  if (!description && !targetBlock && !winningToken) return null;
  
  const rulesArray = Array.isArray(rules) ? rules : typeof rules === 'string' ? JSON.parse(rules) : [];
  const hasRules = Array.isArray(rulesArray) && rulesArray.length > 0;
  
  return (
    <Card title="Rules">
      {description && <p className="description">{description}</p>}
      {(targetBlock || hasRules) && (
        <div className="info-row" style={{ borderBottom: 'none', paddingTop: '16px', paddingBottom: 0 }}>
          <div className="rules-badges">
            {
              targetBlock &&
              <a className="rule-badge" href={`https://tangent.cash/block/${targetBlock}`} target="_blank" style={{ color: isFinished ? '#f4212e' : '#00ba7c' }}>{isFinished ? 'Finished at Block' : 'Ends at Block'} { targetBlock }</a>
            }
            {hasRules && rulesArray.map((rule: string, index: number) => {
              const data = parseEmbeddedURL(rule);
              return data ? (
                <a key={index} className="rule-badge" href={data.url} target="_blank" style={{ color: '#7CACF8' }}>{data.modifiedText}</a>
              ) : (
                <span key={index} className="rule-badge">{rule}</span>
              )
            })}
          </div>
        </div>
      )}
      {discordRewardAmount && (
        <div className="discord-reward-info">
          <span className="discord-reward-label">💬 Join Discord Reward</span>
          <span className="discord-reward-amount">
            Plus {discordRewardAmount} {parsedWinningToken || 'token'} for joining our Discord!
          </span>
        </div>
      )}
      {
        parsedDistribution.length > 0 &&
        <div style={{ paddingTop: '16px' }}>
          <table className="distribution-table">
            <thead>
              <tr>
                <th>Place</th>
                <th>Prize</th>
              </tr>
            </thead>
            <tbody>
              {parsedDistribution.map((dist, index) => (
                <tr key={index}>
                  <td>{(index > 0 && parsedDistribution[index - 1]?.count != dist.count - 1 ? ((parsedDistribution[index - 1]?.count || 0) + 1) + '-' : (dist.count > 1 ? '1-' : '')) + dist.count}{ dist.count == 1 ? 'st' : (dist.count == 2 ? 'nd' : (dist.count == 3 ? 'rd' : 'th')) }</td>
                  <td>{dist.amount} {parsedWinningToken || 'token'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      }
      {!isFinished && participants_count ?
        <p className="join-warning" style={{ color: 'lightgray', paddingBottom: '4px', fontSize: '0.9rem', borderTop: '1px solid #2f3336' }}>{participants_count} { participants_count > 1 ? 'requests' : 'request'} to participate</p> : undefined
      }
      {!isFinished && mirror_participants ?
        <p className="join-warning" style={{ color: 'lightgray', paddingBottom: '4px', fontSize: '0.8rem' }}>{mirror_participants} referral { mirror_participants > 1 ? 'requests' : 'request'}</p> : undefined
      }
    </Card>
  );
};

// Winner Check Card - for finished giveaways
interface WinnerCheckCardProps {
  giveawayId: string;
  winners: any[];
  participants: any[];
  parsedWinningToken?: string | undefined;
  isFinished: boolean
  overriderAddress: string
}

const WinnerCheckCard: React.FC<WinnerCheckCardProps> = ({ giveawayId, winners, participants, parsedWinningToken, isFinished, overriderAddress }) => {
  const [walletAddress, setWalletAddress] = useState('');
  const [walletHash, setWalletHash] = useState<string | null>(null);
  const [rank, setRank] = useState<number | null>(null);
  const [isWinner, setIsWinner] = useState<boolean | null>(null);
  const [approval, setApproval] = useState<{ approved: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [prizeAmount, setPrizeAmount] = useState<number | null>(null);
  const approvalStatus = useMemo((): 'unknown' | 'pending' | 'partially-approved' | 'approved' => {
    if (!approval)
      return 'unknown';

    if (approval.approved)
      return approval.approved == 1 ? 'approved' : 'partially-approved';

    return 'pending';
  }, [approval]);

  const checkWinner = async (customAddress?: string) => {
    const address = customAddress || walletAddress;
    if (!address.trim()) {
      alert('Please enter a wallet address');
      return;
    }

    setLoading(true);
    try {
      try {
        const response = await fetch(`/giveaway/${giveawayId}/status/${address}`);
        const result = await response.json();
        setApproval(result && typeof result.approved == 'number' ? {
          approved: result.approved
        } : null);
      } catch { }
      
      const hash = await hashAddress(giveawayId, address);
      setWalletHash(hash);

      // Check if this hash matches any winner
      const match = winners.find((w: any) => {
        const winnerHash = w.walletHash || w.wallet_hash;
        return winnerHash === hash;
      });
      const nonMatch = participants.find((w: any) => {
        const winnerHash = w.walletHash || w.wallet_hash;
        return winnerHash === hash;
      });
      const rank = (match || nonMatch)?.rank;
      setRank(typeof rank == 'number' ? rank : null);
      if (isFinished && match) {
        setIsWinner(true);
        setPrizeAmount(match.amount);
      } else {
        setIsWinner(false);
        setPrizeAmount(null);
      }
    } catch (error) {
      console.error('Error checking winner:', error);
      alert('Error checking winner status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (overriderAddress) {
      checkWinner(overriderAddress);
    }
  }, [overriderAddress]);

  return (
    <Card title="Check" style={{ marginTop: isFinished ? undefined : '24px' }}>
      <div className="winner-check-form">
        <div className="form-group">
          <input
            type="text"
            value={walletAddress}
            onChange={(e) => setWalletAddress(e.target.value)}
            placeholder={ overriderAddress || 'Tangent address (tc1...)' }
            disabled={loading}
          />
        </div>
        <button
          type="button"
          className="check-btn"
          onClick={() => checkWinner()}
          disabled={loading || !walletAddress}
        >
          {loading ? 'Checking...' : 'Check if ' + (isFinished ? 'I Won' : 'I\'m In')}
        </button>
      </div>
      
      {walletHash && (
        <div className={`winner-result ${isWinner === true ? 'winner-result-win' : isWinner === false ? 'winner-result-lose' : ''}`}>
          {isWinner === true ? (
            <div className="winner-congrats">
              <span className="winner-icon">🎉</span>
              <p className="winner-text">Congratulations! You are a winner!</p>
              <p className="prize-amount">Prize: {prizeAmount} {parsedWinningToken || 'token'}</p>
            </div>
          ) : isWinner === false ? (
            <div className="winner-not">
              <span className="result-label">Wallet Hash:</span>
              <span className="wallet-hash-display">{walletHash.substring(0, 16)}<span style={{ color: 'greenyellow' }}>{walletHash.substring(16, 8)}</span></span>
              { !isFinished && <span className="wallet-hash-display" style={{ color: approvalStatus == 'approved' ? 'greenyellow' : (approvalStatus == 'partially-approved' || approvalStatus == 'pending' ? 'yellow' : 'gray'), marginLeft: '8px' }}>{ approvalStatus == 'approved' ? 'You\'re IN!' : (approvalStatus == 'partially-approved' ? 'You\'re partially IN!' : (approvalStatus == 'pending' ? 'Pending Approval' : 'Not Registered')) }</span> }
              { isFinished && <p className="not-winner-text">Sorry, you are not a winner this time.{ rank != null ? ` Your place is ${rank}` : '' }</p> }
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
};

// Winners Card
interface WinnersCardProps {
  winners: any[];
  parsedWinningToken?: string | undefined;
  participants_count: number
}

const WinnersCard: React.FC<WinnersCardProps> = ({ winners, parsedWinningToken, participants_count }) => {
  if (winners.length === 0) return null;
  
  return (
    <Card title="🔥 Winners">
      <table className="winners-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Wallet Hash</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {winners.map((w) => (
            <tr key={w.walletHash}>
              <td>{w.rank}</td>
              <td className="wallet-hash">{(w.walletHash || w.wallet_hash).substring(0, 16)}</td>
              <td>{w.amount} {parsedWinningToken || 'token'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {participants_count ?
        <p className="join-warning" style={{ color: 'lightgray', paddingBottom: '4px', fontSize: '1rem', borderTop: '1px solid #2f3336' }}>{participants_count} { participants_count > 1 ? 'participants' : 'participant'} total</p> : undefined
      }
    </Card>
  );
};

// Verify Results Card - independent verification of finished giveaway results
type VerifyStepStatus = 'pending' | 'running' | 'pass' | 'fail' | 'info';

interface VerifyStep {
  id: string;
  label: string;
  status: VerifyStepStatus;
  detail: string;
}

const verifyStatusIcon: Record<VerifyStepStatus, string> = {
  pending: '○',
  running: '…',
  pass: '✓',
  fail: '✗',
  info: 'ⓘ'
};

interface VerifyResultsCardProps {
  giveawayId: string;
  manifestHash: string | null;
  winners: any[];
  participants: any[];
  displayHashId: string;
  parsedWinningToken?: string | undefined;
}

const VerifyResultsCard: React.FC<VerifyResultsCardProps> = ({ giveawayId, manifestHash, winners, participants, displayHashId, parsedWinningToken }) => {
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<VerifyStep[] | null>(null);
  const [endpoint, setEndpoint] = useState(DEFAULT_RPC_URL);
  const [entryAddress, setEntryAddress] = useState(localStorage.getItem('address:' + giveawayId) || '');
  const [manualProof, setManualProof] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [walletHash, setWalletHash] = useState<string | null>(null);
  const [rank, setRank] = useState<number | null>(null);
  const [isWinner, setIsWinner] = useState<boolean | null>(null);
  const [prizeAmount, setPrizeAmount] = useState<number | null>(null);
  const bundleRef = useRef<VerifyBundle | null>(null);
  const usedRpcRef = useRef<{ url: string; source: 'rpc' | 'manual'; block_number: number; block_hash: string | null; pow_proof: string } | null>(null);

  const updateStep = (id: string, status: VerifyStepStatus, detail?: string) => {
    setSteps((prev) => prev ? prev.map((s) => s.id !== id ? s : { id: s.id, label: s.label, status, detail: detail === undefined ? s.detail : detail }) : prev);
  };

  const verifyProofAndRecompute = async (bundle: VerifyBundle, proof: string): Promise<boolean> => {
    updateStep('proof', 'running');
    const proofHash = await sha256Hex(proof);
    if (proofHash !== bundle.proof_hash) {
      updateStep('proof', 'fail', `sha256(proof) = ${proofHash.substring(0, 24)}… does not match frozen ${bundle.proof_hash.substring(0, 24)}…`);
      updateStep('recompute', 'pending', 'Skipped: proof mismatch');
      return false;
    }
    updateStep('proof', 'pass', proofHash.substring(0, 24) + '…');

    updateStep('recompute', 'running');
    const recomputed = recomputeResults(bundle, proof);
    if (resultsEqual(recomputed, bundle.results)) {
      const winnersCount = recomputed.filter((r) => r.amount > 0).length;
      updateStep('recompute', 'pass', `All ${recomputed.length} ranked entries reproduced from the block proof (${winnersCount} winners)`);
      return true;
    }
    updateStep('recompute', 'fail', firstResultDifference(recomputed, bundle.results) || 'Recomputed results differ');
    return false;
  };

  const runVerification = async () => {
    setBusy(true);
    setShowManual(false);
    bundleRef.current = null;
    usedRpcRef.current = null;
    setWalletHash(null);
    setRank(null);
    setIsWinner(null);
    setPrizeAmount(null);
    const trimmedEntry = entryAddress.trim();
    setSteps([
      { id: 'bundle', label: 'Download hash list from server', status: 'running', detail: '' },
      { id: 'digest', label: 'Hash list digest matches published manifest hash', status: 'pending', detail: '' },
      { id: 'display', label: 'Hash list matches the displayed winners', status: 'pending', detail: '' },
      ...(trimmedEntry ? [{ id: 'entry', label: 'Check if I Won', status: 'pending' as VerifyStepStatus, detail: '' }] : []),
      { id: 'block', label: `Fetch target block from ${endpoint}`, status: 'pending', detail: '' },
      { id: 'proof', label: 'Block proof matches the frozen proof hash', status: 'pending', detail: '' },
      { id: 'recompute', label: 'Recompute winners from the block proof', status: 'pending', detail: '' }
    ]);

    let bundle: VerifyBundle;
    try {
      const res = await fetch(`/giveaway/${giveawayId}/verify`);
      if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
      bundle = await res.json();
      bundleRef.current = bundle;
      updateStep('bundle', 'pass', `${bundle.participants.length} participant hashes, ${bundle.results.filter((r: VerifyResultRow) => r.amount > 0).length} winners (target block ${bundle.target_block})`);
    } catch (error) {
      updateStep('bundle', 'fail', error instanceof Error ? error.message : 'Failed to download the results bundle');
      setBusy(false);
      return;
    }

    let digestOk = false;
    try {
      const digest = await computeManifestHash(bundle);
      digestOk = digest === bundle.manifest_hash && (!manifestHash || digest === manifestHash);
      if (digestOk)
        updateStep('digest', 'pass', digest.substring(0, 32) + '…');
      else
        updateStep('digest', 'fail', `computed ${digest.substring(0, 24)}… vs served ${(bundle.manifest_hash || 'none').substring(0, 24)}${manifestHash && digest !== manifestHash ? ' vs site ' + manifestHash.substring(0, 24) + '…' : '…'}`);
    } catch (error) {
      updateStep('digest', 'fail', error instanceof Error ? error.message : 'Digest computation failed');
    }

    const sameHashId = bundle.hash_id === displayHashId;
    const displayed = [...winners, ...participants].sort((a, b) => (a.rank || 0) - (b.rank || 0));
    let displayOk = displayed.length === bundle.results.length;
    let displayMismatch = displayOk ? null : `displayed ${displayed.length} ranked entries vs bundle ${bundle.results.length}`;
    if (displayOk) {
      for (let i = 0; i < displayed.length; i++) {
        const d = displayed[i], r = bundle.results[i];
        if (!r || d.rank !== r.rank || d.amount !== r.amount || (sameHashId && d.walletHash !== r.h)) {
          displayOk = false;
          displayMismatch = `mismatch at rank ${i + 1}`;
          break;
        }
      }
    }
    if (displayOk)
      updateStep('display', 'pass', sameHashId ? 'All displayed ranks, wallet hashes and amounts match the bundle' : `All displayed ranks and amounts match${sameHashId ? '' : ` (wallet hashes are derived from the canonical id ${bundle.hash_id})`}`);
    else
      updateStep('display', 'fail', displayMismatch || 'Displayed winners differ from the bundle');

    if (trimmedEntry) {
      try {
        const hash = await hashAddress(bundle.hash_id, trimmedEntry);
        const leaf = bundle.participants.find((p) => p.h === hash);
        const entryResult = leaf ? bundle.results.find((r) => r.h === hash) : undefined;
        if (!digestOk) {
          updateStep('entry', 'fail', 'Result withheld: the hash list digest does not match, so the list cannot be trusted');
        } else {
          setWalletHash(hash);
          setIsWinner(!!entryResult && entryResult.amount > 0);
          setPrizeAmount(entryResult && entryResult.amount > 0 ? entryResult.amount : null);
          setRank(entryResult ? entryResult.rank : null);
          if (leaf)
            updateStep('entry', 'pass', `Your hash ${hash.substring(0, 16)}… is in the list${entryResult ? `, place ${entryResult.rank}${entryResult.amount > 0 ? ' — WINNER: ' + entryResult.amount : ''}` : ' (not ranked)'}`);
          else
            updateStep('entry', 'fail', `Your hash ${hash.substring(0, 16)}… was not found in the participant list`);
        }
      } catch (error) {
        updateStep('entry', 'fail', error instanceof Error ? error.message : 'Participation check failed');
      }
    }

    let block = null;
    try {
      block = await fetchBlockByNumber(endpoint, bundle.target_block);
      if (block.number !== bundle.target_block) {
        updateStep('block', 'fail', `RPC returned block ${block.number} instead of ${bundle.target_block}`);
        setBusy(false);
        return;
      }
      updateStep('block', 'pass', `Block ${block.number}${block.hash ? ' · ' + block.hash.substring(0, 24) + '…' : ''} — verify it independently at tangent.cash`);
    } catch (error) {
      updateStep('block', 'fail', error instanceof Error ? error.message : 'Failed to fetch the block');
      setShowManual(true);
      setBusy(false);
      return;
    }

    usedRpcRef.current = { url: endpoint, source: 'rpc', block_number: block.number, block_hash: block.hash, pow_proof: block.proof };
    await verifyProofAndRecompute(bundle, block.proof);

    setBusy(false);
  };

  const submitManualProof = async () => {
    const bundle = bundleRef.current;
    const proof = manualProof.trim();
    if (!bundle) return;
    if (!/^0x[0-9a-fA-F]+$/.test(proof)) {
      alert('Paste the pow.proof value (a 0x-prefixed hex string) from the block');
      return;
    }
    updateStep('block', 'info', 'Using manually provided block proof');
    usedRpcRef.current = { url: endpoint, source: 'manual', block_number: bundle.target_block, block_hash: null, pow_proof: proof };
    await verifyProofAndRecompute(bundle, proof);
  };

  const downloadReport = () => {
    const bundle = bundleRef.current;
    if (!bundle || !steps)
      return;
    const report = {
      type: 'giveaway-verification',
      giveaway: bundle.hash_id,
      page: giveawayId,
      verified_at: new Date().toISOString(),
      overall: steps.some((s) => s.status === 'fail') ? 'FAIL' : steps.some((s) => s.status === 'pending' || s.status === 'running') ? 'INCOMPLETE' : 'PASS',
      manifest_hash: bundle.manifest_hash,
      target_block: bundle.target_block,
      proof_hash: bundle.proof_hash,
      rpc: usedRpcRef.current,
      checks: steps,
      entry: walletHash ? { wallet_hash: walletHash, is_winner: isWinner, rank, amount: prizeAmount } : null,
      bundle
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `verification-${bundle.hash_id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card title="🔍 Verify" style={{ marginTop: '24px' }}>
      <p className="verify-note">
        Fetches the complete participant hash list, checks its digest against the published manifest hash,
        fetches the target block directly from the chain and recomputes every winner locally.
        Enter your address to also check if you won.
      </p>
      <div className="verify-form">
        <input
          type="text"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder={`RPC URL (${DEFAULT_RPC_URL})`}
          disabled={busy}
        />
        <button type="button" className="check-btn" onClick={runVerification} disabled={busy || !manifestHash}>
          {busy ? 'Verifying...' : 'Verify Results'}
        </button>
        <button type="button" className="verify-json-btn" onClick={downloadReport} disabled={!steps} title="Download verification result as JSON">JSON</button>
      </div>
      <div className="verify-form" style={{ marginTop: '8px' }}>
        <input
          type="text"
          value={entryAddress}
          onChange={(e) => setEntryAddress(e.target.value)}
          placeholder="Your Tangent address (tc1...) - to check if you won"
          disabled={busy}
        />
      </div>

      {steps && (
        <div className="verify-steps">
          {steps.map((step) => (
            <div key={step.id} className={`verify-step verify-step-${step.status}`}>
              <span className="verify-step-status">{verifyStatusIcon[step.status]}</span>
              <div className="verify-step-body">
                <div>{step.label}</div>
                {step.detail && <div className="verify-step-detail">{step.detail}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {showManual && (
        <div className="verify-manual">
          <p>
            Couldn&apos;t reach the RPC from the browser. Fetch block {bundleRef.current?.target_block} yourself — POST
            {' {&quot;jsonrpc&quot;:&quot;2.0&quot;,&quot;method&quot;:&quot;getblockbynumber&quot;,&quot;params&quot;:[BLOCK]} '}
            to {endpoint} — then paste its pow.proof here:
          </p>
          <textarea rows={3} value={manualProof} onChange={(e) => setManualProof(e.target.value)} placeholder="0x…" />
          <button type="button" className="check-btn" onClick={submitManualProof}>Verify With Pasted Proof</button>
        </div>
      )}

      {walletHash && (
        <div className={`winner-result ${isWinner === true ? 'winner-result-win' : isWinner === false ? 'winner-result-lose' : ''}`}>
          {isWinner === true ? (
            <div className="winner-congrats">
              <span className="winner-icon">🎉</span>
              <p className="winner-text">Congratulations! You are a winner!</p>
              <p className="prize-amount">Prize: {prizeAmount} {parsedWinningToken || 'token'}</p>
            </div>
          ) : isWinner === false ? (
            <div className="winner-not">
              <span className="result-label">Wallet Hash:</span>
              <span className="wallet-hash-display">{walletHash.substring(0, 16)}<span style={{ color: 'greenyellow' }}>{walletHash.substring(16, 8)}</span></span>
              <p className="not-winner-text">Sorry, you are not a winner this time.{rank != null ? ` Your place is ${rank}` : ''}</p>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
};

// Join Form Card
interface JoinFormCardProps {
  renderForm: () => React.ReactNode;
}

const JoinFormCard: React.FC<JoinFormCardProps> = ({ renderForm }) => {
  return (
    <Card title="Participate">
      {renderForm()}
    </Card>
  );
};

function GiveawayPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<GiveawayData | null>(null);
  const [list, setList] = useState<GiveawayRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [tanAddress, setTanAddress] = useState('');
  const [xUsername, setXUsername] = useState('');
  const [discordUsername, setDiscordUsername] = useState('');

  useEffect(() => {
    if (id) {    
      fetch(`/giveaway/${id}`)
        .then(res => res.json())
        .then(setData)
        .catch(() => setError('Failed to fetch giveaway'))
        .finally(() => setLoading(false));
    } else {
      fetch(`/giveaways`)
        .then(res => res.json())
        .then(setList)
        .catch(() => setError('Failed to fetch giveaways'))
        .finally(() => setLoading(false));
    }
  }, [id]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tanAddress) return;

    fetch(`/giveaway/${id}/participant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tan_address: tanAddress, x_username: xUsername, discord_username: discordUsername })
    })
    .then(res => {
      if (!res.ok) {
        return res.json().then(err => { throw new Error(err.error || 'Failed to join giveaway'); });
      }
      return res.json();
    })
    .then(() => {
      localStorage.setItem('address:' + id, tanAddress);
      alert('Successfully joined giveaway!');
      setTanAddress('');
      setXUsername('');
      setDiscordUsername('');
      fetchGiveaway();
    })
    .catch(err => {
      console.error('Failed to join giveaway:', err);
      alert(err.message || 'Failed to join giveaway');
    });
  };

  const fetchGiveaway = () => {
    fetch(`/giveaway/${id}`)
      .then(res => res.json())
      .then(setData);
  };

  const renderForm = () => {
    if (!data) return null;
    
    const isXMandatory = data.x_username_mandatory === 1;
    const isDiscordMandatory = data.discord_username_mandatory === 1;
    const hasDiscordReward = data.discord_reward_amount && data.discord_reward_amount > 0;
    
    return (
      <form onSubmit={handleSubmit} className="join-form">
        <div className="form-group">
          <label>
            Create Tangent address at <a href="https://tangent.cash" target="_blank" rel="noopener noreferrer">tangent.cash</a>
            <span className="required-indicator">*</span>
          </label>
          <input
            type="text"
            value={tanAddress}
            onChange={(e) => setTanAddress(e.target.value)}
            placeholder="Tangent address (tc1...)"
            required
          />
        </div>
        {
          isXMandatory &&
          <div className="form-group">
            <label>
              Follow us in X at <a href="https://x.com/tangentcash" target="_blank" rel="noopener noreferrer">@tangentcash</a>
              <span className="required-indicator">*</span>
            </label>
            <input
              type="text"
              value={xUsername}
              onChange={(e) => setXUsername(e.target.value)}
              placeholder="X (Twitter) @username"
            />
          </div>
        }
        {
          (hasDiscordReward || isDiscordMandatory) &&
          <div className="form-group">
            <label>
              Join our Discord at <a href="https://discord.gg/tangentcash" target="_blank" rel="noopener noreferrer">discord.gg/tangentcash</a>
              {isDiscordMandatory && <span className="required-indicator">*</span>}
            </label>
            <input
              type="text"
              value={discordUsername}
              onChange={(e) => setDiscordUsername(e.target.value)}
              placeholder={'Discord ' + (isDiscordMandatory ? 'username' : 'username (optional)')}
              required={isDiscordMandatory}
            />
          </div>
        }
        <button type="submit" className="join-btn">Join Giveaway</button>
        <p className="join-warning">
          ⚠️ Warning: Once you join the giveaway, you will not be able to change your registration.
        </p>
      </form>
    );
  };

  const renderContent = () => {
    if (loading) return <div className="loading">Loading...</div>;
    if (error) return <div className="error">{error}</div>;

    if (!id) {
      return (    
        <Card title="🔥 Giveaways">
          <table className="winners-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Entries</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {list.map((w) => (
                <tr key={w.id}>
                  <td><a href={`/${w.id}`}>{ w.id }</a></td>
                  <td><p className="rule-badge" style={{ color: w.active ? '#00ba7c' : '#f4212e', padding: '4px 8px' }}>{ w.active ? 'ACTIVE' : 'FINISHED' }</p></td>
                  <td>{ w.participants } { w.participants != 1 ? 'entries' : 'entry' }</td>
                  <td>{ new Date(w.created_at).toLocaleDateString() }</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )
    }

    if (!data || !data.exists) return <div className="no-giveaway">Giveaway not found.</div>;

    const isFinished = !!data.finished_at;
    const hasDiscordReward = data.discord_reward_amount && data.discord_reward_amount > 0;
    const parsedDistribution = parseWinnerDistribution(data.winner_ranges);
    const overriderAddress = localStorage.getItem('address:' + id);

    return (
      <div className="giveaway-container">
        <GiveawayDescriptionCard
          description={data.description}
          targetBlock={data.target_block}
          isFinished={isFinished}
          winningToken={data.winning_token}
          parsedWinningToken={data.parsed_winning_token}
          participants_count={data.participants_count}
          mirror_participants={data.mirror_participants}
          rules={data.rules}
          parsedDistribution={parsedDistribution}
          discordRewardAmount={hasDiscordReward ? data.discord_reward_amount?.toString() : undefined}
        />
        {
          isFinished &&
          <WinnersCard
            winners={data.winners}
            parsedWinningToken={data.parsed_winning_token}
            participants_count={data.participants_count}
          />
        }
        {
          isFinished && data.manifest_hash &&
          <VerifyResultsCard
            giveawayId={data.id}
            manifestHash={data.manifest_hash}
            winners={data.winners}
            participants={data.participants}
            displayHashId={data.hash_id || data.id}
            parsedWinningToken={data.parsed_winning_token}
          />
        }
        {
          !isFinished && !overriderAddress &&
          <JoinFormCard renderForm={renderForm} />
        }
        
        {
          (!isFinished || !data.manifest_hash) &&
          <WinnerCheckCard
            giveawayId={data.id}
            winners={data.winners}
            participants={data.participants}
            parsedWinningToken={data.parsed_winning_token}
            isFinished={isFinished}
            overriderAddress={overriderAddress || ''}
          />
        }
      </div>
    );
  };

  return (
    <div className="container">
      {
        id &&
        <header className="header">
          <h1>🎁 {id}</h1>
        </header>
      }
      <main>
        {renderContent()}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', padding: '8px', marginTop: '24px', fontSize: '0.9rem' }}>
          <a href="/terms-of-use">Terms of use</a>
          <a href="/privacy-policy">Privacy policy</a>
        </div>
      </main>
    </div>
  );
}

export default GiveawayPage;
