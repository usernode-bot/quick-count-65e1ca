// Deprecated: IPFS functionality moved to local filesystem storage.
// This file is kept for backward compatibility but is not used.

async function uploadToIPFS() {
  throw new Error('IPFS upload is deprecated. Use savePhoto from lib/storage.js instead.');
}

module.exports = { uploadToIPFS };
