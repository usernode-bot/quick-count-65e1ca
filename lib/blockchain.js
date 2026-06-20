const NODE_RPC_URL = process.env.NODE_RPC_URL || '';

async function safeFetch(url, opts) {
  if (!NODE_RPC_URL) return null;
  try {
    const res = await fetch(url, opts);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function getBalance(address) {
  if (!address) return null;
  const data = await safeFetch(`${NODE_RPC_URL}/addresses/balance/${address}`);
  if (data === null) return null;
  return typeof data.balance === 'number' ? data.balance : null;
}

async function getTransactionsForAddress(address, limit = 100) {
  if (!address) return [];
  const data = await safeFetch(`${NODE_RPC_URL}/transactions/address/${address}/limit/${limit}`);
  if (!data) return [];
  // Waves API returns [[tx, tx, ...]] (array of pages)
  if (Array.isArray(data) && Array.isArray(data[0])) return data[0];
  if (Array.isArray(data)) return data;
  return data.transactions || [];
}

async function getTransaction(txHash) {
  if (!txHash) return null;
  return await safeFetch(`${NODE_RPC_URL}/transactions/info/${txHash}`);
}

async function getCurrentHeight() {
  const data = await safeFetch(`${NODE_RPC_URL}/blocks/height`);
  return data ? (data.height || 0) : 0;
}

module.exports = { getBalance, getTransactionsForAddress, getTransaction, getCurrentHeight };
