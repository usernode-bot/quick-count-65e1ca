// Quick Count — local filesystem photo storage.
// In LOCAL_DEV mode, returns a placeholder filename without writing to disk.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IS_LOCAL_DEV = process.env.LOCAL_DEV !== 'false';
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

async function savePhoto(buffer, originalname) {
  if (IS_LOCAL_DEV) {
    return 'placeholder-' + crypto.randomUUID() + '.jpg';
  }
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
  const ext = path.extname(originalname || '') || '.jpg';
  const filename = crypto.randomUUID() + ext;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  return filename;
}

module.exports = { savePhoto };
