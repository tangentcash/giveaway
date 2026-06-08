import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';

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

interface GiveawayData {
  exists: boolean;
  id: string;
  description?: string;
  rules?: string | string[];
  target_block?: number;
  winning_token?: string;
  parsed_winning_token?: string;
  winner_ranges?: string | { count: number; amount: number }[];
  discord_reward_amount?: number;
  discord_username_mandatory?: number;
  finished_at?: string;
  participants?: any[];
  winners: any[];
}

interface RuleItem {
  id: number;
  text: string;
}

interface RangeItem {
  id: number;
  count: string;
  amount: string;
}

function ManagePage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<GiveawayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState('');
  const [showAuth, setShowAuth] = useState(false);
  
  const [description, setDescription] = useState('');
  const [rules, setRules] = useState<RuleItem[]>([]);
  const [newRule, setNewRule] = useState('');
  const [targetBlock, setTargetBlock] = useState('');
  const [winningToken, setWinningToken] = useState('');
  const [winnerRanges, setWinnerRanges] = useState<RangeItem[]>([]);
  const [newRange, setNewRange] = useState({ count: '', amount: '' });
  const [rangeIdCounter, setRangeIdCounter] = useState(0);
  const [discordRewardAmount, setDiscordRewardAmount] = useState('');
  const [discordMandatory, setDiscordMandatory] = useState(false);
  const approvedParticipants = useMemo((): number => data && data.participants ? data.participants.reduce((c, p) => p.approved + c, 0) : 0, [data]);
  const analyticsData = useMemo((): { date: string, day: number, total: number }[] => {
    if (!data || !data.participants)
      return [];

    const joins: Record<string, number> = { };
    for (let i = 0; i < data.participants.length; i++) {
      const point = new Date(data.participants[i].created_at).toISOString().split('T')[0] || '';
      joins[point] = joins[point] ? joins[point] + 1 : 1;
    }
    
    const points: { date: string, day: number, total: number }[] = [];
    for (let day in joins)
      points.push({ date: day, day: joins[day] || 0, total: 0 });  

    points.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    for (let i = 0; i < points.length; i++) {
      const prev = i > 0 ? points[i - 1] : undefined;
      const next = points[i];
      if (next) {
        next.total = (prev ? prev.total : 0) + next.day;
      }
    }

    return points;
  }, [data]);

  useEffect(() => {
    const storedAuth = localStorage.getItem('admin_auth');
    if (storedAuth) {
      setAuthToken(storedAuth);
      fetchGiveaway();
    } else {
      setShowAuth(true);
      setLoading(false);
    }
  }, [id]);

  // Sync form fields when data loads
  useEffect(() => {
    if (data) {
      setDescription(data.description || '');
      
      // Handle rules - always treat as array of strings
      const rulesValue = parseRulesAsArray(data.rules);
      setRules(rulesValue);
      
      setTargetBlock(data.target_block?.toString() || '');
      setWinningToken(data.winning_token || '');
      
      // Handle winner_ranges - convert to RangeItem array
      let ranges: RangeItem[] = [];
      let maxId = 0;
      if (data.winner_ranges) {
        try {
          let parsed: any = data.winner_ranges;
          // Parse only if it's a string
          if (typeof data.winner_ranges === 'string') {
            parsed = JSON.parse(data.winner_ranges);
          }
          if (Array.isArray(parsed)) {
            ranges = parsed.map((r: any, index: number) => ({
              id: index,
              count: r.count?.toString() || '',
              amount: r.amount?.toString() || ''
            }));
            maxId = Math.max(...ranges.map(r => r.id));
          }
        } catch (err) {
          console.error('Failed to parse winner_ranges:', err);
        }
      }
      setWinnerRanges(ranges);
      setRangeIdCounter(maxId + 1);
      
      // Sync Discord reward settings
      setDiscordRewardAmount((data.discord_reward_amount?.toString()) || '');
      setDiscordMandatory(!!data.discord_username_mandatory);
    }
  }, [data]);

  // Helper function to parse rules as array of strings
  const parseRulesAsArray = (rules: any): RuleItem[] => {
    if (!rules) return [];
    
    // If already an array, use it directly
    if (Array.isArray(rules)) {
      return rules.map((rule: string, index: number) => ({ id: index, text: rule }));
    }
    
    // If it's a string, try to parse as JSON first, then as array of strings
    try {
      const parsed = JSON.parse(rules);
      if (Array.isArray(parsed)) {
        return parsed.map((rule: string, index: number) => ({ id: index, text: rule }));
      }
    } catch (e) {
      // If JSON parsing fails, treat as single rule string
      return [{ id: 0, text: rules }];
    }
    
    // Fallback: treat as single rule string
    return [{ id: 0, text: rules }];
  };

  const fetchGiveaway = async () => {
    try {
      const res = await fetch(`/giveaway/${id}/manage`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      });
      if (res.status === 401) {
        setShowAuth(true);
        setLoading(false);
        return;
      }

      const giveaway = await res.json();
      if (giveaway && giveaway.participants && giveaway.winners && giveaway.winners.length > 0) {
        for (let i = 0; i < giveaway.participants.length; i++) {
          try {
            const participant = giveaway.participants[i];
            const hash = await hashAddress(giveaway.id, participant.tan_address);
            const index = giveaway.winners.findIndex((x: any) => x.walletHash == hash);
            participant.winner = index >= 0 && index < giveaway.winners.length ? index + 1 : null;
          } catch { }
        }
      }
      setData(giveaway);
    } catch {
      setError('Failed to fetch giveaway');
    }
    setLoading(false);
  };

  const handleAuth = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('admin_auth', authToken);
    setShowAuth(false);
    fetchGiveaway();
  };

  const handleSave = () => {
    // Convert rules to array of strings
    const parsedRules = rules.length > 0
      ? rules.map(r => r.text)
      : null;
    
    // Convert winner ranges to array of objects
    const parsedWinnerRanges = winnerRanges.length > 0
      ? winnerRanges.map(r => ({
          count: parseInt(r.count) || 0,
          amount: parseFloat(r.amount) || 0
        }))
      : null;
    
    // If target block is empty, set to null to reset giveaway to active state
    const targetBlockValue = targetBlock ? parseInt(targetBlock) : null;
    
    // Parse Discord reward amount
    const discordRewardAmountValue = discordRewardAmount.trim() !== ''
      ? parseFloat(discordRewardAmount) || 0
      : null;
    
    fetch(`/giveaway/${id}/manage`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: description || null,
        rules: parsedRules,
        target_block: targetBlockValue,
        winning_token: winningToken || null,
        winner_ranges: parsedWinnerRanges,
        discord_reward_amount: discordRewardAmountValue,
        discord_username_mandatory: discordMandatory
      })
    })
    .then(() => {
      fetchGiveaway();
    })
    .catch(err => {
      console.error('Failed to save settings:', err);
      alert('Failed to save settings');
    });
  };

  const handleToggleApproval = async (pid: number, action: 'approve' | 'partial-approve' | 'reject') => {
    try {
      await fetch(`/giveaway/${id}/participant/${pid}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      fetchGiveaway();
    } catch (err) {
      console.error('Failed to toggle approval:', err);
    }
  };

  const handleBuildPayout = async () => {
    try {
      if (!data)
        throw false;

      const res = await fetch(`/giveaway/${id}/build-payout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' }
      });
      
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Failed to build payout');
        return;
      }
      
      const payoutData = await res.json();
      const totalAmount = data.winners.reduce((p, c) => p + c.amount, 0);
      window.open(`https://tangent.cash/interaction?type=approve&asset=${winningToken}&transaction=${payoutData.unsignedTransaction}&note=${encodeURIComponent(`Paying ${totalAmount} ${data.parsed_winning_token} to ${data.winners.length} winners of @${id}`)}`, '_blank');
    } catch (err) {
      alert('Failed to build payout');
    }
  };

  const addRule = () => {
    if (!newRule.trim()) return;
    setRules([...rules, { id: Date.now(), text: newRule.trim() }]);
    setNewRule('');
  };

  const removeRule = (id: number) => {
    setRules(rules.filter(r => r.id !== id));
  };

  const addRange = () => {
    if (!newRange.count || !newRange.amount) return;
    setWinnerRanges([...winnerRanges, { id: rangeIdCounter, count: newRange.count, amount: newRange.amount }]);
    setRangeIdCounter(prev => prev + 1);
    setNewRange({ count: '', amount: '' });
  };

  const removeRange = (id: number) => {
    setWinnerRanges(winnerRanges.filter(r => r.id !== id));
  };

  const renderSocialLinks = (p: any) => {
    const links = [];
    
    if (p.x_username) {
      const handle = p.x_username.replace('@', '');
      links.push(
        <a 
          key="x"
          href={`https://x.com/${handle}`} 
          target="_blank" 
          rel="noopener noreferrer"
          className="social-badge twitter"
          title={`X: @${handle}`}
        >
          ✖ @{handle}
        </a>
      );
    }
    
    if (p.discord_username) {
      links.push(
        <button 
          key="discord"
          className="social-badge discord"
          onClick={() => {
            navigator.clipboard.writeText(p.discord_username);
            alert('Copied to clipboard!')
          }}>
          💬 {p.discord_username}
        </button>
      );
    }
    
    if (links.length === 0) {
      return <span className="no-social">No social links</span>;
    }
    
    return <div className="social-links">{links}</div>;
  };

  const renderAuth = () => (
    <div className="auth-form">
      <h2>Authenticate</h2>
      <form onSubmit={handleAuth}>
        <input
          type="password"
          value={authToken}
          onChange={(e) => setAuthToken(e.target.value)}
          placeholder="Enter admin token"
          required
          style={{ marginRight: '12px' }}
        />
        <button type="submit">Login</button>
      </form>
    </div>
  );

  const renderContent = () => {
    if (loading) return <div className="loading">Loading...</div>;
    if (showAuth) return renderAuth();
    if (error) return <div className="error">{error}</div>;
    if (!data) return <div className="no-giveaway">Giveaway not found.</div>;

    // Ensure participants is always an array for the admin panel
    const participants = data.participants || [];
    const parsedWinningToken = data.parsed_winning_token || null;

    return (
      <div className="manage-container">
        <section className="giveaway-settings">
          <h3>Giveaway Settings</h3>
          
          <div className="form-group">
            <label>Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Enter giveaway description.."
              rows={3}
            />
          </div>

          <div className="form-group">
            <label>Rules</label>
            <div className="rule-input-row">
              <input
                type="text"
                value={newRule}
                onChange={(e) => setNewRule(e.target.value)}
                placeholder="Enter a new rule (e.g., Must be 18+)"
                onKeyDown={(e) => e.key === 'Enter' && addRule()}
              />
              <button onClick={addRule} className="add-rule-btn">Add Rule</button>
            </div>
            {rules.length > 0 && (
              <div className="rule-list">
                {rules.map((rule) => (
                  <div key={rule.id} className="rule-item">
                    <span>{rule.text}</span>
                    <button onClick={() => removeRule(rule.id)} className="remove-btn">×</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="form-group">
            <label>Target Block Number</label>
            <input
              type="number"
              value={targetBlock}
              onChange={(e) => setTargetBlock(e.target.value)}
              placeholder="Target block number"
            />
            <small>Block must exist and be reached to finish giveaway. Leave empty to reset to active state</small>
          </div>

          <div className="form-group">
            <label>Winning Token (e.g., 0x584c4d for XLM)</label>
            <input
              type="text"
              value={winningToken}
              onChange={(e) => setWinningToken(e.target.value)}
              placeholder="Asset ID"
            />
            {parsedWinningToken && (
              <small style={{ display: 'block', marginTop: '6px', color: '#71767b' }}>
                Displayed as: {parsedWinningToken}
              </small>
            )}
          </div>

          <div className="form-group">
            <label>Winner Distribution</label>
            <div className="range-input-row">
              <input
                type="number"
                placeholder="Count (e.g., 10)"
                value={newRange.count}
                onChange={(e) => setNewRange({ ...newRange, count: e.target.value })}
              />
              <input
                type="number"
                placeholder="Amount (e.g., 100)"
                value={newRange.amount}
                onChange={(e) => setNewRange({ ...newRange, amount: e.target.value })}
              />
              <button onClick={addRange} className="add-range-btn">Add Range</button>
            </div>
            {winnerRanges.length > 0 && (
              <div className="range-list">
                {winnerRanges.map((range) => (
                  <div key={range.count.toString()} className="range-item">
                    <span>Top {range.count} winners get {range.amount} {parsedWinningToken || 'tokens'}</span>
                    <button onClick={() => removeRange(range.id)} className="remove-btn">×</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="form-group">
            <label>Discord Username Reward</label>
            <div className="discord-reward-inputs">
              <input
                type="number"
                placeholder="Reward amount"
                value={discordRewardAmount}
                onChange={(e) => setDiscordRewardAmount(e.target.value)}
                min="0"
                step="any"
                style={{ width: '150px' }}
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={discordMandatory}
                  onChange={(e) => setDiscordMandatory(e.target.checked)}
                  style={{ width: 'auto' }}
                />
                Make Discord username mandatory
              </label>
            </div>
            <small style={{ display: 'block', marginTop: '8px', color: '#71767b' }}>
              Additional reward for winners who provide their Discord username. This amount will be added to their prize.
            </small>
          </div>

          <div className="actions-row">
            <button className="save-btn" onClick={handleSave}>Save Settings</button>
            {data.target_block && data.winning_token && data.winner_ranges && data.finished_at && (
              <button className="build-payout-btn" onClick={handleBuildPayout}>
                📦 Pay to Winners
              </button>
            )}
          </div>
        </section>

        <section className="participants-section">
          <h3>Participants ({approvedParticipants} approved, {participants.length} total)</h3>
          {participants.length === 0 ? (
            <p>No participants yet.</p>
          ) : (
            <table className="participants-table">
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th>Social Links</th>
                  <th>Approved</th>
                </tr>
              </thead>
              <tbody>
                {participants.map((p: any) => (
                  <tr key={p.id}>
                    <td className="wallet-cell">
                      <a href={`https://tangent.cash/account/${p.tan_address}`} target="_blank" rel="noopener noreferrer">
                        {p.winner ? `#${p.winner} 🎁 ${p.tan_address.substring(0, 10)}`  : p.tan_address.substring(0, 16)}...
                      </a>
                    </td>
                    <td>{renderSocialLinks(p)}</td>
                    <td>
                      <label className="approval-checkbox" style={{ marginRight: '4px' }}>
                        <input
                          style={{ accentColor: 'yellow' }}
                          type="checkbox"
                          checked={p.approved == 2}
                          onChange={() => handleToggleApproval(p.id, p.approved == 2 ? 'reject' : 'partial-approve')}
                        />
                        {p.approved == 2 ? '✗' : ''}
                      </label>
                      <label className="approval-checkbox">
                        <input
                          type="checkbox"
                          checked={p.approved == 1}
                          onChange={() => handleToggleApproval(p.id, p.approved == 1 ? 'reject' : 'approve')}
                        />
                        {p.approved == 1 ? '✓' : ''}
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {data.winners.length > 0 && (
          <section className="winners-section">
            <h3>Winners</h3>
            <table className="winners-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Wallet Hash</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.winners.map((w: any) => (
                  <tr key={w.walletHash || w.wallet_hash}>
                    <td>{w.rank}</td>
                    <td className="wallet-hash">{(w.walletHash || w.wallet_hash).substring(0, 16)}</td>
                    <td>{w.amount} {parsedWinningToken || 'token'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section className="winners-section">
          <h3>Participants Day/Total</h3>
          <LineChart style={{ width: '100%', aspectRatio: 1.618, maxWidth: 800, margin: 'auto' }} responsive data={analyticsData}>
            <CartesianGrid stroke="#999" strokeDasharray="5 5" />
            <XAxis dataKey="date" stroke="#999" />
            <YAxis width="auto" stroke="#999" />
            <Tooltip
              cursor={{ stroke: '#999' }}
              contentStyle={{ backgroundColor: '#000', borderColor: '#999' }}
            />
            <Line
              type="monotone"
              dataKey="day"
              stroke="#f30"
              dot={{ fill: '#f30' }}
              activeDot={{ stroke: '#f30' }}
            />
            <Line
              type="monotone"
              dataKey="total"
              stroke="#1d9bf0"
              dot={{ fill: '#1d9bf0' }}
              activeDot={{ stroke: '#1d9bf0' }}
            />
          </LineChart>
        </section>
      </div>
    );
  };

  return (
    <div className="container">
      <header className="header">
        <h1>🎁 Manage {id}</h1>
      </header>
      <main>
        {renderContent()}
      </main>
    </div>
  );
}

export default ManagePage;
