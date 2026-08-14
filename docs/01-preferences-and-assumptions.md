# Stage 1 — Discovery: Preferences, Assumptions, Uncertainties

**Date:** 2026-08-13
**Status:** ✅ Delivered (pending user confirmation)

---

## 1. Preference summary (interview answers)

### Essential

| # | Question | Answer |
|---|---|---|
| 1 | 3D engine | **React Three Fiber + Three.js** |
| 2 | Frontend framework | **React + Vite** |
| 3 | Backend | **Node.js + TypeScript gateway** |
| 4 | Primary market data | **Aggregated multi-provider** (MODE C, with per-venue order books) |
| 5 | Liquidations | **Large-trade effects only** — never liquidation effects (no provider-reported liquidation feed exists for spot gold) |
| 6 | Free to operate | **Yes, 100% free** — free/public/unauthenticated sources only |
| 7 | API keys | **Backend env vars OK** — keyed adapters allowed but keys never reach the client |
| 8 | Visual style | **Low-poly, family-friendly** |
| 9 | Performance | **Desktop-first, 60 FPS** with graceful degradation |
| 10 | Deliverable | **Production-ready full repository** (all 21 deliverables) |
| 11 | Deployment | **Local + Docker** |
| 12 | Accessibility / audio | **Reduced-motion mode** and **screen-reader live summaries** (selected); colour-blind palette + keyboard controls kept from spec defaults (see assumptions); audio off by default |

### Optional

| Question | Answer |
|---|---|
| Map scale | **Adaptive** — battlefield scales with current volatility/depth |
| Camera | **All three** — orbit/zoom/WASD, follow-price cinematic, fixed isometric (switchable) |
| Default effects intensity | **Minimal** (Standard and Cinematic available as settings) |
| Historical data retention | **Session only** — no persistence; replay fixtures shipped as files |
| Testing depth | **Minimal smoke tests** — one Playwright smoke test + mandatory unit tests for key calculations (see deviations) |

---

## 2. Deviations from spec defaults (and why)

| Spec default | Decision | Reason |
|---|---|---|
| IndexedDB local replay storage | **Session only** (no IndexedDB) | Explicit user preference (Optional Q4) |
| Full Vitest + Playwright test suite | **Minimal smoke tests** | Explicit user preference (Optional Q5); however spec §20 requires unit tests for key calculations, so a focused unit suite is retained for order-book and analytics math only |
| Full Vitest + Playwright test suite (again) | Smoke test still uses **Playwright** | Kept as the e2e tool so the single smoke test runs in a real browser |
| Standard effects intensity | **Minimal default** | Explicit user preference (Optional Q3); setting remains selectable |
| Sound effects + music | **Off by default, minimal audio** | Not selected by user; UI keeps an audio toggle (spec requires it) but ships with no music assets (avoids licensing burden). Only subtle, non-graphic UI/trade cues, off by default. |
| Colour-blind palette + keyboard controls | **Included** | Spec UI section mandates them (camera WASD/arrows, palette toggle, accessibility testing), so they are kept even though not explicitly selected |

Everything else follows the spec defaults in §2: React + TypeScript, Vite, React Three Fiber, Zustand, Node.js + TypeScript gateway, Zod runtime validation, Web Workers for aggregation, WebSocket transport, Vitest for units, Docker.

**Package manager:** npm workspaces (ships with Node, zero extra prerequisites). Monorepo layout follows spec §13.

---

## 3. Assumptions (documented)

1. **Each gold token ≈ 1 troy oz** — PAXG and XAUT both represent ~1 troy oz of allocated gold, so USD-quoted token prices are directly comparable in USD/oz. No FX normalization needed for aggregation; structural premium/discount between tokens is acknowledged and surfaced as "proxy" labelling.
2. **Order books are per-venue.** Aggregated mode combines *prices/notionals for display and a composite reference price*; it never fabricates a consolidated order book. When in aggregated mode the UI shows: *"Aggregated proxy view, not a consolidated regulated order book"*.
3. **Binance `PAXG/USDC` and Kraken `XAUT/USD` remain listed and publicly accessible** in the user's region. Market-data endpoints are unauthenticated. Final symbol/availability re-check happens at integration time (see matrix).
4. **Browser access to public exchange market-data endpoints is acceptable** (WS has no CORS; Binance/Kraken public REST have historically permissive CORS). All traffic is additionally proxied through the gateway so the browser only ever talks to our origin.
5. **No free public spot-gold liquidation feed exists** → the liquidation feature is implemented as *large-trade / pressure events*, always labelled as such, never as liquidations.
6. **Swissquote BBO endpoint is an unofficial/best-effort feed** (no documented SLA, no rate-limit documentation). It is used only as MODE D fallback, polled conservatively (≤ 1 request / 5 s, exponential backoff + jitter), with stale detection.
7. **Rendering targets 12 visual updates/sec** (within the spec's 10–20 Hz band) while the data layer processes every message; guarantees a stable render cadence and bounded work per frame.
8. **Session-only memory:** event history is a bounded ring buffer (e.g., 5,000 events / last 30 min); depth state keeps only top-N price levels for visualization; no persistence of any kind in the browser.
9. **The gateway is optional for keyless operation but always present** in the default Docker deployment: it provides WS fan-out, replay/simulation sources, rate limiting, origin checks, and a place for future keyed adapters without ever shipping secrets to the client.
10. **No analytics/tracking, no auth, no wallet, no order placement** — out of scope by spec §15/§21.
11. **Desktop-first.** Mobile is "graceful degradation": reduced unit counts, quality level auto-drop, same information. Target: 60 FPS desktop, ≥30 FPS low-power.

---

## 4. Technical / legal / licensing uncertainties

1. **Geographic availability of Binance** public market-data endpoints for the user's location (Binance restricts some regions). Fallback chain absorbs this via Kraken → Swissquote → replay → simulation.
2. **Rate-limit changes** on Binance/Kraken public endpoints (weight/connection limits change over time; limits are isolated in shared-config).
3. **Swissquote endpoint terms** — unverified licensing/redistribution terms; treated as best-effort MODE D with polling caps; UI labels it "Reference-price visualization. Order flow unavailable."
4. **Kraken WS v1 vs v2** — v2 is the current documented surface; v1 feeds still operate. Adapter will target the documented v2 where possible and v1 fallback; exact feed fields verified at integration.
5. **Checksum mechanics — RESOLVED 2026-08-13 (official docs):** Binance spot depth streams do **not** expose checksums; correctness relies on the documented `U`/`u`/`lastUpdateId` sequence + resync protocol. Kraken v2 book carries a CRC32 checksum computed over the top-10 levels (algorithm documented; optional periodic validation).
6. **Aggregated-mode legal framing** — we display the actual instruments and exchanges ("PAXG/USDC on Binance", "XAUT/USD on Kraken") and never relabel as spot XAU/USD; redistribution constraints (if any) are honoured by not redistributing recorded vendor data beyond local session replay.
7. **Geo-restrictions (verified 2026-08-13):** `api.binance.com` is geo-blocked from the US, Canada, the Netherlands, and sanctioned territories (HTTP 451). The gateway must run in a permitted region; the market-data-only host `data-stream.binance.vision` is the intended fallback host, but per-region availability is unverified until deployment. The fallback chain (Kraken → Swissquote → replay → simulation) covers geo-blocking and outages; the UI always shows the active provider.

---

## 5. Recommended data mode

**Default: MODE C — Aggregated proxy view**, composed of:

- **Primary venue order book + trades:** Binance `PAXG/USDC` (free, unauthenticated, aggressor-side info, checksums).
- **Secondary venue order book + trades:** Kraken `XAUT/USD` (same capability class).
- **Composite reference price** computed from both venues' midpoints (USD/oz, directly comparable per assumption 1).

**Fallback hierarchy (always visible in the UI badge):**

1. MODE A/B — primary venue (Binance) live order flow
2. MODE B — secondary venue (Kraken) live order flow
3. MODE C — aggregated proxy view (both venues, composite price)
4. MODE D — Swissquote XAU/USD reference price (order-flow features disabled)
5. MODE E — delayed REST polling (within documented limits) if WS unavailable
6. MODE F — replay of recorded fixtures (deterministic)
7. MODE G — synthetic simulation (clearly labelled; never mixed with live data)

The user can also explicitly select any single mode (including pure replay or simulation) from the Controls.
