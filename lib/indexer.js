const { getTransactionsForAddress, getTransaction } = require('./blockchain');

const APP_PUBKEY = () => process.env.APP_PUBKEY || '';

// Minimal base58 decoder for Waves-style transaction attachments
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str) {
  if (!str) return null;
  try {
    let n = BigInt(0);
    for (const c of str) {
      const idx = B58.indexOf(c);
      if (idx < 0) return null;
      n = n * 58n + BigInt(idx);
    }
    if (n === 0n) return Buffer.alloc(0);
    const hex = n.toString(16);
    return Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
  } catch {
    return null;
  }
}

function decodeMemo(attachment) {
  if (!attachment) return null;
  // Try plain JSON string first
  try { const m = JSON.parse(attachment); if (m && typeof m === 'object') return m; } catch {}
  // Try base64
  try {
    const decoded = Buffer.from(attachment, 'base64').toString('utf8');
    const m = JSON.parse(decoded);
    if (m && typeof m === 'object') return m;
  } catch {}
  // Try base58
  try {
    const bytes = base58Decode(attachment);
    if (bytes) {
      const m = JSON.parse(bytes.toString('utf8'));
      if (m && typeof m === 'object') return m;
    }
  } catch {}
  return null;
}

async function indexTransaction(tx, pool) {
  if (!tx || !tx.id) return;

  // Check idempotency
  const exists = await pool.query('SELECT id FROM cached_submissions WHERE tx_hash = $1', [tx.id]);
  if (exists.rows.length > 0) return;

  const memo = decodeMemo(tx.attachment || tx.data || tx.memo || '');
  if (!memo || memo.app !== 'quickcount' || memo.type !== 'submit_result') return;

  if (!memo.election_id || !memo.station_id || !memo.votes || typeof memo.votes !== 'object') return;

  // Verify the station exists in this election
  const stationRes = await pool.query(
    'SELECT id FROM polling_stations WHERE id = $1 AND election_id = $2',
    [memo.station_id, memo.election_id]
  );
  if (stationRes.rows.length === 0) return;

  const chainTimestamp = tx.timestamp ? new Date(tx.timestamp > 1e12 ? tx.timestamp : tx.timestamp * 1000) : new Date();
  const blockHeight = tx.height || null;
  const senderPubkey = tx.senderPublicKey || tx.sender || memo.pubkey || '';

  await pool.query(`
    INSERT INTO cached_submissions
      (tx_hash, station_id, election_id, submitter_username, submitter_pubkey, votes, cid, block_height, chain_timestamp)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (tx_hash) DO NOTHING
  `, [
    tx.id,
    memo.station_id,
    memo.election_id,
    memo.agent || '',
    senderPubkey,
    JSON.stringify(memo.votes),
    memo.cid || null,
    blockHeight,
    chainTimestamp,
  ]);
}

async function runIndexer(pool) {
  const pubkey = APP_PUBKEY();
  if (!pubkey) return;

  try {
    const stateRes = await pool.query('SELECT last_indexed_block FROM indexer_state WHERE id = 1');
    const lastBlock = stateRes.rows[0]?.last_indexed_block || 0;

    const txs = await getTransactionsForAddress(pubkey, 100);
    if (!txs.length) return;

    let maxBlock = lastBlock;
    for (const tx of txs) {
      const h = tx.height || 0;
      if (lastBlock === 0 || h > lastBlock) {
        await indexTransaction(tx, pool);
        if (h > maxBlock) maxBlock = h;
      }
    }

    if (maxBlock > lastBlock) {
      await pool.query(
        'UPDATE indexer_state SET last_indexed_block = $1, last_indexed_at = NOW() WHERE id = 1',
        [maxBlock]
      );
    }
  } catch (err) {
    console.error('Indexer error:', err.message);
  }
}

async function reindexAll(pool) {
  await pool.query('UPDATE indexer_state SET last_indexed_block = 0, last_indexed_at = NOW() WHERE id = 1');
  await pool.query('DELETE FROM cached_submissions');
  await runIndexer(pool);
}

function startIndexer(pool) {
  pool.query(`INSERT INTO indexer_state (id, last_indexed_block) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`)
    .then(() => {
      runIndexer(pool);
      setInterval(() => runIndexer(pool), 30000);
    })
    .catch(err => console.error('Indexer init error:', err.message));
}

module.exports = { startIndexer, runIndexer, reindexAll, indexTransaction, decodeMemo };
