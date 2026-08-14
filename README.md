# GOLD BATTLEFIELD

> **Educational market visualization only. Not financial advice, not a price forecast, and not a trading signal.**

GOLD BATTLEFIELD converts live, replayed, or simulated gold-related market data into a 3D battlefield visualization. Buyers and sellers are rendered as opposing low-poly armies competing around a price-based front line.

The application is strictly for education, entertainment, and market-data visualization. It does **not** execute trades, connect to brokerage accounts, provide personalized financial advice, predict future prices, or present visual effects as trading signals.

## What you are watching

The app is an **ambient live visualization** — something to leave running on a
second screen, not a game to play. The market is not narrated; the scene is
labelled, and the labels are the explanation.

| On screen | In market terms |
|---|---|
| Green army, left | Resting buy orders (bids), below the price |
| Red army, right | Resting sell orders (asks), above the price |
| Glowing front line | Last traded price; falls back to the book midpoint (tagged `mid`) once the last print goes stale |
| Gap around the line | The spread — where nothing trades |
| Army size / front width | Displayed depth on that side |
| Crenellated fortifications | A single price level holding unusually large size (a "wall") |
| Wall topples over | The level vanished **while trades printed through it** — most likely consumed |
| Wall sinks and fades | The level vanished with **no trade near it** — most likely cancelled |
| Charge + shockwave | A large executed trade ("pressure event") — never a liquidation |
| Ground scar | Where the price has been over the last minute |
| Units stand down | No trades for a while: the front is genuinely quiet |

Open **"What am I looking at?"** in the app for the same key.

Hotkeys: `H` hide HUD · `T` TV mode · `L` in-scene labels · `R` reset camera ·
`Space` freeze view · `WASD` / arrows pan.

## Highlights

- **3D battlefield** (React Three Fiber + Three.js): instanced low-poly Bull and
  Bear infantry that form up behind the price, march and charge on executed
  flow, crenellated wall fortifications that build up and dismantle, pooled
  impact/charge/debris effects, price-ladder terrain bands, and a price trail.
  All geometry is procedural — the repository ships no 3D assets — and all
  in-scene text is canvas-rasterized, so nothing is fetched from a CDN.
- **Cinematic layout**: full-bleed canvas with a floating glass HUD that fades
  while you watch, plus a chrome-free TV mode. The educational disclaimer stays
  visible in every layout state.
- **Opt-in event SFX** synthesized with Web Audio (no audio assets), fired only
  on large trades and wall breaks, rate-limited and off by default.
- **Provider-independent adapters** with verified free data sources (see [provider capability matrix](docs/02-provider-capability-matrix.md)):
  - **MODE A/B** — Binance `PAXG/USDC`, Kraken `XAUT/USD`, Coinbase `PAXG-USD`, Gemini `PAXG/USD`, and Bitstamp `PAXG/USD` public spot order books + trades (aggressor side).
  - **MODE C** *(default)* — aggregated proxy view across all five verified USD-quoted gold-token venues (Binance + Kraken + Coinbase + Gemini + Bitstamp): composite reference price, single-venue book with automatic primary switching + recovery, per-venue labelled trades. A venue whose midpoint drifts more than 0.2% from the composite has its prints **excluded** from the aggregate with a visible feed warning — "only aggregate compatible measurements" (spec §4).
  - **MODE D** — keyless Swissquote XAU/USD bid/ask reference price (verified live).
  - **MODE F** — deterministic historical replay (pause / resume / speed / seek / restart).
  - **MODE G** — clearly labelled synthetic simulation.
- **Correctness-first data layer**: runtime Zod validation, snapshot + delta order-book reconstruction, sequence-gap detection, checksums where supported, bounded memory, 10–20 Hz visual cadence decoupled from the network layer.
- **Honest semantics**: CVD hidden when aggressor side is unknown; large trades are *never* called liquidations; simulation is *never* presented as live; fallback/stale status always visible.
- **Accessibility**: reduced-motion mode, screen-reader live summaries, colour-blind palette, full keyboard controls.
- **Zero secrets in the client bundle**: any keyed provider is accessed through the Node.js gateway with env-var configuration (`npm run check:secrets` enforces it).
- **Production hardening**: code-split vendor chunks (three.js loads separately), live FPS/draw-call/unit instrumentation with auto-quality (High→Battery-saver), strict CSP + security headers, error boundary + client error feed, secrets CI check — see [docs/05-production-hardening.md](docs/05-production-hardening.md).
- **Visualization pass**: the ambient-watching rebuild and the full list of
  correctness and performance bugs fixed on top of the original build —
  see [docs/06-visualization-pass.md](docs/06-visualization-pass.md).

## Quick start

### Docker (recommended)

```bash
cd gold-battlefield
docker compose up --build
# web UI:        http://localhost:8080
# gateway WS:    ws://localhost:8081 (proxied through the web server)
```

### Local development

```bash
npm install
npm run dev:gateway   # terminal 1 — market-data gateway on :8081
npm run dev:web       # terminal 2 — Vite dev server on :5173
```

Copy `.env.example` to `.env` in `apps/gateway` before starting the gateway. All values are optional for the free, keyless default setup (Binance/Kraken/Coinbase/Gemini/Bitstamp/Swissquote/replay/simulation). **No API keys are required anywhere** — every live feed (Binance, Kraken, Coinbase, Gemini, Bitstamp, Swissquote) is a public, unauthenticated endpoint. Keyed providers are supported by design (backend `.env` only) but none are used.

### Tests & checks

```bash
npm test          # unit tests (98: order book, analytics, normalization, fallback, checksum, adapters, visual mapping)
npm run test:e2e  # Playwright smoke tests (4: honest labels, accessibility + legend, TV mode, CVD window labelling)
npm run check:secrets  # scans the built bundle + source for leaked secrets / provider env-var names
npm run build --workspace @gb/web  # production build (code-split vendor chunks)

# Live pipeline verification against a running gateway (operational tools):
npx tsx scripts/verify-live.ts binance     # live Binance PAXG/USDC (needs network)
npx tsx scripts/verify-live.ts coinbase    # live Coinbase PAXG-USD (needs network)
npx tsx scripts/verify-live.ts gemini      # live Gemini PAXG/USD (needs network)
npx tsx scripts/verify-live.ts bitstamp    # live Bitstamp PAXG/USD (needs network)
npx tsx scripts/verify-live.ts simulation  # synthetic, deterministic
npx tsx scripts/verify-live.ts replay       # deterministic fixture
# → prints book consistency, sequence gaps, resync count, BBO/spread, CVD, freshness

# Soak test across reconnects (needs gateway restarted with the test hook):
#   BINANCE_FORCE_RECONNECT_MS=30000 npm run start --workspace @gb/gateway
npx tsx scripts/soak-test.ts binance ws://localhost:8081 200000
# → PASS/FAIL report: gaps, resyncs, crossed books, staleness, depth bounds, CVD honesty
```

## Repository structure

```
gold-battlefield/
├── apps/
│   ├── web/                      # React + Vite + R3F frontend
│   │   └── src/scene/            # procedural geometry, armies, walls, effects, labels
│   └── gateway/                  # Node.js + TypeScript market-data gateway
├── packages/
│   ├── market-types/             # normalized event schemas + Zod validators
│   ├── provider-adapters/        # Binance, Kraken, Coinbase, Gemini, Bitstamp, Swissquote, replay, simulation
│   ├── order-book/               # snapshot/delta reconstruction, gaps, checksums
│   ├── analytics/                # BBO, spread, imbalance, CVD, thresholds
│   ├── visual-mapping/           # market → battlefield transforms, walls, effects
│   └── shared-config/            # modes, budgets, labels, thresholds
├── tests/
│   ├── fixtures/                 # recorded/deterministic market fixtures
│   ├── unit/                     # vitest unit tests
│   └── e2e/                      # Playwright smoke test
├── docs/
│   ├── 01-preferences-and-assumptions.md
│   ├── 02-provider-capability-matrix.md
│   ├── 03-architecture.md
│   ├── 04-roadmap-and-definition-of-done.md
│   ├── 05-production-hardening.md
│   └── 06-visualization-pass.md   # ambient rebuild + bug-fix log
├── docker-compose.yml
└── package.json                   # npm workspaces
```

## Delivery stage manifest

| Stage | Scope | Status |
|---|---|---|
| 1 — Discovery | Preferences, assumptions, provider matrix, data-mode recommendation | ✅ done (docs/01, docs/02) |
| 2 — Architecture | Layers, data flow, schemas, state machines, acceptance criteria | ✅ done (docs/03, docs/04) |
| 3 — Thin vertical prototype | provider/fixture → normalize → order book → analytics → simple battlefield → status UI | ✅ done (Stage 3 report) |
| 4 — Complete MVP | all panels, armies, camera, provider switching, fallbacks, replay, accessibility, tests | ✅ done (Stage 4 report) |
| 5 — Production hardening | performance, security review, deployment, docs, attribution, runbook | ✅ done (docs/05) |

See [docs/04-roadmap-and-definition-of-done.md](docs/04-roadmap-and-definition-of-done.md) for the full deliverable manifest and Definition of Done.
