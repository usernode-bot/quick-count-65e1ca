// Quick Count — chain RPC client.
// All calls are stubbed when LOCAL_DEV=true (staging default).

const IS_LOCAL_DEV = process.env.LOCAL_DEV !== 'false';

async function getBalance(pubkey) {
  if (IS_LOCAL_DEV) return 999999;
  const base = process.env.NODE_RPC_URL;
  if (!base || !pubkey) return 0;
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}/balance/${pubkey}`);
    if (!r.ok) return 0;
    const d = await r.json();
    return Number(d.balance || d.available || 0);
  } catch { return 0; }
}

async function broadcastTx({ memo, toPubkey }) {
  if (IS_LOCAL_DEV) {
    return { txHash: 'local-' + String(Date.now()) + '-' + Math.floor(Math.random() * 10000) };
  }
  const base = process.env.NODE_RPC_URL;
  if (!base) throw new Error('NODE_RPC_URL not set');
  const r = await fetch(`${base.replace(/\/+$/, '')}/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: toPubkey, amount: 0, memo }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => r.status);
    throw new Error(`broadcastTx failed: ${text}`);
  }
  const d = await r.json();
  const txHash = d.txId || d.txid || d.id || d.hash || d.tx_hash;
  if (!txHash) throw new Error('broadcastTx: no txHash in response');
  return { txHash };
}

async function waitForConfirmation(txHash, timeoutMs = 60000) {
  if (IS_LOCAL_DEV) {
    return { confirmed: true, blockHeight: 9999, chainTimestamp: new Date() };
  }
  const base = process.env.NODE_RPC_URL;
  if (!base) return { confirmed: false, blockHeight: 0, chainTimestamp: new Date() };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base.replace(/\/+$/, '')}/transactions/${txHash}`);
      if (r.ok) {
        const d = await r.json();
        const blockHeight = d.blockHeight || d.block_height || d.height || 0;
        const chainTimestamp = d.timestamp || d.created_at || d.createdAt
          ? new Date(d.timestamp || d.created_at || d.createdAt)
          : new Date();
        if (blockHeight > 0 || d.confirmed) {
          return { confirmed: true, blockHeight: Number(blockHeight), chainTimestamp };
        }
      }
    } catch {}
    await new Promise((res) => setTimeout(res, 2000));
  }
  return { confirmed: false, blockHeight: 0, chainTimestamp: new Date() };
}

module.exports = { getBalance, broadcastTx, waitForConfirmation };
