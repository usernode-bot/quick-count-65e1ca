# Quick Count — notes for coding agents

Quick Count is a **standalone usernode-dapp-starter** app: a plain Node/Express
server where the **chain is the source of truth**. Every state change is a
Usernode transaction whose memo carries an `app:"quickcount"` envelope; the
server never mutates election state. Identity is the **wallet address** — there
is no server-side login.

## Architecture invariants

- **Deterministic indexer.** `lib/indexer.js` (`QuickCountIndexer`) rebuilds all
  read state by replaying the full transaction log in `(createdAt, txId)` order.
  Replaying the same log always yields identical state. The read model is
  disposable — drop it and re-index. Keep `apply()` pure w.r.t. its inputs.
- **Append-only log.** Raw transactions are stored in `chain_txs` (when
  `DATABASE_URL` is set) or in memory. Never write derived state to the DB as a
  source of truth.
- **Authorization lives in the indexer**, enforced from `tx.from`:
  org-registration is fee-gated; structural changes (`cand`/`stn`/`obs`/`dres`)
  require the organizing wallet; results require an authorized observer;
  disputes require an observer or the org; `adm` requires an admin wallet.
  The org **creator is the Owner** (`org.addr`, the implicit top role) with full
  authority over that org's data; `ADMIN_ADDRS` is a **platform operator** —
  platform support with a narrow break-glass override, **not** org ownership.
- **Memo schema** (`lib/memo.js`) is mirrored inline in `public/index.html`
  (`QC.*`). Change both together. Keep keys short — memos have a length budget.

## Platform notes

- The hosted bridge is loaded from the CDN in `index.html` (platform rule —
  never vendor the real bridge). `public/usernode-bridge.js` is a **local-dev
  mock only**, active when the server reports `localDev`.
- All `/__quickcount/*` read endpoints are public by design (read-only,
  chain-sourced). `/__mock/*` exists only in `--local-dev`. The hosted bridge
  probes `GET /__mock/enabled` to decide whether to enter mock mode — it must
  return 200 in local-dev (it does, mounted in the `LOCAL_DEV` block) or the
  bridge fails transactions with "Mock API not enabled".
- Demo data is seeded when `USERNODE_ENV=staging` **or** `--local-dev` so every
  screen renders; the seed is idempotent, obviously fake ("Staging demo —"),
  and a strict no-op in production.
- Don't `git push` — commit and stop; the harness pushes.

## Don't

- Don't add a server route that mutates election state — sign a transaction.
- Don't bypass the indexer to populate read state (except the gated demo seed).
- Don't edit the `// usernode-dev-console@1` block in `public/index.html`.
