// Quick Count — profile + i18n helpers (pure, shared by server + tests).
//
// The frontend (public/index.html) mirrors the same regex and language list
// inline; keep them in sync. These functions are pure so they can be unit
// tested in Node without a browser.

// Supported UI languages (order = display order in the selector).
const LANGS = ['en', 'id', 'zh-Hans', 'es', 'hi', 'ar', 'fr', 'ja', 'de', 'pt', 'ko'];

// App-local display name: 3–20 chars, letters / numbers / underscores only.
const DISPLAY_NAME_RE = /^[A-Za-z0-9_]{3,20}$/;

function isValidDisplayName(s) {
  return typeof s === 'string' && DISPLAY_NAME_RE.test(s);
}

// Bio: free text, max 280 characters (null / empty string are valid — means "no bio").
const BIO_MAX_LEN = 280;

function isValidBio(s) {
  if (s === null || s === undefined || s === '') return true;
  return typeof s === 'string' && s.length <= BIO_MAX_LEN;
}

function isSupportedLang(code) {
  return typeof code === 'string' && LANGS.includes(code);
}

// Map a browser/Accept-Language-style tag (e.g. "zh-CN", "en-US", "fr") to a
// supported code, or null. Matches on the primary subtag so "es-419" → "es"
// and "zh-CN"/"zh-TW" → "zh-Hans".
function matchBrowserLang(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const low = raw.toLowerCase();
  const base = low.split('-')[0];
  const hit = LANGS.find((l) => {
    const ll = l.toLowerCase();
    return ll === low || ll.split('-')[0] === base;
  });
  return hit || null;
}

// Resolve the active language by priority:
//   saved profile preference > device-local preference > browser languages > English.
// `browserLangs` may be a single string or an array (navigator.languages).
function resolveLang(profilePref, localPref, browserLangs) {
  if (isSupportedLang(profilePref)) return profilePref;
  if (isSupportedLang(localPref)) return localPref;
  const list = Array.isArray(browserLangs)
    ? browserLangs
    : (browserLangs ? [browserLangs] : []);
  for (const raw of list) {
    const code = matchBrowserLang(raw);
    if (code) return code;
  }
  return 'en';
}

module.exports = {
  LANGS,
  DISPLAY_NAME_RE,
  BIO_MAX_LEN,
  isValidDisplayName,
  isValidBio,
  isSupportedLang,
  matchBrowserLang,
  resolveLang,
};
