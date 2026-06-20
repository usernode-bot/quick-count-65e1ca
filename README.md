# Quick Count

On-chain **election quick-count** platform, built as a standalone
`usernode-dapp-starter` app. The chain is the source of truth: every state
change is a Usernode transaction carrying an `app:"quickcount"` memo, and a
deterministic indexer replays the transaction log to build all read state.

## Roles

- **Organizations** register (paying a one-time fee), create elections, define
  candidates, build a polling-station registry (incl. bulk CSV import),
  authorize observers, and resolve disputes.
- **Observers** report and revise their station's count, attach evidence
  (hashed locally — the file never leaves the device), and file disputes.
- **The public** watches live results under five aggregation methods, verifies
  evidence, and exports CSV/JSON. No wallet required.

## Aggregation methods

`latest` · `first` · `consensus` (modal value per station) · `median` ·
`verified` (latest excluding results invalidated by an upheld dispute). The
dashboard also shows a lead-margin / uncertainty band and a **needs review**
flag when observer disagreement or disputes could affect the outcome.

## Running

Local-dev (offline, mock ledger, demo data, persona switcher):

    npm install
    npm run dev          # http://localhost:3000  (--local-dev)

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
