# Stage 2 — Roadmap, Deliverable Manifest, Definition of Done

---

## 1. Stage plan (spec §18)

| Stage | Scope | Exit report |
|---|---|---|
| **1 — Discovery** | Preferences, assumptions, provider matrix, uncertainties, recommended mode | ✅ docs/01, docs/02 |
| **2 — Architecture** | Layers, data flow, schemas, state machines, acceptance criteria | ✅ docs/03, this file |
| **3 — Thin vertical prototype** | fixture/simulation → normalize → order book → analytics → simple battlefield → status UI | files changed, commands, tests, limitations, next step |
| **4 — Complete MVP** | all panels, army mapping, camera modes, provider switching, fallbacks, replay, accessibility, tests | same |
| **5 — Production hardening** | perf profiling, security review, deployment config, docs, attribution, runbook | ✅ docs/05 (2026-08-13) |

## 2. Deliverable manifest (spec §19)

| # | Deliverable | File / location | Status |
|---|---|---|---|
| 1 | Product requirements document | docs/01 (preferences & assumptions) + README | ✅ |
| 2 | Architecture overview | docs/03 | ✅ |
| 3 | Provider capability matrix | docs/02 | ✅ |
| 4 | Data-flow diagram | docs/03 §3 | ✅ |
| 5 | State-machine description | docs/03 §5 | ✅ |
| 6 | Repository structure | docs/03 §2 (scaffold lands in Stage 3) | ✅ (design) |
| 7 | Complete source code | apps/, packages/ | ✅ complete (Stages 3–5) |
| 8 | Environment-variable template | apps/gateway/.env.example | ✅ (Stage 3, extended Stage 4) |
| 9 | Local setup instructions | README quick start + docs/05 §6 | ✅ |
| 10 | Docker setup | docker-compose.yml, Dockerfiles (gateway + nginx web) | 🟡 written; build unverified in authoring env (no Docker) — verify at deploy |
| 11 | Unit tests | tests/unit (order book, analytics, normalization, fallback, checksum, visual mapping, adapters) | ✅ 70 tests (Stage 5) |
| 12 | Integration tests | live pipeline verification for binance/kraken/coinbase/gemini/bitstamp/reference/aggregated via scripts/verify-live.ts | ✅ (Stage 4, extended Stage 5) |
| 13 | End-to-end smoke test | tests/e2e (Playwright: boots gateway+web, checks disclaimer/canvas/labels/accessibility) | ✅ 1 passing (Stage 4) |
| 14 | Replay fixtures | tests/fixtures/replay-xaut-1.json | ✅ (Stage 3) |
| 15 | Deployment instructions | README + docker-compose + docs/05 §6 | ✅ |
| 16 | Troubleshooting guide | docs/05 §5 | ✅ |
| 17 | Data-integrity limitations | docs/05 §4 | ✅ |
| 18 | Security checklist | docs/05 §1 | ✅ |
| 19 | Accessibility checklist | docs/05 §2 | ✅ |
| 20 | Performance checklist | docs/05 §3 | ✅ |
| 21 | Definition of done | §3 of this file | ✅ (defined) |

No deliverable is dropped silently: the manifest is updated at every stage report.

## 3. Definition of Done (spec §20) — acceptance tracking

- [x] Runs using documented commands — local verified (`npm run dev:*`); Docker files written, unbuilt in authoring env (no daemon) — verify at deploy.
- [x] At least one verified live, replay, or simulation adapter works — five live venues + replay + simulation all verified.
- [x] Every active mode is accurately labelled (live / delayed / replay / simulated / reference-price / aggregated-proxy).
- [x] Order-book sequence handling is tested (gaps, out-of-order, resync, duplicates).
- [x] Stale data is visible to the user (badge + `staleReason`).
- [x] Providers can fail without crashing the 3D scene (fallback chain + error isolation + ErrorBoundary).
- [x] Simulation is never presented as live (mode badge + persistent label; e2e-verified).
- [x] Large trades are not mislabelled as liquidations ("large-trade / pressure events").
- [x] CVD is hidden or marked unavailable when trade side is unknown.
- [x] Application is responsive (desktop-first; graceful degradation).
- [x] Reduced-motion mode works and preserves information (e2e-verified).
- [x] Key calculations have unit tests (order book + analytics + adapters).
- [x] UI includes the persistent educational disclaimer (e2e-verified).
- [x] No secrets in the client bundle (`npm run check:secrets`).
- [x] Known limitations are documented (docs/05 §4).

## 4. Prohibited behaviours (spec §21) — engineering guardrails

- Never fabricate live data, provider support, or liquidation events.
- Never scrape TradingView or other platforms through undocumented endpoints.
- Never bypass auth or rate limits; never expose API keys.
- Never call polled/delayed data "tick-by-tick" or "real-time" in the UI.
- Never identify cancelled orders as executed trades, or large trades as liquidations.
- Never present imbalance or CVD as a forecast.
- Never hide fallback or simulation status.
- No trading, wallet, or brokerage functionality. No claim of 100% accuracy.

Where a requirement cannot be implemented truthfully, implement the nearest accurately labelled fallback and document it.

## 5. Testing matrix (spec §17, scoped per user preference "minimal smoke tests" + DoD)

| Area | Cases | Tool |
|---|---|---|
| Order book | snapshot load, buffered deltas, updates, insertions, deletions, out-of-order, gaps, duplicates, reconnect resync | vitest |
| Analytics | BBO, spread, midpoint, depth aggregation, imbalance, signed notional, CVD, rolling windows, percentile thresholds, unknown side | vitest |
| Normalization | malformed message rejection, symbol normalization, field coercion | vitest |
| Fallbacks | primary fail → secondary ok, REST fallback, stale REST, replay, simulation, recovery | vitest (deterministic fixtures) |
| E2E smoke | app boots, battlefield renders, disclaimer present, simulation label shown, fallback badge correct, reduced-motion toggle works | Playwright (1 smoke spec) |

All tests use recorded deterministic fixtures — no live network dependence.

## 6. Performance budgets & quality levels (spec §16)

| Metric | Budget |
|---|---|
| Frame time (desktop) | ≤ 16.7 ms (60 FPS); degrade gracefully to ≥ 30 FPS |
| Draw calls | ≤ 400 (batched/instanced) |
| Active units | ≤ 4,000 instanced |
| Particles | ≤ 2,000 pooled |
| Event ring buffer | ≤ 5,000 events |
| Visual cadence | 12 Hz (configurable 10–20) |
| Queue depth | bounded per provider (drop-oldest policy, counted) |
| Quality levels | High / Medium / Low / Battery-saver (auto-detect + manual) |

## 7. Definition of done for each stage report

Every stage ends with: files created/changed · commands to run · tests performed · known limitations · unresolved assumptions · next recommended step.
