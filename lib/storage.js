const fs = require('fs');
const path = require('path');

const IS_LOCAL_DEV = process.env.LOCAL_DEV === 'true';
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

function ensureUploadsDir() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

async function savePhoto(buffer, filename) {
  if (IS_LOCAL_DEV) {
    return `local-dev-photo-${Date.now()}`;
  }

  ensureUploadsDir();
  const safeFilename = `photo-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ext = path.extname(filename) || '.jpg';
  const finalFilename = safeFilename + ext;
  const filepath = path.join(UPLOADS_DIR, finalFilename);

  fs.writeFileSync(filepath, buffer);
  return finalFilename;
}

function getPhotoPath(filename) {
  if (!filename || filename.startsWith('local-dev-')) return null;
  return path.join(UPLOADS_DIR, filename);
}

module.exports = { savePhoto, getPhotoPath, ensureUploadsDir };
