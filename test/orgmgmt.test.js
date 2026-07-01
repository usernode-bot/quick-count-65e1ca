'use strict';
// On-chain organization management: new memo types, role-based authorization,
// visibility filtering, deletion tombstone, and the viewer/org read snapshots.
const { test } = require('node:test');
const assert = require('node:assert');

const memo = require('../lib/memo');
const { QuickCountIndexer } = require('../lib/indexer');

const CFG = { treasury: 'TREASURY', orgFee: 100, adminAddrs: ['ADMIN'] };
let _t = Date.parse('2026-06-19T08:00:00.000Z');
function mk(txId, from, to, amount, env) {
  _t += 60000;
  return { txId, from, to, amount, memo: memo.encode(env), createdAt: new Date(_t).toISOString() };
}

const OWNER = 'orgOwner';
const ADMIN_M = 'memberAdmin';
const MOD_M = 'memberMod';
const MEMBER_M = 'memberPlain';
const OUTSIDER = 'outsider';

// Base: one paid, active org owned by OWNER. The org-creation tx carries a fixed
// earliest timestamp so it always sorts before any mk()-stamped extra (argument
// arrays are evaluated before this function body runs).
function baseOrg(extra = []) {
  const o1 = { txId: 'o1', from: OWNER, to: 'TREASURY', amount: 100, memo: memo.encode(memo.orgMemo('Owned Org', 'J')), createdAt: '2026-06-19T08:00:00.000Z' };
  return [o1].concat(extra);
}

// ── Memo round-trip + rejection ─────────────────────────────────────────────
test('omem/orem/ovis/odel memos round-trip', () => {
  assert.deepStrictEqual(memo.decode(memo.encode(memo.memberMemo('O', 'A', 'mod'))),
    { app: 'quickcount', v: 1, t: 'omem', org: 'O', addr: 'A', role: 'mod' });
  assert.deepStrictEqual(memo.decode(memo.encode(memo.removeMemberMemo('O', 'A'))),
    { app: 'quickcount', v: 1, t: 'orem', org: 'O', addr: 'A' });
  assert.deepStrictEqual(memo.decode(memo.encode(memo.visibilityMemo('O', 'private'))),
    { app: 'quickcount', v: 1, t: 'ovis', org: 'O', vis: 'private' });
  assert.deepStrictEqual(memo.decode(memo.encode(memo.deleteOrgMemo('O'))),
    { app: 'quickcount', v: 1, t: 'odel', org: 'O' });
});

test('decode rejects malformed org-management memos', () => {
  assert.strictEqual(memo.decode(JSON.stringify({ app: 'quickcount', v: 1, t: 'omem', org: 'O', addr: 'A', role: 'king' })), null);
  assert.strictEqual(memo.decode(JSON.stringify({ app: 'quickcount', v: 1, t: 'omem', org: 'O', role: 'mod' })), null); // no addr
  assert.strictEqual(memo.decode(JSON.stringify({ app: 'quickcount', v: 1, t: 'orem', org: 'O' })), null); // no addr
  assert.strictEqual(memo.decode(JSON.stringify({ app: 'quickcount', v: 1, t: 'ovis', org: 'O', vis: 'secret' })), null);
  assert.strictEqual(memo.decode(JSON.stringify({ app: 'quickcount', v: 1, t: 'odel' })), null); // no org
  // memberMemo coerces an unknown role to 'member'
  assert.strictEqual(memo.memberMemo('O', 'A', 'nope').role, 'member');
});

// ── Role resolution + member management ─────────────────────────────────────
test('owner is implicit; members get their assigned role', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('m1', OWNER, 'o1-ignored', 0, memo.memberMemo('orgOwner', ADMIN_M, 'admin')),
    mk('m2', OWNER, 'x', 0, memo.memberMemo('orgOwner', MOD_M, 'mod')),
    mk('m3', OWNER, 'x', 0, memo.memberMemo('orgOwner', MEMBER_M, 'member')),
  ]));
  assert.strictEqual(ix.orgRole(OWNER, OWNER), 'owner');
  assert.strictEqual(ix.orgRole(OWNER, ADMIN_M), 'admin');
  assert.strictEqual(ix.orgRole(OWNER, MOD_M), 'mod');
  assert.strictEqual(ix.orgRole(OWNER, MEMBER_M), 'member');
  assert.strictEqual(ix.orgRole(OWNER, OUTSIDER), null);
});

test('admin can manage members/mods but not admins or the owner', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('m1', OWNER, 'x', 0, memo.memberMemo('orgOwner', ADMIN_M, 'admin')),
    // admin adds a plain member — allowed
    mk('m2', ADMIN_M, 'x', 0, memo.memberMemo('orgOwner', MEMBER_M, 'member')),
    // admin tries to grant admin to someone — rejected
    mk('m3', ADMIN_M, 'x', 0, memo.memberMemo('orgOwner', OUTSIDER, 'admin')),
    // admin tries to demote the owner — rejected (owner immutable)
    mk('m4', ADMIN_M, 'x', 0, memo.memberMemo('orgOwner', OWNER, 'member')),
  ]));
  assert.strictEqual(ix.orgRole(OWNER, MEMBER_M), 'member');
  assert.strictEqual(ix.orgRole(OWNER, OUTSIDER), null); // admin grant rejected
  assert.strictEqual(ix.orgRole(OWNER, OWNER), 'owner'); // unchanged
});

test('admin cannot remove or alter another admin; owner can', () => {
  const ix = new QuickCountIndexer(CFG);
  const A2 = 'admin2';
  ix.rebuild(baseOrg([
    mk('m1', OWNER, 'x', 0, memo.memberMemo('orgOwner', ADMIN_M, 'admin')),
    mk('m2', OWNER, 'x', 0, memo.memberMemo('orgOwner', A2, 'admin')),
    // admin tries to demote another admin — rejected
    mk('m3', ADMIN_M, 'x', 0, memo.memberMemo('orgOwner', A2, 'member')),
    // admin tries to remove another admin — rejected
    mk('m4', ADMIN_M, 'x', 0, memo.removeMemberMemo('orgOwner', A2)),
  ]));
  assert.strictEqual(ix.orgRole(OWNER, A2), 'admin');
  // owner can remove an admin
  ix.apply(mk('m5', OWNER, 'x', 0, memo.removeMemberMemo('orgOwner', A2)));
  assert.strictEqual(ix.orgRole(OWNER, A2), null);
});

test('plain member and outsider cannot manage membership', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('m1', OWNER, 'x', 0, memo.memberMemo('orgOwner', MEMBER_M, 'member')),
    mk('m2', MEMBER_M, 'x', 0, memo.memberMemo('orgOwner', OUTSIDER, 'member')),
    mk('m3', OUTSIDER, 'x', 0, memo.memberMemo('orgOwner', 'someone', 'member')),
  ]));
  assert.strictEqual(ix.orgRole(OWNER, OUTSIDER), null);
  assert.strictEqual(ix.orgRole(OWNER, 'someone'), null);
});

test('owner-targeted member/remove is always rejected', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('m1', OWNER, 'x', 0, memo.memberMemo('orgOwner', OWNER, 'member')),
    mk('m2', OWNER, 'x', 0, memo.removeMemberMemo('orgOwner', OWNER)),
  ]));
  assert.strictEqual(ix.orgRole(OWNER, OWNER), 'owner');
  assert.strictEqual(ix.orgs.get(OWNER).members.has(OWNER), false);
});

// ── Visibility ──────────────────────────────────────────────────────────────
test('visibility defaults public, owner/admin can change it', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg());
  assert.strictEqual(ix.orgs.get(OWNER).visibility, 'public');
  ix.rebuild(baseOrg([
    mk('m1', OWNER, 'x', 0, memo.memberMemo('orgOwner', ADMIN_M, 'admin')),
    mk('v1', ADMIN_M, 'x', 0, memo.visibilityMemo('orgOwner', 'private')),
  ]));
  assert.strictEqual(ix.orgs.get(OWNER).visibility, 'private');
  // a plain member cannot change visibility
  ix.rebuild(baseOrg([
    mk('m1', OWNER, 'x', 0, memo.memberMemo('orgOwner', MEMBER_M, 'member')),
    mk('v1', MEMBER_M, 'x', 0, memo.visibilityMemo('orgOwner', 'private')),
  ]));
  assert.strictEqual(ix.orgs.get(OWNER).visibility, 'public');
});

test('private org elections are hidden from public but visible to members/owner/admin', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('v1', OWNER, 'x', 0, memo.visibilityMemo('orgOwner', 'private')),
    mk('m1', OWNER, 'x', 0, memo.memberMemo('orgOwner', MEMBER_M, 'member')),
    mk('el1', OWNER, OWNER, 0, memo.electionMemo('Private Election')),
  ]));
  assert.strictEqual(ix.visibleElections({ viewer: null }).length, 0); // anonymous public
  assert.strictEqual(ix.visibleElections({ viewer: OUTSIDER }).length, 0);
  assert.strictEqual(ix.visibleElections({ viewer: OWNER }).length, 1);
  assert.strictEqual(ix.visibleElections({ viewer: MEMBER_M }).length, 1);
  // (The platform-admin break-glass viewer was removed in #52; visibleElections
  // honors only `viewer`, so there is no admin-sees-all path to assert.)
});

test('public org elections stay public (regression)', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([mk('el1', OWNER, OWNER, 0, memo.electionMemo('Public Election'))]));
  assert.strictEqual(ix.visibleElections({ viewer: null }).length, 1);
});

// ── Deletion tombstone ──────────────────────────────────────────────────────
test('delete tombstones the org and makes it inert', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('el1', OWNER, OWNER, 0, memo.electionMemo('E1')),
    mk('del', OWNER, 'x', 0, memo.deleteOrgMemo('orgOwner')),
    // post-delete txs must all be rejected
    mk('m1', OWNER, 'x', 0, memo.memberMemo('orgOwner', MEMBER_M, 'member')),
    mk('v1', OWNER, 'x', 0, memo.visibilityMemo('orgOwner', 'private')),
    mk('el2', OWNER, OWNER, 0, memo.electionMemo('E2')),
  ]));
  assert.strictEqual(ix.orgs.get(OWNER).deleted, true);
  assert.strictEqual(ix.orgRole(OWNER, OWNER), null); // deleted org has no roles
  assert.strictEqual(ix.orgs.get(OWNER).members.size, 0);
  assert.strictEqual(ix.orgs.get(OWNER).visibility, 'public'); // change after delete rejected
  // E2 (created after delete) never registered; E1 hidden once the org is a tombstone.
  assert.strictEqual(ix.elections.has('el2'), false);
  assert.strictEqual(ix.visibleElections({ viewer: OWNER }).length, 0);
  // A deleted org's elections are hidden from everyone (the #52 admin break-glass
  // viewer no longer exists), so there is no viewer that still sees E1.
  assert.strictEqual(ix.visibleElections({ viewer: null }).length, 0);
});

test('only the owner can delete', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('m1', OWNER, 'x', 0, memo.memberMemo('orgOwner', ADMIN_M, 'admin')),
    mk('del', ADMIN_M, 'x', 0, memo.deleteOrgMemo('orgOwner')), // admin cannot delete
  ]));
  assert.strictEqual(ix.orgs.get(OWNER).deleted, false);
});

// ── Election operations authorization (broadened to admin/mod) ──────────────
test('admins and mods can run elections; members cannot', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('m1', OWNER, 'x', 0, memo.memberMemo('orgOwner', ADMIN_M, 'admin')),
    mk('m2', OWNER, 'x', 0, memo.memberMemo('orgOwner', MOD_M, 'mod')),
    mk('m3', OWNER, 'x', 0, memo.memberMemo('orgOwner', MEMBER_M, 'member')),
    mk('el1', OWNER, OWNER, 0, memo.electionMemo('E1')),
    // admin adds a candidate, mod adds a station — both allowed
    mk('c1', ADMIN_M, OWNER, 0, memo.candidateMemo('el1', 1, 'Red')),
    mk('s1', MOD_M, OWNER, 0, memo.stationMemo('el1', 1, 'A', 'N')),
    // plain member tries to add a candidate — rejected
    mk('c2', MEMBER_M, OWNER, 0, memo.candidateMemo('el1', 2, 'Blue')),
    // outsider tries too — rejected
    mk('c3', OUTSIDER, OWNER, 0, memo.candidateMemo('el1', 3, 'Green')),
  ]));
  const cands = ix.candidates.get('el1');
  assert.strictEqual(cands.has(1), true);  // admin
  assert.strictEqual(cands.has(2), false); // member rejected
  assert.strictEqual(cands.has(3), false); // outsider rejected
  assert.strictEqual(ix.stations.get('el1').has(1), true); // mod
});

// ── viewerRole + orgsForViewer snapshots ────────────────────────────────────
test('viewerRole exposes owned + member-of orgs', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild([
    mk('o1', OWNER, 'TREASURY', 100, memo.orgMemo('My Org', 'J')),
    mk('o2', 'otherOwner', 'TREASURY', 100, memo.orgMemo('Other Org', 'J')),
    mk('m1', 'otherOwner', 'x', 0, memo.memberMemo('otherOwner', OWNER, 'mod')),
  ]);
  const r = ix.viewerRole(OWNER);
  assert.strictEqual(r.orgsOwned.length, 1);
  assert.strictEqual(r.orgsOwned[0].role, 'owner');
  assert.strictEqual(r.orgsMember.length, 1);
  assert.strictEqual(r.orgsMember[0].addr, 'otherOwner');
  assert.strictEqual(r.orgsMember[0].role, 'mod');
});

test('orgsForViewer returns rosters with the owner first', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('m1', OWNER, 'x', 0, memo.memberMemo('orgOwner', ADMIN_M, 'admin')),
    mk('m2', OWNER, 'x', 0, memo.memberMemo('orgOwner', MEMBER_M, 'member')),
  ]));
  const out = ix.orgsForViewer(OWNER, { admin: false });
  assert.strictEqual(out.orgs.length, 1);
  const org = out.orgs[0];
  assert.strictEqual(org.viewerRole, 'owner');
  assert.strictEqual(org.members[0].role, 'owner');
  assert.strictEqual(org.members.length, 3);
  // a plain member sees the roster too
  const memberView = ix.orgsForViewer(MEMBER_M, { admin: false });
  assert.strictEqual(memberView.orgs.length, 1);
  assert.strictEqual(memberView.orgs[0].viewerRole, 'member');
  // an outsider sees nothing
  assert.strictEqual(ix.orgsForViewer(OUTSIDER, { admin: false }).orgs.length, 0);
});

// ── Edit org details (oedit) ────────────────────────────────────────────────
test('oedit memo round-trip', () => {
  assert.deepStrictEqual(memo.decode(memo.encode(memo.editOrgMemo('O', 'New Name', 'NewJur'))),
    { app: 'quickcount', v: 1, t: 'oedit', org: 'O', name: 'New Name', jur: 'NewJur' });
});

test('owner can update org name and jurisdiction', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('e1', OWNER, 'x', 0, memo.editOrgMemo('orgOwner', 'Renamed Org', 'NewJur')),
  ]));
  assert.strictEqual(ix.orgs.get(OWNER).name, 'Renamed Org');
  assert.strictEqual(ix.orgs.get(OWNER).jur, 'NewJur');
});

test('oedit rejects empty name', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('e1', OWNER, 'x', 0, { app: 'quickcount', v: 1, t: 'oedit', org: 'orgOwner', name: '', jur: '' }),
  ]));
  assert.strictEqual(ix.orgs.get(OWNER).name, 'Owned Org'); // unchanged
});

test('oedit decode rejects empty name', () => {
  assert.strictEqual(memo.decode(JSON.stringify({ app: 'quickcount', v: 1, t: 'oedit', org: 'O', name: '', jur: '' })), null);
  assert.strictEqual(memo.decode(JSON.stringify({ app: 'quickcount', v: 1, t: 'oedit', org: 'O', name: '   ', jur: '' })), null);
});

test('admin cannot call oedit', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('m1', OWNER, 'x', 0, memo.memberMemo('orgOwner', ADMIN_M, 'admin')),
    mk('e1', ADMIN_M, 'x', 0, memo.editOrgMemo('orgOwner', 'Admin Renamed', '')),
  ]));
  assert.strictEqual(ix.orgs.get(OWNER).name, 'Owned Org'); // unchanged
});

test('non-member cannot call oedit', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('e1', OUTSIDER, 'x', 0, memo.editOrgMemo('orgOwner', 'Outsider Renamed', '')),
  ]));
  assert.strictEqual(ix.orgs.get(OWNER).name, 'Owned Org'); // unchanged
});

test('oedit on deleted org is a no-op', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('del', OWNER, 'x', 0, memo.deleteOrgMemo('orgOwner')),
    mk('e1', OWNER, 'x', 0, memo.editOrgMemo('orgOwner', 'Post-delete Rename', '')),
  ]));
  assert.strictEqual(ix.orgs.get(OWNER).name, 'Owned Org'); // unchanged
});

// ── Management is gated on paid (active) status ─────────────────────────────
test('a pending (unpaid) org cannot be managed — every mutation is rejected', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild([
    mk('o1', OWNER, 'TREASURY', 0, memo.orgMemo('Pending Org', 'J')), // fee unpaid
    // Owner of a pending org tries the full management surface — all rejected.
    mk('m1', OWNER, 'x', 0, memo.memberMemo('orgOwner', MEMBER_M, 'member')),
    mk('v1', OWNER, 'x', 0, memo.visibilityMemo('orgOwner', 'private')),
    mk('e1', OWNER, 'x', 0, memo.editOrgMemo('orgOwner', 'Renamed', 'K')),
    mk('el1', OWNER, OWNER, 0, memo.electionMemo('Should not exist')),
  ]);
  const org = ix.orgs.get(OWNER);
  assert.strictEqual(org.active, false);
  assert.strictEqual(ix.orgRole(OWNER, MEMBER_M), null, 'member was not added');
  assert.strictEqual(org.visibility, 'public', 'visibility unchanged');
  assert.strictEqual(org.name, 'Pending Org', 'name unchanged');
  assert.strictEqual(ix.elections.size, 0, 'no election created');
  assert.strictEqual(ix.canOperate(OWNER, OWNER), false);
});

test('the owner can still pay (top-up) or delete a pending org', () => {
  // Delete an abandoned pending registration.
  const del = new QuickCountIndexer(CFG);
  del.rebuild([
    mk('o1', OWNER, 'TREASURY', 0, memo.orgMemo('Pending Org', 'J')),
    mk('d1', OWNER, 'x', 0, memo.deleteOrgMemo('orgOwner')),
  ]);
  assert.strictEqual(del.orgs.get(OWNER).deleted, true);

  // Pay the fee, then management unlocks.
  const pay = new QuickCountIndexer(CFG);
  pay.rebuild([
    mk('o1', OWNER, 'TREASURY', 0, memo.orgMemo('Pending Org', 'J')),
    mk('o2', OWNER, 'TREASURY', 100, memo.orgMemo('Pending Org', 'J')), // top-up
    mk('m1', OWNER, 'x', 0, memo.memberMemo('orgOwner', MEMBER_M, 'member')),
  ]);
  assert.strictEqual(pay.orgs.get(OWNER).active, true);
  assert.strictEqual(pay.orgRole(OWNER, MEMBER_M), 'member', 'member added after payment');
});

// ── Ownership transfer (oxfer / oxacc) ──────────────────────────────────────
test('oxfer/oxacc memo round-trip', () => {
  assert.deepStrictEqual(memo.decode(memo.encode(memo.transferOfferMemo('O', 'W'))),
    { app: 'quickcount', v: 1, t: 'oxfer', org: 'O', to: 'W' });
  assert.deepStrictEqual(memo.decode(memo.encode(memo.transferAcceptMemo('O'))),
    { app: 'quickcount', v: 1, t: 'oxacc', org: 'O' });
});

test('decode rejects malformed oxfer/oxacc memos', () => {
  assert.strictEqual(memo.decode(JSON.stringify({ app: 'quickcount', v: 1, t: 'oxfer', org: 'O' })), null); // no to
  assert.strictEqual(memo.decode(JSON.stringify({ app: 'quickcount', v: 1, t: 'oxfer', to: 'W' })), null); // no org
  assert.strictEqual(memo.decode(JSON.stringify({ app: 'quickcount', v: 1, t: 'oxacc' })), null); // no org
});

const NEW_OWNER = 'newOwner';

test('only owner can offer a transfer', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('m1', OWNER, 'x', 0, memo.memberMemo('orgOwner', ADMIN_M, 'admin')),
    mk('xf1', ADMIN_M, 'x', 0, memo.transferOfferMemo('orgOwner', NEW_OWNER)), // admin cannot offer
    mk('xf2', MEMBER_M, 'x', 0, memo.transferOfferMemo('orgOwner', NEW_OWNER)), // member cannot offer
    mk('xf3', OUTSIDER, 'x', 0, memo.transferOfferMemo('orgOwner', NEW_OWNER)), // outsider cannot offer
  ]));
  assert.strictEqual(ix.orgs.get(OWNER).pendingOwner, null);
});

test('owner can offer a transfer; pendingOwner is set', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('xf1', OWNER, 'x', 0, memo.transferOfferMemo('orgOwner', NEW_OWNER)),
  ]));
  assert.strictEqual(ix.orgs.get(OWNER).pendingOwner, NEW_OWNER);
});

test('offering to current owner cancels a pending offer', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('xf1', OWNER, 'x', 0, memo.transferOfferMemo('orgOwner', NEW_OWNER)),
    mk('xf2', OWNER, 'x', 0, memo.transferOfferMemo('orgOwner', OWNER)), // offer to self = cancel
  ]));
  assert.strictEqual(ix.orgs.get(OWNER).pendingOwner, null);
});

test('only pendingOwner can accept; random wallet cannot', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('xf1', OWNER, 'x', 0, memo.transferOfferMemo('orgOwner', NEW_OWNER)),
    mk('xa1', OUTSIDER, 'x', 0, memo.transferAcceptMemo('orgOwner')), // wrong wallet
  ]));
  assert.strictEqual(ix.orgs.get(OWNER).ownerAddr, OWNER); // unchanged
  assert.strictEqual(ix.orgs.get(OWNER).pendingOwner, NEW_OWNER); // still pending
});

test('accept transfers ownership: new owner is owner, old owner becomes admin', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('xf1', OWNER, 'x', 0, memo.transferOfferMemo('orgOwner', NEW_OWNER)),
    mk('xa1', NEW_OWNER, 'x', 0, memo.transferAcceptMemo('orgOwner')),
  ]));
  const org = ix.orgs.get(OWNER);
  assert.strictEqual(org.ownerAddr, NEW_OWNER);
  assert.strictEqual(org.pendingOwner, null);
  assert.strictEqual(ix.orgRole(OWNER, NEW_OWNER), 'owner');
  assert.strictEqual(ix.orgRole(OWNER, OWNER), 'admin');   // old owner demoted
  assert.strictEqual(org.members.has(NEW_OWNER), false);   // new owner not in members map
  assert.strictEqual(org.addr, OWNER);                      // addr (stable identity) unchanged
});

test('isOwner() reflects ownerAddr after transfer', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('xf1', OWNER, 'x', 0, memo.transferOfferMemo('orgOwner', NEW_OWNER)),
    mk('xa1', NEW_OWNER, 'x', 0, memo.transferAcceptMemo('orgOwner')),
  ]));
  assert.strictEqual(ix.isOwner(OWNER, NEW_OWNER), true);
  assert.strictEqual(ix.isOwner(OWNER, OWNER), false); // old owner no longer owner
});

test('post-transfer owner immutability check uses isOwner()', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('xf1', OWNER, 'x', 0, memo.transferOfferMemo('orgOwner', NEW_OWNER)),
    mk('xa1', NEW_OWNER, 'x', 0, memo.transferAcceptMemo('orgOwner')),
    // new owner tries to target old owner (now admin) for removal — allowed
    mk('rem1', NEW_OWNER, 'x', 0, memo.removeMemberMemo('orgOwner', OWNER)),
    // new owner tries to target itself — rejected (owner immutable)
    mk('rem2', NEW_OWNER, 'x', 0, memo.removeMemberMemo('orgOwner', NEW_OWNER)),
  ]));
  assert.strictEqual(ix.orgRole(OWNER, OWNER), null);    // removed successfully
  assert.strictEqual(ix.orgRole(OWNER, NEW_OWNER), 'owner'); // still owner
});

test('viewerRole._ownedOrgs follows ownerAddr after transfer', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('xf1', OWNER, 'x', 0, memo.transferOfferMemo('orgOwner', NEW_OWNER)),
    mk('xa1', NEW_OWNER, 'x', 0, memo.transferAcceptMemo('orgOwner')),
  ]));
  const roleNew = ix.viewerRole(NEW_OWNER);
  assert.strictEqual(roleNew.orgsOwned.length, 1);
  assert.strictEqual(roleNew.orgsOwned[0].addr, OWNER); // stable addr

  const roleOld = ix.viewerRole(OWNER);
  assert.strictEqual(roleOld.orgsOwned.length, 0); // old addr is no longer owner
  assert.strictEqual(roleOld.orgsMember.length, 1); // but is now a member (admin)
});

test('_pendingOwnerOrgs shows orgs with pending offer for viewer', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('xf1', OWNER, 'x', 0, memo.transferOfferMemo('orgOwner', NEW_OWNER)),
  ]));
  const role = ix.viewerRole(NEW_OWNER);
  assert.strictEqual(role.orgsPendingOwner.length, 1);
  assert.strictEqual(role.orgsPendingOwner[0].addr, OWNER);

  const roleOther = ix.viewerRole(OUTSIDER);
  assert.strictEqual(roleOther.orgsPendingOwner.length, 0);
});

test('orgDetail includes pendingOwner and is visible to pendingOwner', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('xf1', OWNER, 'x', 0, memo.transferOfferMemo('orgOwner', NEW_OWNER)),
  ]));
  const detail = ix.orgDetail(OWNER, NEW_OWNER);
  assert.ok(detail, 'pending owner can see org');
  assert.strictEqual(detail.pendingOwner, NEW_OWNER);
  assert.strictEqual(detail.viewerRole, null); // not a member yet
  assert.strictEqual(detail.members.length, 0); // members hidden (no role)

  // after acceptance pendingOwner clears
  ix.apply(mk('xa1', NEW_OWNER, 'x', 0, memo.transferAcceptMemo('orgOwner')));
  const detail2 = ix.orgDetail(OWNER, NEW_OWNER);
  assert.strictEqual(detail2.pendingOwner, null);
  assert.strictEqual(detail2.viewerRole, 'owner');
});

test('visibleElections: new owner can see org elections; old founding addr cannot as owner', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('el1', OWNER, OWNER, 0, memo.electionMemo('E1')),
    mk('xf1', OWNER, 'x', 0, memo.transferOfferMemo('orgOwner', NEW_OWNER)),
    mk('xa1', NEW_OWNER, 'x', 0, memo.transferAcceptMemo('orgOwner')),
  ]));
  // New owner sees org's election as owner
  const visNew = ix.visibleElections({ viewer: NEW_OWNER });
  assert.strictEqual(visNew.length, 1);
  // Old addr still sees it (as member/admin) — org is active and public
  const visOld = ix.visibleElections({ viewer: OWNER });
  assert.strictEqual(visOld.length, 1);
  // orgRole for election is now new owner
  assert.strictEqual(ix.orgRole(OWNER, NEW_OWNER), 'owner');
  assert.strictEqual(ix.orgRole(OWNER, OWNER), 'admin');
});

test('auditEntries populated on transfer offer and accept', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('xf1', OWNER, 'x', 0, memo.transferOfferMemo('orgOwner', NEW_OWNER)),
    mk('xa1', NEW_OWNER, 'x', 0, memo.transferAcceptMemo('orgOwner')),
  ]));
  const entries = ix.auditEntries.get(OWNER) || [];
  assert.ok(entries.some((e) => e.action === 'ownership_offered' && e.actor === OWNER && e.target === NEW_OWNER));
  assert.ok(entries.some((e) => e.action === 'ownership_transferred' && e.actor === NEW_OWNER && e.target === OWNER));
});

test('orgDetail audit array visible to owner and admin, not to member', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(baseOrg([
    mk('m1', OWNER, 'x', 0, memo.memberMemo('orgOwner', ADMIN_M, 'admin')),
    mk('m2', OWNER, 'x', 0, memo.memberMemo('orgOwner', MEMBER_M, 'member')),
    mk('xf1', OWNER, 'x', 0, memo.transferOfferMemo('orgOwner', NEW_OWNER)),
  ]));
  const ownerView = ix.orgDetail(OWNER, OWNER);
  assert.ok(Array.isArray(ownerView.audit), 'owner sees audit');
  const adminView = ix.orgDetail(OWNER, ADMIN_M);
  assert.ok(Array.isArray(adminView.audit), 'admin sees audit');
  const memberView = ix.orgDetail(OWNER, MEMBER_M);
  assert.strictEqual(memberView.audit, undefined, 'member does not see audit');
});
