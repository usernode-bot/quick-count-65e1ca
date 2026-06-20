const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const IS_LOCAL_DEV = process.env.LOCAL_DEV === 'true';
const LOCAL_DEV_CID = 'QmLocalDevCID000000000000000000000000000000000';
const STAGING_PLACEHOLDER_CID = 'QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB';

async function uploadToIPFS(buffer, filename, mimeType) {
  const apiUrl = process.env.IPFS_API_URL || 'https://api.pinata.cloud';
  const jwt = process.env.PINATA_JWT || '';

  if (IS_LOCAL_DEV) return LOCAL_DEV_CID;
  if (jwt === 'staging-dummy-jwt' || (IS_STAGING && (!jwt || jwt === 'staging-test-key'))) {
    return STAGING_PLACEHOLDER_CID;
  }

  const formData = new FormData();
  const blob = new Blob([buffer], { type: mimeType || 'image/jpeg' });
  formData.append('file', blob, filename || 'evidence.jpg');

  const res = await fetch(`${apiUrl}/pinning/pinFileToIPFS`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.status);
    throw new Error(`IPFS upload failed: ${text}`);
  }

  const data = await res.json();
  return data.IpfsHash || data.cid || null;
}

module.exports = { uploadToIPFS };
