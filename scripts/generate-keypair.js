#!/usr/bin/env node
// Quick Count — generate a local ut1… keypair for signing test transactions.
//
//   node scripts/generate-keypair.js
//
// Produces an ed25519 keypair and a deterministic ut1-prefixed address derived
// from the public key. Intended for local-dev / standalone testing only — the
// platform manages real wallets via the hosted bridge.

const crypto = require('crypto');

function main() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' });
  // ed25519 SPKI DER has a 12-byte header; the last 32 bytes are the raw key.
  const raw = pubRaw.subarray(pubRaw.length - 32);
  const addr = 'ut1' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 39);

  const out = {
    address: addr,
    publicKey: raw.toString('hex'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.stderr.write('\nKeep the privateKey secret. Use the address as a wallet identity in local-dev.\n');
}

main();
