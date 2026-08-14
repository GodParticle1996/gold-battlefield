# Stage 2 — Architecture

**Status:** ✅ Delivered. Approved tech stack per interview: React + Vite · React Three Fiber · Zustand · Node.js + TypeScript gateway · Zod · npm workspaces · Docker.

---

## 1. System layers (spec §13)

| Layer | Where | Responsibility |
|---|---|---|
| 1. Provider adapters | `packages/provider-adapters` | Uniform `MarketDataAdapter` interface; Binance, Kraken, Swissquote, Replay, Simulation implementations |
| 2. Runtime validation | `packages/market-types` | Zod schemas for every normalized event; reject malformed messages without crashing the pipeline |
| 3. Event normalization | `packages/market-types` + adapters | Raw exchange payloads → normalized events; symbol normalization; unit conversion |
| 4. Order-book reconstruction | `packages/order-book` | snapshot + buffered deltas, sequence rules, gap detection, resync, zero-quantity deletion, checksums, bounded memory |
| 5. Analytics engine | `packages/analytics` | BBO, spread, midpoint, depth aggregation, imbalance, signed notional, CVD (rolling windows), percentile thresholds |
| 6. Visual-state aggregation | `packages/visual-mapping` | market state → stable visual state at 12 Hz; logarithmic scaling; clamping; safe ranges |
| 7. Rendering engine | `apps/web` (R3F) | instanced armies, pooled particles, fortifications, effects, camera modes; consumes visual state only |
| 8. UI state | `apps/web` (Zustand) | panels, controls, badges, settings; persists camera + UI preferences across provider switches |
| 9. Replay and recording | `packages/replay` | deterministic fixture playback (pause/resume/speed/seek/restart); session recording (in-memory, session-only) |
| 10. Diagnostics & health | `packages/shared-config` + gateway | heartbeats, staleness, latency, reconnect counts, structured logging, user-visible health status |

No exchange-specific parsing logic lives inside React components.

## 2. Repository structure (spec §13)

```
/apps
  /web              React + Vite + R3F (battlefield, panels, controls)
  /gateway          Node + TS (WS hub, provider connections, replay/sim sources, rate limits)
/packages
  /market-types     normalized schemas + Zod validators
  /provider-adapters
  /order-book
  /analytics
  /visual-mapping
  /replay
  /shared-config    modes, budgets, thresholds, labels
/tests
  /fixtures         deterministic recorded market fixtures (JSON)
  /unit             vitest (order book, analytics, normalization, fallback logic)
  /e2e              Playwright smoke test
```

## 3. Data-flow diagram

```
Exchange WS (Binance PAXG/USDC, Kraken XAUT/USD) ──┐
Swissquote XAU/USD BBO (REST, polled) ─────────────┤
Replay fixtures / in-memory recording ─────────────┼─► GATEWAY (Node + TS)
Simulation engine ─────────────────────────────────┘     │
                                                        │  connect adapters
                                                        │  validate (Zod) → normalize
                                                        │  dedupe · bounded queues · rate limits
                                                        ▼
                                              wss:// (same-origin, origin-checked)
                                                        │
                                   ┌────────────────────┴────────────────────┐
                                   ▼                                         ▼
                        Web Worker (browser)                        UI state (Zustand)
                        runtime validation                           · market panel numbers
                        order-book reconstruction                    · badges, health, controls
                        analytics (BBO/CVD/thresholds)               · settings (persisted)
                                   │
                                   ▼
                        Visual-state aggregation (12 Hz)
                        · army composition, formation sizes
                        · price-line position, walls, effects queue
                                   │
                       ┌───────────┴───────────┐
                       ▼                       ▼
                R3F rendering               Panels/feed
                (instanced meshes,           (DOM: market, depth,
                 pools, camera,              events, controls)
                 effects)
```

**Key rule:** the 3D render loop consumes the *stable visual-state model*, never raw provider messages. Networking/parsing run outside the render-critical path (Web Worker + gateway).

## 4. Normalized event schemas (spec §6 — exact fields)

```ts
type InstrumentType = 'tokenized-gold-spot' | 'spot-reference' | 'replay' | 'simulation';
type AggressorSide = 'buy' | 'sell' | 'unknown';
type ProviderState = 'idle' | 'connecting' | 'connected' | 'stale' | 'reconnecting' | 'failed';

interface OrderBookSnapshot {
  provider: string; symbol: string; instrumentType: InstrumentType;
  timestamp: number; sequence?: number;
  bids: Array<{ price: number; quantity: number }>;   // sorted desc
  asks: Array<{ price: number; quantity: number }>;   // sorted asc
}
interface OrderBookDelta {
  provider: string; symbol: string; timestamp: number;
  firstSequence?: number; finalSequence?: number;
  bidUpdates: Array<{ price: number; quantity: number }>;
  askUpdates: Array<{ price: number; quantity: number }>;
  checksum?: number;
}
interface TradeEvent {
  provider: string; symbol: string; tradeId: string; timestamp: number;
  price: number; baseQuantity: number; quoteNotional: number;
  aggressorSide: AggressorSide; isEstimated: boolean;
}
interface LiquidationEvent {
  provider: string; symbol: string; timestamp: number;
  side: 'buy' | 'sell'; price: number; quantity: number; quoteNotional: number;
  eventId: string; isProviderReported: boolean;
}
interface ReferencePriceEvent {
  provider: string; symbol: string; timestamp: number;
  bid?: number; ask?: number; midpoint?: number; last?: number;
  isDelayed: boolean; isStale: boolean;
}
interface ConnectionStatus {
  provider: string; state: ProviderState; lastMessageAt: number;
  reconnectAttempts: number; latencyEstimate?: number; staleReason?: string;
}
```

Every external message passes through a Zod schema; malformed events are rejected, counted, and logged (sanitized) without crashing the loop.

## 5. State machines

### 5.1 Connection / reconnection (per provider)

```
IDLE ──start──► CONNECTING ──open──► CONNECTED ──no heartbeat in window──► STALE
  ▲                │  ▲                 │  ▲                                  │
  │                │  │                 │  │ close / error                    │
  └────────────────┴──┴──────── RECONNECTING ◄───────────────────────────────┘
        backoff = min(maxBackoff, base * 2^attempts) + jitter(0..0.3)
        circuit breaker: after K consecutive failures → OPEN (cool-down) → HALF-OPEN probe → closed/OPEN
```

- Heartbeat monitoring with `lastMessageAt`; stale detection surfaces `staleReason` in the UI.
- On provider switch: order book + sequence state for the old provider is cleared/partitioned; never merged with the new provider; camera and UI preferences are preserved; a provider-change event is emitted.

### 5.2 Data-mode fallback (always user-visible)

```
A/B primary venue (Binance PAXG/USDC)
  → B secondary venue (Kraken XAUT/USD)
  → C aggregated proxy view (composite USD/oz reference + per-venue books)
  → D reference-price mode (Swissquote BBO; order-flow features disabled)
  → E delayed REST polling (within limits, exponential backoff + jitter)
  → F replay mode (recorded fixtures)
  → G simulation (synthetic; never mixed with live)
```

Transitions emit events (feed: `provider-change`, `stale-data warning`); the top-bar badge always shows the **active mode + provider + symbol + staleness**. Explicit user selection of any single mode overrides auto-fallback until re-enabled.

## 6. Quantitative mapping (spec §9)

```ts
normalizedSize  = log1p(notional / referenceNotional)              // clamp to [0, maxScale]
imbalance       = (bidDepth - askDepth) / (bidDepth + askDepth)    // [-1, 1]
signedNotional  =  +quoteNotional for aggressive buy
                |  -quoteNotional for aggressive sell
                |   0 (tracked separately) when side is unknown
CVD(t)          = Σ signedNotional over rolling window (10s / 30s / 1m / 5m)
thresholds      = percentile-based (normal / large / exceptional) from recent history; manual override option
visualPosition  = clamp((price - anchorPrice) / visiblePriceRange, -1, 1)
```

- Anchor price recenters **gradually** as price approaches the map boundary — no teleporting unless the user resets the camera.
- All visual inputs clamped to safe ranges; wall threshold and volume windows configurable.
- CVD is hidden / marked *unavailable* when aggressor side cannot be determined reliably.

## 7. Battlefield rendering (spec §10–11)

- Isometric / slightly tilted top-down battlefield; terrain bands = price levels.
- Resting bids → Bull defensive formations/fortifications; resting asks → Bear defensive formations/fortifications.
- Aggressive buys → Bull attacks toward ask side; aggressive sells → Bear attacks toward bid side.
- Large trades → labelled **large-trade / pressure events** (never liquidations). Cancelled walls retreat/fade — never explode.
- Instanced meshes + pooled particles + shared materials + LOD + capped unit counts; **no 3D object per order**.
- Non-graphic, family-friendly; effects intensity setting: Minimal (default) / Standard / Cinematic; reduced-motion disables shake, cuts particles, replaces flashes with pulses, preserves information.

## 8. UI composition (spec §12)

Top bar (app name, provider, symbol, instrument type, mode badge, live/delayed/replay/stale/simulated, last update, health, disclaimer) · Market panel (last, best bid/ask, spread, midpoint, rolling volume, imbalance, CVD-when-valid, freshness, latency) · Depth panel (aggregated depth chart, level filters, visible range, wall threshold, notional/base toggle) · Event feed (large trades, wall add/remove, provider changes, reconnects, stale warnings) · Controls (provider/symbol selectors, single vs aggregated, live/replay/simulation, effects intensity, units vs abstract, volume/CVD windows, wall threshold, audio, reduced motion, colour-blind palette, camera reset, pause-rendering vs pause-data — clearly distinguished) · Camera (orbit, scroll zoom, WASD/arrows, touch, reset, follow-price toggle; all three modes switchable per preference).

Persistent statement, always visible: **"Educational market visualization only. Not financial advice, not a price forecast, and not a trading signal."**

## 9. Resilience (spec §14)

Auto-reconnect · exponential backoff + jitter · max reconnect interval · heartbeat · stale detection · sequence-gap recovery · provider failover · browser offline detection (`online`/`offline`) · rate-limit handling · circuit breaker · bounded queues · event deduplication · clock-skew awareness (server-timestamped events vs local wall clock) · graceful degradation · structured logging (sanitized) · user-visible health status.

## 10. Security & privacy (spec §15)

- No secrets in client bundles; env vars validated at gateway startup; `.env.example` with placeholders.
- Gateway: origin checks on WS upgrade, rate limits on proxy endpoints, sanitized logs (no secrets/full auth headers), wss in production.
- Restrictive Content Security Policy (connect-src to own origin only).
- No wallet / exchange-account / brokerage credentials anywhere; no user tracking; dependency + provider attribution documented.

## 11. Performance budgets (spec §16)

- 60 FPS desktop under normal load; graceful ≥30 FPS low-power; auto quality levels High/Medium/Low/Battery-saver.
- Bounded: ≤ 4,000 instanced units, ≤ 2,000 pooled particles, event ring buffer ≤ 5,000 events, depth top-N cap.
- Visual cadence 12 Hz; metrics: frame time, draw calls, active unit count, queue depth, dropped visual updates, market-message rate, memory, reconnect count (diagnostics panel).

## 12. Acceptance criteria (Stage 2 gate)

1. A normalized pipeline runs end-to-end from at least one adapter (live, replay, or simulation) to a visible battlefield — no UI rendering from raw messages.
2. Order-book reconstruction passes unit tests for: snapshot load, buffered deltas, insert/update/delete, out-of-order events, sequence gaps, duplicates, reconnect resync. Correctness mechanisms (verified 2026-08-13): Binance spot = `U`/`u`/`lastUpdateId` sequence protocol (no checksums on spot streams); Kraken v2 = CRC32 checksum over top-10 levels (optional periodic validation).
3. Analytics passes unit tests for: BBO/spread/midpoint, imbalance, signed notional, CVD windows, percentile thresholds, unknown-side handling.
4. Fallback chain transitions are unit-tested with deterministic fixtures (primary fail → secondary ok → REST → stale → replay → simulation → recovery).
5. The active mode, provider, symbol, and staleness are always visible; simulation/replay/reference modes are never mislabelled.
6. Reduced-motion, colour-blind palette, keyboard controls, screen-reader summaries work; persistent disclaimer renders.
7. No secrets in the client bundle (CI check: grep for env patterns in `apps/web` output).
8. `docker compose up --build` runs web + gateway; app functional against replay/simulation out of the box (no keys required).
