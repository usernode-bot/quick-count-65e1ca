# Quick Count

On-chain **election quick-count** platform, built as a standalone
`usernode-dapp-starter` app. The chain is the source of truth: every state
change is a Usernode transaction carrying an `app:"quickcount"` memo, and a
deterministic indexer replays the transaction log to build all read state.

## Roles

- **Owner** — the wallet that **creates** an organization is its Owner, with full
  authority over that org's data (elections, candidates, stations, observers,
  dispute resolutions, working tally, ballot proofs, member roster, visibility,
  deletion). Owners can grant members the org-level **Administrator**, **Moderator**,
  or **Member** roles; Owner outranks all of them.
- **Platform operator** — the app-level role configured via `ADMIN_ADDRS`. Runs the
  whole service (fee waivers, the oversight dashboard) and holds a narrow
  **break-glass** override on a few org operations for support / abandoned-org
  recovery. It is platform support, **not** org ownership — governance of an org's
  data belongs to that org's Owner.
- **Organizations** register (paying a one-time fee), create elections, define
  candidates, build a polling-station registry (incl. bulk CSV import),
  authorize observers, and resolve disputes.
- **Observers** report and revise their station's count, attach evidence
  (hashed locally — the file never leaves the device) and a reviewable ballot
  proof (image/PDF, validated before submission), and file disputes.
- **The public** watches live results (updated in real time via SSE) under five
  aggregation methods, verifies evidence, and exports CSV/JSON. No wallet required.

## Aggregation methods

`latest` · `first` · `consensus` (modal value per station) · `median` ·
`verified` (latest excluding results invalidated by an upheld dispute). The
dashboard also shows a lead-margin / uncertainty band and a **needs review**
flag when observer disagreement or disputes could affect the outcome.

## Running

Local-dev (offline, mock ledger, demo data, persona switcher):

    npm install
    npm run dev          # http://localhost:3000  (--local-dev)

In `--local-dev` the server serves `GET /__mock/enabled` (200) — the endpoint
the hosted wallet bridge probes to enter mock mode. Without it the bridge fails
every transaction with "Mock API not enabled".

Or with Docker:

    docker compose -f docker-compose.dev.yml up --build   # offline, mock ledger
    docker compose up --build                             # Postgres + real node

Generate a throwaway keypair for testing:

    npm run keygen

Run the test suite:

    npm test

## Configuration

See `.env.example`. Key vars: `DATABASE_URL` (optional — in-memory log if
unset), `NODE_RPC_URL` (real chain; empty in local-dev), `TREASURY_ADDR`,
`ORG_FEE`, `ADMIN_ADDRS`, and `APP_MODE=local-dev` / `--local-dev`.

On-chain mode and app identity:

- `MOCK_TX_FLOW` — self-contained local-ingest switch. `false` (production
  default) is **real on-chain mode**: the hosted bridge signs/broadcasts and
  the indexer reads transactions back. `true` records submissions straight
  into the event log with no chain — local-dev and the staging preview run
  with it on (`dapp.json` sets `staging_default: "true"`).
- `APP_PUBKEY` — the application's own on-chain wallet **public** address
  (`ut1…`). Public identifier; ships with an obviously-fake placeholder so the
  deploy never blocks. Set the real address in Settings → Secrets.
- `APP_SECRET_KEY` — the app's on-chain **signing key** (private in
  `dapp.json`: encrypted at rest, isolated from staging). Read defensively and
  never logged; no server-side signing path uses it yet. Set the real key
  yourself in Settings → Secrets.
- `TIMER_DURATION_MS` — cadence (ms) for the background chain poll and the
  client auto-refresh. Defaults to `6000`; values below `1000` are floored.

## Layout

- `server.js` — Express server, indexer poller, `/__quickcount/*` read API,
  local-dev `/__mock/*`, chain-tx persistence, demo seed.
- `lib/memo.js` — `app:"quickcount"` memo envelopes.
- `lib/indexer.js` — deterministic `QuickCountIndexer` state machine.
- `lib/aggregate.js` — the five aggregation methods + margin / needs-review.
- `lib/txsource.js`, `lib/mockledger.js` — chain adapters.
- `public/index.html` — role-aware responsive SPA (dashboard, elections, orgs,
  evidence gallery, disputes, admin).
- `scripts/generate-keypair.js` — local keypair tool.
