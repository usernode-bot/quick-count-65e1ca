'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  LANGS,
  BIO_MAX_LEN,
  isValidDisplayName,
  isValidBio,
  isSupportedLang,
  matchBrowserLang,
  resolveLang,
} = require('../lib/profile');

// ── Display-name validator (^[A-Za-z0-9_]{3,20}$) ────────────────────────────
test('display name validator accepts valid names', () => {
  assert.ok(isValidDisplayName('abc'));
  assert.ok(isValidDisplayName('User_1'));
  assert.ok(isValidDisplayName('a_b_c'));
  assert.ok(isValidDisplayName('A'.repeat(20)));         // 20 chars (max)
  assert.ok(isValidDisplayName('123'));
});

test('display name validator rejects invalid names', () => {
  assert.ok(!isValidDisplayName('ab'));                  // too short (2)
  assert.ok(!isValidDisplayName('A'.repeat(21)));        // too long (21)
  assert.ok(!isValidDisplayName('has space'));           // space
  assert.ok(!isValidDisplayName('dash-name'));           // punctuation
  assert.ok(!isValidDisplayName('dot.name'));            // punctuation
  assert.ok(!isValidDisplayName('emoji😀name'));         // emoji
  assert.ok(!isValidDisplayName(''));                    // empty
  assert.ok(!isValidDisplayName(null));                  // non-string
  assert.ok(!isValidDisplayName(123));                   // non-string
});

// ── Supported-language check ─────────────────────────────────────────────────
test('isSupportedLang matches the seven shipped languages', () => {
  for (const l of ['en', 'id', 'zh-Hans', 'es', 'hi', 'ar', 'fr']) {
    assert.ok(isSupportedLang(l), l + ' should be supported');
  }
  assert.deepStrictEqual(LANGS, ['en', 'id', 'zh-Hans', 'es', 'hi', 'ar', 'fr']);
  assert.ok(!isSupportedLang('de'));
  assert.ok(!isSupportedLang('zh'));   // bare zh is not a stored code
  assert.ok(!isSupportedLang(''));
});

// ── Browser-tag matching ─────────────────────────────────────────────────────
test('matchBrowserLang maps regional tags to supported codes', () => {
  assert.strictEqual(matchBrowserLang('en-US'), 'en');
  assert.strictEqual(matchBrowserLang('fr-FR'), 'fr');
  assert.strictEqual(matchBrowserLang('es-419'), 'es');
  assert.strictEqual(matchBrowserLang('zh-CN'), 'zh-Hans');
  assert.strictEqual(matchBrowserLang('zh-TW'), 'zh-Hans');
  assert.strictEqual(matchBrowserLang('ar-EG'), 'ar');
  assert.strictEqual(matchBrowserLang('de-DE'), null);
  assert.strictEqual(matchBrowserLang(''), null);
  assert.strictEqual(matchBrowserLang(null), null);
});

// ── Bio validator (null / '' / string ≤ 280 chars) ───────────────────────────
test('isValidBio accepts null and empty string', () => {
  assert.ok(isValidBio(null));
  assert.ok(isValidBio(''));
  assert.ok(isValidBio(undefined));
});

test('isValidBio accepts strings within the limit', () => {
  assert.ok(isValidBio('Hello, world!'));
  assert.ok(isValidBio('a'.repeat(BIO_MAX_LEN)));
});

test('isValidBio rejects overlong strings', () => {
  assert.ok(!isValidBio('a'.repeat(BIO_MAX_LEN + 1)));
});

test('isValidBio rejects non-string non-null values', () => {
  assert.ok(!isValidBio(123));
  assert.ok(!isValidBio([]));
  assert.ok(!isValidBio({}));
});

// ── Resolution priority: profile > local > browser > English ─────────────────
test('resolveLang prefers a saved profile preference', () => {
  assert.strictEqual(resolveLang('ar', 'fr', ['en-US']), 'ar');
});

test('resolveLang falls back to the device-local preference', () => {
  assert.strictEqual(resolveLang(null, 'hi', ['en-US']), 'hi');
  assert.strictEqual(resolveLang('de', 'hi', ['en-US']), 'hi'); // unsupported profile pref ignored
});

test('resolveLang uses the browser languages when no stored preference', () => {
  assert.strictEqual(resolveLang(null, null, ['zh-CN', 'en']), 'zh-Hans');
  assert.strictEqual(resolveLang(null, null, 'fr-FR'), 'fr');
});

test('resolveLang falls back to English when nothing matches', () => {
  assert.strictEqual(resolveLang(null, null, ['de-DE', 'ru']), 'en');
  assert.strictEqual(resolveLang(null, null, []), 'en');
  assert.strictEqual(resolveLang(undefined, undefined, undefined), 'en');
});
