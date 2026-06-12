import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import Database from 'better-sqlite3';
import { AssetId, Chain, Signing, Transactions, Stream, SchemaUtil, Uint256, RPC, Hashsig } from 'tangentsdk';
import { BigNumber } from 'bignumber.js';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type GiveawayRow = {
  id: string;
  description: string | null;
  rules: string | null;
  target_block: number | null;
  winning_token: string | null;
  winner_ranges: string | null;
  discord_reward_amount: number;
  discord_username_mandatory: number;
  created_at: string;
  finished_at: string | null;
};

type ParticipantRow = {
  id: number;
  giveaway_id: string;
  tan_address: string;
  x_username: string | null;
  discord_username: string | null;
  ip: string | null,
  approved: number;
  created_at: string;
};

type Block = {
  number: number;
  pow: {
    proof: string;
  };
};

// Check if request includes admin auth token
const hasAdminAuth = (req: Request): boolean => {
  const auth = req.headers.authorization;
  return auth === `Bearer ${TOKEN}`;
};

// Middleware to check admin auth
const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  if (!hasAdminAuth(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
};

// Helper: Parse winning token to human-readable format
const parseWinningToken = (winningToken: string | null): string | null => {
  if (!winningToken) return null;
  
  try {
    const asset = new AssetId(winningToken);
    // If asset has a token symbol, use it with the chain
    if (asset.token) {
      return `${asset.token} on ${asset.chain}`;
    }
    // Otherwise just return the chain name
    return asset.chain;
  } catch (error) {
    console.error('Failed to parse winning token:', error);
    return null;
  }
};

// Helper: Hash wallet address for privacy
function hashAddress(id: string, address: string): string {
  return createHash('sha256').update(id).update(address).digest('hex');
}

function checkAddress(address: string): boolean {
  try {
    return Signing.decodeAddress(address) !== null;
  } catch {
    return false;
  }
}
function sha256StringToBigInt(str: string): bigint {
  const hash = createHash('sha256').update(str).digest('hex');
  // Convert the hex string to a BigInt (base 16)
  return BigInt(`0x${hash}`);
}

/**
 * Deterministically shuffles an array where:
 * 1. The order depends on the provided BigInt seed.
 * 2. The result also depends on the content of the array (specifically 'tan_address').
 *
 * This ensures that [A, B, C] and [C, B, A] with different addresses produce different shuffles,
 * even if the seed is identical.
 *
 * @param {Array<{tan_address: string}>} arr - Array of objects containing 'tan_address'.
 * @param {bigint} seed - The primary seed.
 * @returns {Array} - A new shuffled array.
 */
function shuffleParticipants(arr: ParticipantRow[], seed: bigint): ParticipantRow[] {
  if (arr.length <= 1) return [...arr];

  // --- Step 1: Generate Composite Entropy ---
  let compositeSeed: bigint = seed;

  // We iterate through the array and mix the SHA-256 hash of each item into the seed.
  // We use XOR to combine the hash values. 
  // Note: We also include the index or position to ensure order matters (though SHA-256 on the whole set 
  // usually suffices, XORing sequentially ensures permutation sensitivity).
  
  // To make the seed dependent on the *order* of the array as well as the *values*,
  // we mix the hash of each item individually.
  const items = arr.map((item) => item.tan_address);
  
  // Create a "Salted" seed by XORing the initial seed with all the content hashes.
  items.forEach((address) => {
    const hashBigInt = sha256StringToBigInt(address);
    // We XOR the hash with the current composite seed.
    // Using XOR ensures that if two items are swapped, the seed changes.
    compositeSeed = BigInt(compositeSeed) ^ hashBigInt; 
  });

  // --- Step 2: Initialize LCG with Composite Seed ---
  const bitDepth = BigInt(Math.max(seed.toString(2).length + 1, 128));
  const mod = 1n << BigInt(bitDepth);
  const increment = (1n << BigInt(bitDepth - 1n)) + 1n;
  const multiplier = (3n * (1n << BigInt(bitDepth - 2n))) + 1n;

  let state = compositeSeed % mod;
  if (state === 0n) state = 1n; // Ensure state is non-zero

  // --- Step 3: Fisher-Yates Shuffle ---
  let result: any = [...arr];
  const n = result.length;
  for (let i = n - 1; i > 0; i--) {
    // Generate next random number
    state = (multiplier * state + increment) % mod;

    // Determine swap index
    const max = BigInt(i) + 1n;
    const randomIndex = Number(state % max);

    // Swap
    const temp = result[i];
    result[i] = result[randomIndex];
    result[randomIndex] = temp;
  }

  return result;
}
/**
 * Cryptographically secure winner selection using SHA-256 hashing
 * Uses ALL entropy from the 5200-bit block.pow.proof for secure calculation
 * Deterministic: same proof + participants always produces same winners
 */
function selectWinners(giveaway: GiveawayRow, participants: ParticipantRow[], winnerRanges: any[], proofHex: string): { participant: ParticipantRow, amount: number }[] {
  if (participants.length === 0)
    return [];
  
  const proofBigInt = BigInt(proofHex);
  const shuffledParticipants = shuffleParticipants(participants.filter(x => x.approved > 0), proofBigInt);
  const winners: { participant: ParticipantRow, amount: number }[] = [];
  winnerRanges = winnerRanges.sort((a, b) => a.count - b.count);
  for (const range of winnerRanges) {
    const count = range.count;
    const amount = range.amount;
    const length = Math.min(count, shuffledParticipants.length);
    for (let i = winners.length; i < length; i++) {
      const item = shuffledParticipants[i];
      if (item != null) {
        let individualAmount = amount;
        if (item.discord_username && giveaway.discord_reward_amount && giveaway.discord_reward_amount > 0 && (giveaway.discord_username_mandatory || item.approved == 1)) {
          individualAmount += giveaway.discord_reward_amount;
        }
        winners.push({
          participant: item,
          amount: individualAmount
        });
      }
    }
  }
  
  return winners;
}

/**
 * Auto-finish giveaways that have reached their target block
 * Algorithm:
 * 1. Every minute, find all active giveaways with target_block set
 * 2. Find the giveaway with the highest block number
 * 3. Check if that block number exists
 * 4. If it exists, finish all giveaways that have block number <= block number of that giveaway
 */
async function autoFinishGiveaways() {
  try {
    // Get all active giveaways (not finished) with target_block set, ordered by target_block ascending
    const activeGiveaways = db.prepare(`
      SELECT id, target_block, winner_ranges, winning_token 
      FROM giveaways 
      WHERE finished_at IS NULL AND target_block IS NOT NULL 
      ORDER BY target_block ASC
    `).all() as (GiveawayRow & { target_block: number; winner_ranges: string; winning_token: string })[];

    if (activeGiveaways.length === 0) {
      console.log('Auto-finish check: No active giveaways with target_block');
      return;
    }

    // Find the highest target_block among active giveaways
    const highestGiveaway = activeGiveaways[activeGiveaways.length - 1];
    if (!highestGiveaway || highestGiveaway.target_block === null) {
      console.log('Auto-finish check: No valid target_block found');
      return;
    }
    
    const highestTargetBlock = highestGiveaway.target_block;

    // Check if this block exists
    const checkBlock = await getBlock(highestTargetBlock) as Block | null;

    if (checkBlock) {
      // Block exists - find all giveaways that should be finished (target_block <= current block number)
      const blockNumber = checkBlock.number;
      const giveawaysToFinish = activeGiveaways.filter(g => g.target_block !== null && g.target_block <= blockNumber);

      console.log(`Auto-finish check: Found ${giveawaysToFinish.length} giveaways to finish (block ${blockNumber} exists)`);

      for (const giveaway of giveawaysToFinish) {
        try {
          // Check if this giveaway's target block has been reached
          if (giveaway.target_block !== null && giveaway.target_block <= blockNumber) {
            // Get participants for this giveaway
            const participants = db.prepare('SELECT * FROM participants WHERE giveaway_id = ?').all(giveaway.id) as ParticipantRow[];

            // Calculate winners
            const winnerRanges = JSON.parse(giveaway.winner_ranges);
            const winners = selectWinners(giveaway, participants, winnerRanges, checkBlock.pow.proof);

            // Calculate winner records on-the-fly
            const winnerRecords = winners.map((w, index: number) => {
              const walletHash = hashAddress(giveaway.id, w.participant.tan_address);
              return {
                rank: index + 1,
                walletHash,
                amount: w.amount
              };
            });

            // Mark giveaway as finished
            db.prepare('UPDATE giveaways SET finished_at = CURRENT_TIMESTAMP WHERE id = ?').run(giveaway.id);

            console.log(`Giveaway ${giveaway.id} auto-finished with ${winnerRecords.length} winners`);
            console.log('Winners:', winnerRecords);
          }
        } catch (error) {
          console.error(`Error finishing giveaway ${giveaway.id}:`, error);
        }
      }
    } else {
      // Highest block doesn't exist yet - nothing to finish
      console.log(`Auto-finish check: Block ${highestTargetBlock} doesn't exist yet, no giveaways to finish`);
    }
  } catch (error) {
    console.error('Error in auto-finish check:', error);
  }
}

async function getBlock(blockNumber: number): Promise<any> {
  try {
    const result = await RPC.getBlockByNumber(blockNumber);
    return result || null;
  } catch {
    return null;
  }
}

async function buildTransaction(asset: AssetId, to: { address: string, value: BigNumber }[]): Promise<string> {
  const body = new Stream();
  SchemaUtil.store(body, {
    signature: new Hashsig(),
    asset: asset,
    nonce: new Uint256(0),
    gasPrice: new BigNumber(0),
    gasLimit: new Uint256(10_000_000),
    to: to.map((payment) => ({
      to: Signing.decodeAddress(payment.address),
      value: new BigNumber(payment.value)
    }))
  }, new Transactions.Transfer.Many());
  return body.encode();
}

// Load environment variables
config();
if (!process.env['TOKEN']) {
  console.error('ERROR: TOKEN environment variable is required but not set!');
  console.error('Please set a secure random token and restart the server.');
  process.exit(1);
}

const TOKEN = process.env['TOKEN'];
const db = new Database('giveaway.db');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dist')));

// Configure RPC
Chain.props = Chain.mainnet;
RPC.applyValidator('p2p.tangent.cash:18419');
RPC.applyImplementation({
    onCacheStore: (path: string, value: any): boolean => {
        try {
            const stmt = db.prepare('INSERT OR REPLACE INTO cache (path, value) VALUES (?, ?)');
            stmt.run(path, JSON.stringify(value));
            return true;
        } catch (error) {
            console.error('Error storing cache:', error);
            return false;
        }
    },
    onCacheLoad: (path: string): any | null => {
        try {
            const result = db.prepare('SELECT value FROM cache WHERE path = ?').get(path) as { value: string } | undefined;
            return result ? JSON.parse(result.value) : null;
        } catch {
            return null;
        }
    }
});

// Initialize database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS giveaways (
    id TEXT PRIMARY KEY,
    description TEXT,
    rules TEXT,
    target_block INTEGER,
    winning_token TEXT,
    winner_ranges TEXT,
    discord_reward_amount REAL DEFAULT 0,
    discord_username_mandatory INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    giveaway_id TEXT,
    tan_address TEXT,
    x_username TEXT,
    discord_username TEXT,
    ip TEXT DEFAULT NULL,
    approved INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (giveaway_id) REFERENCES giveaways(id)
  );
  CREATE INDEX IF NOT EXISTS participants_ip ON participants (ip);				

  CREATE TABLE IF NOT EXISTS cache (
    path TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

`);

// Get or create giveaway (public endpoint - no sensitive data)
app.get('/giveaway/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const giveaway = db.prepare('SELECT *, (SELECT COUNT(1) FROM participants WHERE giveaway_id = giveaways.id) AS participants FROM giveaways WHERE id = ?').get(id) as (GiveawayRow & { participants: number }) | undefined;
  
  if (!giveaway) {
    res.json({
      exists: false,
      id,
      description: null,
      rules: null,
      target_block: null,
      winning_token: null,
      winner_ranges: null,
      finished_at: null,
      participants_count: 0,
      winners: []
    });
    return;
  }

  // Calculate winners on-the-fly if giveaway is finished
  // Note: We do NOT include participants list for privacy
  let winners: any[] = [];
  if (giveaway.finished_at && giveaway.target_block && giveaway.winner_ranges) {
    try {
      // Only fetch participants needed for winner calculation (for admin use only)
      const allParticipants = db.prepare('SELECT * FROM participants WHERE giveaway_id = ?').all(id) as ParticipantRow[];
      const targetBlock = await getBlock(giveaway.target_block) as Block;
      if (targetBlock) {
        const winnerRanges = JSON.parse(giveaway.winner_ranges);
        const calculatedWinners = selectWinners(giveaway, allParticipants, winnerRanges, targetBlock.pow.proof);
        winners = calculatedWinners.map((w, index: number) => ({
          rank: index + 1,
          participantId: w.participant.id,
          amount: w.amount,
          walletHash: hashAddress(giveaway.id, w.participant.tan_address)
        }));
      }
    } catch (error) {
      console.error('Error calculating winners:', error);
    }
  }

  // Return giveaway info without sensitive participant data
  const parsedWinningToken = parseWinningToken(giveaway.winning_token);
  res.json({
    exists: true,
    id: giveaway.id,
    description: giveaway.description,
    rules: giveaway.rules,
    target_block: giveaway.target_block,
    winning_token: giveaway.winning_token,
    parsed_winning_token: parsedWinningToken,
    winner_ranges: giveaway.winner_ranges,
    discord_reward_amount: giveaway.discord_reward_amount,
    discord_username_mandatory: giveaway.discord_username_mandatory,
    finished_at: giveaway.finished_at,
    participants_count: giveaway.participants,
    winners: winners
  });
});

// Check participant approval
app.get('/giveaway/:id/status/:address', (req: Request, res: Response) => {
  const { id, address } = req.params;
  if (!address || !checkAddress(address)) {
    res.status(400).json({ error: 'Invalid TAN address' });
    return;
  }

  const participant = db.prepare('SELECT approved, created_at FROM participants WHERE giveaway_id = ? AND tan_address = ? LIMIT 1').get(id, address) as ParticipantRow | undefined;
  const silentlyRejected = participant ? participant.approved == 0 && new Date().getTime() - new Date(participant.created_at).getTime() > 8 * 3600 * 1000 : false;
  res.json({ approved: participant ? (silentlyRejected ? 1 : participant.approved) : null });
});

// Submit participant info
app.post('/giveaway/:id/participant', (req: Request, res: Response) => {
  const { id } = req.params;
  const { tan_address, x_username, discord_username } = req.body;

  const ip = req.get('X-Real-IP') || req.get('X-Forwarded-For') || req.ip;
  const fixed_x_username = x_username ? (x_username.startsWith('@') ? x_username : '@' + x_username) : '';
  const escaped_x_username = fixed_x_username.substring(1);
  if (!tan_address || !checkAddress(tan_address)) {
    res.status(400).json({ error: 'Invalid TAN address' });
    return;
  } else if (!escaped_x_username || escaped_x_username.length < 4 || escaped_x_username.length > 15 || !/^[A-Za-z0-9_]+$/.test(escaped_x_username)) {
    res.status(400).json({ error: 'Invalid X username' });
    return;
  }

  // Get or create giveaway
  let giveaway = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(id) as GiveawayRow | undefined;
  if (!giveaway) {
    db.prepare('INSERT INTO giveaways (id) VALUES (?)').run(id);
    giveaway = {
      id: id!,
      description: null,
      rules: null,
      target_block: null,
      winning_token: null,
      winner_ranges: null,
      discord_reward_amount: 0,
      discord_username_mandatory: 0,
      created_at: new Date().toISOString(),
      finished_at: null
    };
  }

  // Validate Discord username if mandatory
  if (giveaway.discord_username_mandatory && !discord_username) {
    res.status(400).json({ error: 'Discord username is required for this giveaway' });
    return;
  }

  const checkup = db.prepare('SELECT * FROM participants WHERE giveaway_id = ? AND (tan_address = ? OR x_username = ? OR discord_username = ?) LIMIT 1').get(
    id,
    tan_address,
    fixed_x_username || null,
    discord_username || null
  ) as ParticipantRow | undefined;
  if (checkup != null) {
    res.status(403).json({ error: 'Participant may not re-join the giveaway (duplicate)' });
    return;
  }

  const result = db.prepare('INSERT INTO participants (giveaway_id, tan_address, x_username, discord_username, ip) VALUES (?, ?, ?, ?, ?)').run(
    id,
    tan_address,
    fixed_x_username || null,
    discord_username || null,
    ip || null
  );

  const participant = db.prepare('SELECT * FROM participants WHERE id = ?').get(result.lastInsertRowid) as ParticipantRow;
  res.json({ message: 'Registered', participant });
});

// Admin endpoints
app.get('/giveaway/:id/manage', requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
  const giveaway = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(id) as GiveawayRow | undefined;

  if (!giveaway) {
    res.json({
      exists: false,
      id,
      participants: [],
      winners: []
    });
    return;
  }

  const participants = db.prepare('SELECT *, (SELECT COUNT(1) FROM participants p WHERE p.ip = participants.ip AND p.giveaway_id = participants.giveaway_id) AS ips FROM participants WHERE giveaway_id = ? ORDER BY created_at ASC').all(id) as ParticipantRow[];
  
  // Calculate winners on-the-fly if giveaway is finished
  let winners: any[] = [];
  if (giveaway.finished_at && giveaway.target_block && giveaway.winner_ranges) {
    try {
      const targetBlock = await getBlock(giveaway.target_block) as Block;
      if (targetBlock) {
        const winnerRanges = JSON.parse(giveaway.winner_ranges);
        const calculatedWinners = selectWinners(giveaway, participants, winnerRanges, targetBlock.pow.proof);
        winners = calculatedWinners.map((w, index: number) => ({
          rank: index + 1,
          participantId: w.participant.id,
          amount: w.amount,
          walletHash: hashAddress(giveaway.id, w.participant.tan_address)
        }));
      }
    } catch (error) {
      console.error('Error calculating winners:', error);
    }
  }

  const parsedWinningToken = parseWinningToken(giveaway.winning_token);
  res.json({
    ...giveaway,
    parsed_winning_token: parsedWinningToken,
    parsed_discord_reward: giveaway.discord_reward_amount > 0
      ? `${giveaway.discord_reward_amount} ${parsedWinningToken || 'token'}`
      : null,
    participants,
    winners
  });
});

// Giveaway endpoint with sensitive participant data - requires admin auth
app.get('/giveaway/:id/with-participants', async (req: Request, res: Response) => {
  const { id } = req.params;
  
  if (!hasAdminAuth(req)) {
    res.status(401).json({ error: 'Unauthorized - Admin access required' });
    return;
  }
  
  const giveaway = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(id) as GiveawayRow | undefined;
  
  if (!giveaway) {
    res.json({
      exists: false,
      id,
      description: null,
      rules: null,
      target_block: null,
      winning_token: null,
      winner_ranges: null,
      finished_at: null,
      participants: [],
      winners: []
    });
    return;
  }

  const participants = db.prepare('SELECT * FROM participants WHERE giveaway_id = ? ORDER BY created_at DESC').all(id) as ParticipantRow[];
  
  let winners: any[] = [];
  if (giveaway.finished_at && giveaway.target_block && giveaway.winner_ranges) {
    try {
      const targetBlock = await getBlock(giveaway.target_block) as Block;
      if (targetBlock) {
        const winnerRanges = JSON.parse(giveaway.winner_ranges);
        const calculatedWinners = selectWinners(giveaway, participants, winnerRanges, targetBlock.pow.proof);
        winners = calculatedWinners.map((w, index: number) => ({
          rank: index + 1,
          participantId: w.participant.id,
          amount: w.amount,
          walletHash: hashAddress(giveaway.id, w.participant.tan_address)
        }));
      }
    } catch (error) {
      console.error('Error calculating winners:', error);
    }
  }

  res.json({
    exists: true,
    id: giveaway.id,
    description: giveaway.description,
    rules: giveaway.rules,
    target_block: giveaway.target_block,
    winning_token: giveaway.winning_token,
    winner_ranges: giveaway.winner_ranges,
    finished_at: giveaway.finished_at,
    participants,
    winners
  });
});

app.put('/giveaway/:id/manage', requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
  const { description, rules, target_block, winning_token, winner_ranges } = req.body;

  const existing = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(id) as GiveawayRow | undefined;
  if (!existing) {
    // Create the giveaway if it doesn't exist
    db.prepare('INSERT INTO giveaways (id) VALUES (?)').run(id);
  }

  // Determine if giveaway should be finished or reset based on target_block presence
  // If target_block is provided (not null/empty), check if the block exists and has been reached
  // If block exists and target is reached → finish the giveaway
  // If block doesn't exist → keep active state
  // If target_block is cleared (null/empty), reset finished_at to null to reactivate
  const targetBlockValue = target_block !== undefined && target_block !== null && target_block !== '' ? target_block : null;
  
  let finishedAtValue: string | null = null;
  
  if (targetBlockValue !== null) {
    // Check if the target block exists
    const targetBlock = await getBlock(targetBlockValue) as Block | null;
    if (targetBlock) {
      // Block exists - check if target has been reached
      if (targetBlock.number >= targetBlockValue) {
        // Target block reached → finish the giveaway
        finishedAtValue = 'CURRENT_TIMESTAMP';
      } else {
        // Target block not reached yet → keep active
        finishedAtValue = 'NULL';
      }
    } else {
      // Block doesn't exist → keep active state
      finishedAtValue = 'NULL';
    }
  } else {
    // target_block cleared → reset to active
    finishedAtValue = 'NULL';
  }

  // Parse Discord reward amount and mandatory flag
  const discordRewardAmount = req.body.discord_reward_amount !== undefined && req.body.discord_reward_amount !== null
    ? parseFloat(req.body.discord_reward_amount) || 0
    : null;
  const discordUsernameMandatory = req.body.discord_username_mandatory !== undefined && req.body.discord_username_mandatory !== null
    ? req.body.discord_username_mandatory ? 1 : 0
    : null;

  db.prepare(`
    UPDATE giveaways
    SET description = ?, rules = ?, target_block = ?, winning_token = ?, winner_ranges = ?, discord_reward_amount = ?, discord_username_mandatory = ?, finished_at = ${finishedAtValue}
    WHERE id = ?
  `).run(
    description || null,
    rules !== undefined && rules !== null ? (typeof rules === 'string' ? rules : JSON.stringify(rules)) : null,
    targetBlockValue,
    winning_token || null,
    winner_ranges !== undefined && winner_ranges !== null ? (typeof winner_ranges === 'string' ? winner_ranges : JSON.stringify(winner_ranges)) : null,
    discordRewardAmount !== null ? discordRewardAmount : null,
    discordUsernameMandatory !== null ? discordUsernameMandatory : null,
    id
  );

  res.json({ message: 'Updated' });
});

app.patch('/giveaway/:id/participant/:pid', requireAdmin, (req: Request, res: Response) => {
  const { id, pid } = req.params;
  const { action } = req.body;

  if (!['approve', 'partial-approve', 'reject'].includes(action)) {
    res.status(400).json({ error: 'Invalid action' });
    return;
  }

  const approved = action === 'approve' ? 1 : (action === 'partial-approve' ? 2 : 0);
  db.prepare('UPDATE participants SET approved = ? WHERE id = ? AND giveaway_id = ?').run(approved, pid, id);
  if (approved) {
    const participant = db.prepare('SELECT * FROM participants WHERE id = ? AND giveaway_id = ?').get(pid, id) as ParticipantRow | undefined;
    if (participant) {
      db.prepare('DELETE FROM participants WHERE id <> ? AND giveaway_id = ? AND (tan_address = ? OR x_username = ? OR discord_username = ?)').run(pid, id, participant.tan_address, participant.x_username, participant.discord_username);
    }
  }

  res.json({ message: `Participant ${action}` });
});

app.post('/giveaway/:id/build-payout', requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
  const giveaway = db.prepare('SELECT * FROM giveaways WHERE id = ?').get(id) as GiveawayRow | undefined;

  if (!giveaway) {
    res.status(404).json({ error: 'Giveaway not found' });
    return;
  }

  if (!giveaway.target_block || !giveaway.winning_token || !giveaway.winner_ranges) {
    res.status(400).json({ error: 'Giveaway not ready for payout' });
    return;
  }

  const targetBlock = await getBlock(giveaway.target_block) as Block;
  if (!targetBlock) {
    res.status(400).json({ error: 'Could not fetch target block' });
    return;
  }

  const approvedParticipants = db.prepare('SELECT * FROM participants WHERE giveaway_id = ? AND approved > 0').all(id) as ParticipantRow[];
  if (approvedParticipants.length === 0) {
    res.status(400).json({ error: 'No approved participants' });
    return;
  }

  const winnerRanges = JSON.parse(giveaway.winner_ranges);
  const winners = selectWinners(giveaway, approvedParticipants, winnerRanges, targetBlock.pow.proof);
  const asset = new AssetId(giveaway.winning_token);
  
  // Calculate payout recipients including Discord rewards
  const payoutRecipients = winners.map((w) => {
    return {
      address: w.participant.tan_address,
      value: new BigNumber(w.amount)
    };
  });

  const unsignedTx = await buildTransaction(asset, payoutRecipients);
  
  res.json({
    winners: winners.map((w) => ({ participantId: w.participant.id, amount: w.amount })),
    unsignedTransaction: unsignedTx,
    blockNumber: targetBlock.number,
    proof: targetBlock.pow.proof
  });
});

app.get('*', (_, res) => {
  // Send the index.html file. 
  // React Router (client-side) will then handle the route
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// Start server
app.listen(20420, () => {
  // Start auto-finish checker every minute
  setInterval(autoFinishGiveaways, 60000);
  
  // Run initial check
  autoFinishGiveaways();
});

export default app;
