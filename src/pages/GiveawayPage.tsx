import { useState, useEffect, CSSProperties } from 'react';
import { useParams } from 'react-router-dom';

// Helper function to hash wallet address (same as backend hashAddress)
// Backend: createHash('sha256').update(id).update(address).digest('hex')
async function hashAddress(id: string, address: string): Promise<string> {
  const encoder = new TextEncoder();
  // Hash id + address together (matching backend behavior)
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(id + address));
  // Convert to hex and return first 16 characters
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

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
  finished_at?: string;
  participants_count: number;
  winners: any[];
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
  rules?: any;
}

const GiveawayDescriptionCard: React.FC<GiveawayDescriptionCardProps> = ({ description, targetBlock, isFinished, winningToken, rules, participants_count }) => {
  if (!description && !targetBlock && !winningToken) return null;
  
  const rulesArray = Array.isArray(rules) ? rules : typeof rules === 'string' ? JSON.parse(rules) : [];
  const hasRules = Array.isArray(rulesArray) && rulesArray.length > 0;
  
  return (
    <Card title="About">
      {description && <p className="description">{description}</p>}
      {targetBlock && (
        <div className="info-row">
          <span className="info-label">Target Block</span>
          <div className="info-value-with-badge">
            <a className="info-value" href={`https://tangent.cash/block/${targetBlock}`} target="_blank" style={{ color: '#7CACF8' }}>{targetBlock}</a>
            <span className={`status-badge ${isFinished ? 'status-finished' : 'status-active'}`}>
              {isFinished ? 'Block found / Finished' : 'Awaiting block / Active'}
            </span>
          </div>
        </div>
      )}
      {hasRules && (
        <div className="info-row">
          <span className="info-label">Rules</span>
          <div className="rules-badges">
            {rulesArray.map((rule: string, index: number) => {
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
      {participants_count ?
        <div className="info-row">
          <span className="info-label">Participants</span>
          <div className="rules-badges">{ participants_count }</div>
        </div> : undefined
      }
    </Card>
  );
};

// Winner Distribution Card
interface WinnerDistributionCardProps {
  parsedDistribution: WinnerDistribution[];
  parsedWinningToken?: string | undefined;
  discordRewardAmount?: string | undefined
}

const WinnerDistributionCard: React.FC<WinnerDistributionCardProps> = ({ parsedDistribution, parsedWinningToken, discordRewardAmount }) => {
  if (parsedDistribution.length === 0) return null;
  
  return (
    <Card title="Prizes">
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
              <td>{(index > 0 && parsedDistribution[index - 1]?.count != dist.count - 1 ? ((parsedDistribution[index - 1]?.count || 0) + 1) + '-' : '') + dist.count}{ dist.count == 1 ? 'st' : (dist.count == 2 ? 'nd' : (dist.count == 3 ? 'rd' : 'th')) }</td>
              <td>{dist.amount} {parsedWinningToken || 'token'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {discordRewardAmount && (
        <div className="discord-reward-info">
          <span className="discord-reward-label">💬 Join Discord Reward</span>
          <span className="discord-reward-amount">
            Plus {discordRewardAmount} {parsedWinningToken || 'token'} for joining our Discord!
          </span>
        </div>
      )}
    </Card>
  );
};

// Winner Check Card - for finished giveaways
interface WinnerCheckCardProps {
  giveawayId: string;
  winners: any[];
  parsedWinningToken?: string | undefined;
  isFinished: boolean
}

const WinnerCheckCard: React.FC<WinnerCheckCardProps> = ({ giveawayId, winners, parsedWinningToken, isFinished }) => {
  const [walletAddress, setWalletAddress] = useState('');
  const [walletHash, setWalletHash] = useState<string | null>(null);
  const [isWinner, setIsWinner] = useState<boolean | null>(null);
  const [isApproved, setIsApproved] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [prizeAmount, setPrizeAmount] = useState<number | null>(null);

  const checkWinner = async () => {
    if (!walletAddress.trim()) {
      alert('Please enter a wallet address');
      return;
    }

    setLoading(true);
    try {
      try {
        const response = await fetch(`/giveaway/${giveawayId}/status/${walletAddress}`);
        const result = await response.json();
        setIsApproved(result && typeof result.approved == 'boolean' ? result.approved : null);
      } catch { }
      
      const hash = await hashAddress(giveawayId, walletAddress);
      setWalletHash(hash);

      // Check if this hash matches any winner
      const match = winners.find((w: any) => {
        const winnerHash = w.walletHash || w.wallet_hash;
        return winnerHash === hash;
      });

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

  return (
    <Card title="Tracker" style={{ marginTop: isFinished ? undefined : '24px' }}>
      <div className="winner-check-form">
        <div className="form-group">
          <input
            type="text"
            value={walletAddress}
            onChange={(e) => setWalletAddress(e.target.value)}
            placeholder="Enter your Tangent address"
            disabled={loading}
          />
        </div>
        <button
          type="button"
          className="check-btn"
          onClick={checkWinner}
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
              { !isFinished && <span className="wallet-hash-display" style={{ color: isApproved ? 'greenyellow' : (isApproved === false ? 'yellow' : 'gray'), marginLeft: '8px' }}>{ isApproved ? 'You\'re IN!' : (isApproved === false ? 'Pending Approval' : 'Not Registered') }</span> }
              { isFinished && <p className="not-winner-text">Sorry, you are not a winner this time.</p> }
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
}

const WinnersCard: React.FC<WinnersCardProps> = ({ winners, parsedWinningToken }) => {
  if (winners.length === 0) return null;
  
  return (
    <Card title="🔥 Giveaway Winners">
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [tanAddress, setTanAddress] = useState('');
  const [xUsername, setXUsername] = useState('');
  const [discordUsername, setDiscordUsername] = useState('');

  useEffect(() => {
    if (!id) {
      setError('Giveaway ID is required');
      setLoading(false);
      return;
    }
    
    fetch(`/giveaway/${id}`)
      .then(res => res.json())
      .then(setData)
      .catch(() => setError('Failed to fetch giveaway'))
      .finally(() => setLoading(false));
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
    
    const isDiscordMandatory = data.discord_username_mandatory === 1;
    const hasDiscordReward = data.discord_reward_amount && data.discord_reward_amount > 0;
    
    return (
      <form onSubmit={handleSubmit} className="join-form">
        <div className="form-group">
          <label>
            Tangent Address
            <span className="required-indicator">*</span>
          </label>
          <input
            type="text"
            value={tanAddress}
            onChange={(e) => setTanAddress(e.target.value)}
            placeholder="Enter your Tangent address"
            required
          />
          <p className="info-link">
            You can create your address at{' '}
            <a href="https://tangent.cash" target="_blank" rel="noopener noreferrer">
              tangent.cash
            </a>
          </p>
        </div>
        <div className="form-group">
          <label>
            X (Twitter) Username
            <span className="required-indicator">*</span>
          </label>
          <input
            type="text"
            value={xUsername}
            onChange={(e) => setXUsername(e.target.value)}
            placeholder="@username"
          />
          <p className="info-link">
            You must follow us in X at{' '}
            <a href="https://x.com/tangentcash" target="_blank" rel="noopener noreferrer">
              @tangentcash
            </a>
          </p>
        </div>
        {
          (hasDiscordReward || isDiscordMandatory) &&
          <div className="form-group">
            <label>
              Discord Username
              {isDiscordMandatory && <span className="required-indicator">*</span>}
            </label>
            <input
              type="text"
              value={discordUsername}
              onChange={(e) => setDiscordUsername(e.target.value)}
              placeholder={isDiscordMandatory ? 'username' : 'username (optional)'}
              required={isDiscordMandatory}
            />
            <p className="info-link">
              You must join our Discord server{isDiscordMandatory ? '' : ' if you enter this field'}. Join at{' '}
              <a href="https://discord.gg/tangentcash" target="_blank" rel="noopener noreferrer">
                discord.gg/tangentcash
              </a>
            </p>
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
    if (!data || !data.exists) return <div className="no-giveaway">Giveaway not found.</div>;

    const isFinished = !!data.finished_at;
    const hasDiscordReward = data.discord_reward_amount && data.discord_reward_amount > 0;
    const parsedDistribution = parseWinnerDistribution(data.winner_ranges);

    return (
      <div className="giveaway-container">
        <GiveawayDescriptionCard
          description={data.description}
          targetBlock={data.target_block}
          isFinished={isFinished}
          winningToken={data.winning_token}
          parsedWinningToken={data.parsed_winning_token}
          participants_count={data.participants_count}
          rules={data.rules}
        />
        
        <WinnerDistributionCard
          parsedDistribution={parsedDistribution}
          parsedWinningToken={data.parsed_winning_token}
          discordRewardAmount={hasDiscordReward ? data.discord_reward_amount?.toString() : undefined}
        />

        {
          isFinished ? (
            <WinnersCard
              winners={data.winners}
              parsedWinningToken={data.parsed_winning_token}
            />
          ) : (
            <JoinFormCard renderForm={renderForm} />
          )
        }
        
        <WinnerCheckCard
          giveawayId={data.id}
          winners={data.winners}
          parsedWinningToken={data.parsed_winning_token}
          isFinished={isFinished}
        />
      </div>
    );
  };

  return (
    <div className="container">
      <header className="header">
        <h1>🎁 {id}</h1>
      </header>
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
