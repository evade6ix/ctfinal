# CTFinal

CTFinal is Game 3's internal marketplace and inventory operations workspace. It keeps physical bin locations, CardTrader listings, ManaPool listings, order allocations, picking progress, repricing, and operational history in one application.

## Core workflows

- **Operations overview** — live inventory, fulfillment, integrity, and automation health.
- **Unified pick route** — CardTrader and ManaPool lines sorted by physical bin and row.
- **Catalog and staging** — create marketplace listings and add inventory to a destination bin.
- **Inventory integrity** — read-only comparison of Mongo totals, location totals, sync errors, and allocation conflicts.
- **Manual exceptions** — resolve order lines that could not be allocated automatically.
- **CardTrader repricer** — preview changes before applying live base prices.
- **Operation history** — durable records for syncs, repricing, staged pushes, manual assignments, and batch picks.

## Local development

```bash
npm install
npm install --prefix server
npm install --prefix client
npm run dev
```

The API runs on port `3000` by default. Vite proxies `/api` requests to the local API during development.

## Validation

```bash
npm test --prefix server
npm run build --prefix client
```

GitHub Actions runs server syntax checks, server unit tests, and the production client build for every pull request and every push to `main`.

## Production topology

- The React/Vite client is deployed separately and proxies `/api/*` and `/health` to Railway.
- Railway runs the Express server from `/server`.
- MongoDB stores inventory, bins, allocations, change logs, catalog caches, and operation history.
- Direct client routes such as `/picking` and `/integrity` are rewritten to the single-page application entry point.
