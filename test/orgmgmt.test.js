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
  assert.strictEqual(ix.visibleElections({ admin: true }).length, 1);
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
  // E2 (created after delete) never registered; E1 hidden from non-admins.
  assert.strictEqual(ix.elections.has('el2'), false);
  assert.strictEqual(ix.visibleElections({ viewer: OWNER }).length, 0);
  assert.strictEqual(ix.visibleElections({ admin: true }).length, 1);
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

// ── Membership independent of fee/active ────────────────────────────────────
test('members can be added to a pending (unpaid) org', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild([
    mk('o1', OWNER, 'TREASURY', 0, memo.orgMemo('Pending Org', 'J')), // fee unpaid
    mk('m1', OWNER, 'x', 0, memo.memberMemo('orgOwner', MEMBER_M, 'member')),
  ]);
  assert.strictEqual(ix.orgs.get(OWNER).active, false);
  assert.strictEqual(ix.orgRole(OWNER, MEMBER_M), 'member');
});
