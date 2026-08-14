# Stage 5 — Production Hardening

**Status:** ✅ Delivered 2026-08-13. This document is the operational companion to the architecture (docs/03) and provider matrix (docs/02). Every item below is either implemented in the repository or explicitly flagged as a deployment-time task.

---

## 1. Security checklist (spec §15 · deliverable 18)

| # | Control | Status | Where |
|---|---|---|---|
| 1 | No secret keys in client bundles | ✅ enforced | `npm run check:secrets` scans the built bundle + web source for secret patterns and provider env-var names; exit code 1 on findings. Run after every `vite build`. |
| 2 | Env vars validated at startup | ✅ | Gateway `env.ts` (Zod): invalid config fails loudly at boot. |
| 3 | All external messages validated | ✅ | Every WS event passes `parseMarketEvent` (Zod); malformed events are counted + logged sanitized, never crash the loop. |
| 4 | Origin controls on the backend WebSocket | ✅ | `server.on('upgrade')` rejects non-allowed origins with 403; `ALLOWED_ORIGINS` env (`*` or comma list). |
| 5 | Rate limits on proxy endpoints | ✅ | Per-IP WS upgrade limit (60 / 10 s window, configurable constants in `apps/gateway/src/index.ts`); 429 on exceed. |
| 6 | Sanitized logs | ✅ | `log.ts` never logs secrets or full authorization headers; no payloads logged. |
| 7 | Secure WebSockets in production | ⚠️ deployment | Behind TLS (reverse proxy / platform TLS), use `wss://`. The app itself only ever uses `ws(s)://` relative to its origin. |
| 8 | Restrictive Content Security Policy | ✅ | nginx config: `default-src 'self'`, `script-src 'self'`, `worker-src 'self' blob:`, `connect-src 'self' ws: wss:`, `frame-ancestors 'none'`, `object-src 'none'`, etc. Dev (Vite) intentionally has no CSP. |
| 9 | Security headers | ✅ | nginx + gateway `/health`: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (no camera/mic/geolocation). |
| 10 | No unnecessary tracking | ✅ | No analytics SDK, no cookies, no fingerprinting, no third-party error service. |
| 11 | No wallet / brokerage credentials | ✅ | The app cannot trade; no credential fields exist anywhere. |
| 12 | Dependency + provider attribution | ✅ | See §8 and docs/02; `.env.example` ships placeholders only. |

## 2. Accessibility checklist (deliverable 19)

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Reduced-motion mode | ✅ | Disables camera damping/shake, cuts particle/effect opacity, replaces flashes with pulses, preserves information; e2e-verified. |
| 2 | Colour-blind palette | ✅ | Blue/orange army + line palette toggle (controls). |
| 3 | Keyboard controls | ✅ | Full tab order, native selects/buttons/checkboxes; camera supports standard pointer + WASD/arrow panning via OrbitControls. |
| 4 | Screen-reader summaries | ✅ | `role="status"` badges (connection state), `aria-label`s on controls, `role="alert"` on renderer errors; the persistent disclaimer is plain text. |
| 5 | Contrast & text sizing | ✅ | High-contrast dark theme; relative `rem` sizing in `styles.css`; badges differentiate by color AND text. |
| 6 | Focus visibility | ✅ | Native focus rings retained in the CSS reset. |
| 7 | Reduced-motion + minimal effects default | ✅ | `effectsIntensity` defaults to `minimal`; reduced-motion off by default but one click away. |

## 3. Performance checklist + measured results (spec §16 · deliverable 20)

**Budgets:** 60 FPS desktop · ≥ 30 FPS graceful degradation · bounded units/particles/events · networking off the render path.

| # | Budget | Status | Where / result |
|---|---|---|---|
| 1 | 60 FPS desktop | ✅ | Instanced armies (≤ 600×2 units), pooled effects, shared materials. Live-probed in the soak tests (pipeline-side); the browser probe measures FPS/frame time/draw calls in the top bar. |
| 2 | ≥ 30 FPS low-power | ✅ | Auto-quality: FPS probe (2 s samples, hysteresis) steps High→Medium→Low→Battery-saver, scaling unit caps (600/450/300/180) and pixel-ratio caps ([1,2]/[1,1.5]/[1,1.25]/[0.75,1]). Manual override in Controls. |
| 3 | Bounded units/particles | ✅ | `UNIT_CAP` 4 000 / `PARTICLE_CAP` 2 000 in shared-config; scene uses quality-scaled caps below those. |
| 4 | Bounded event history | ✅ | Analytics ring ≤ 5 000 events; UI feed capped at 60 entries; depth top-N capped. |
| 5 | Visual cadence decoupled from network | ✅ | 12 Hz visual-state aggregation in the worker; networking in the gateway + worker; rendering consumes visual state only. |
| 6 | Code-split vendor bundle | ✅ | `manualChunks` splits three/drei/fiber, react, zustand; the 3D engine loads as a separate cacheable chunk. |
| 7 | Measured metrics | ✅ | Top bar shows FPS · frame time · draw calls · active units · quality level. Soak/verify scripts report gaps, resyncs, crossed books, staleness, depth bounds. |
| 8 | Context-loss recovery | ✅ | R3F/Three default context-loss handling; ErrorBoundary isolates renderer failures. |

**Measured (2026-08-13):** Binance soak 200 s across 6 forced reconnects — 0 gaps, 0 resyncs, 0 crossed books, depth bounded at 400 levels, staleness ≤ 1.2 s. Gemini 45 s forced-reconnect run — 0 resyncs. Coinbase/Bitstamp reconnects — 0 resyncs. Production build: three.js in its own chunk; main bundle substantially smaller (see `vite build` output).

## 4. Data-integrity limitations (deliverable 17)

Everything below is honest, documented, and never hidden from the user:

1. **Kraken checksum not validated on the live feed.** The live v2 feed transmits numeric price/qty; its CRC32 could not be reproduced from the documented string algorithm (0/30+ variants). The adapter emits **full-state snapshots per book message** (integrity by construction) instead of faking validation. The doc-verified algorithm remains unit-tested against the official example.
2. **Coinbase deltas have no sequence numbers.** Gap detection is unavailable; reconnect = full resync from a fresh snapshot.
3. **Bitstamp diffs have no sequence numbers.** Mitigated by a periodic full-book REST resync every 5 minutes + fresh snapshot on reconnect. Drift between resyncs is theoretically possible and self-heals.
4. **Gemini `socket_sequence` counts all socket messages** — the `heartbeat=true` param causes false gaps, so the adapter connects without it (verified: 0 gaps over 195 updates).
5. **PAXG/XAUT are thin markets.** Wide spreads (Gemini ~$25, Bitstamp ~$2) are real data, not artifacts. Low trade volume means CVD is often honestly unavailable — it is hidden, never fabricated.
6. **Tokenized-gold basis risk.** PAXG/XAUT trade at a premium/discount to spot XAU/USD; the UI labels them "tokenized-gold proxy market", never as spot XAU/USD.
7. **Swissquote is a polled reference (MODE D).** `isDelayed: true`; never called real-time; stale detection after 3 failed polls.
8. **Liquidations are never shown.** No provider in scope reports spot-gold liquidations; large trades are labelled "large-trade events", not liquidations.
9. **Order-book imbalance and CVD are descriptive, not predictive.** The UI never presents them as signals.

## 5. Troubleshooting guide (deliverable 16)

| Symptom | Cause / check | Fix |
|---|---|---|
| Gateway exits at boot | Missing/invalid env | Copy `apps/gateway/.env.example` → `.env`; check `npm run dev:gateway` logs (Zod prints the offending var). |
| Web UI shows "simulation" unexpectedly | All live providers unreachable → fallback chain ends at simulation | Check `ALLOWED_ORIGINS` (must include your origin or `*`); check outbound network; check the event feed for "Falling back: …" entries. |
| Binance 451 / geo-blocked | Deployment region is restricted (US/CA/NL/sanctioned) | Run the gateway in a permitted region; the chain (Kraken → Coinbase → Gemini → Bitstamp → …) absorbs it automatically. |
| `npm run check:secrets` fails | A secret pattern or provider env-var name in the client | Search the flagged file; ensure keyed providers stay behind the gateway only. |
| 3D canvas blank, panels fine | WebGL unavailable / context lost | The ErrorBoundary shows a retry; check browser WebGL support and hardware acceleration. |
| High FPS but stutter | Auto-quality still settling | Give it a few 2 s samples; or set quality manually in Controls. |
| E2E tests fail to boot | Ports 8081/5173 busy or Playwright browsers missing | `npm run test:e2e:install` once; kill stale dev servers first. |
| Docker `compose up` won't build | No Docker daemon in this environment | Docker images are written per the verified local setup but were not built here; run `docker compose up --build` where Docker exists. |

## 6. Deployment instructions (deliverable 15)

### Local development
```bash
npm install
npm run dev:gateway   # :8081
npm run dev:web       # :5173 (Vite, no CSP — dev only)
```

### Docker (single host)
```bash
docker compose up --build
# web UI   http://localhost:8080
# gateway  http://localhost:8081/health
```

#### Docker verification (2026-08-13)

No Docker daemon exists in the authoring sandbox (no sudo, no setuid `newuidmap` for rootless mode), so the images could not be **built** here. Instead the exact container build steps and the compose topology were verified by replication:

- ✅ **`npm ci` in a clean context** containing exactly what each Dockerfile copies (root manifests + `packages/` + the app dir) — lockfile is complete for both images.
- ✅ **Gateway runtime in the image context** — boots, `/health` OK, replay mode streams the fixture deterministically.
- ✅ **Web production build in the image context** — identical output to the local build; `VITE_GATEWAY_URL` bakes correctly.
- ✅ **Compose topology end-to-end** — built `dist` served on :8080 with the CSP/security headers, `/ws` proxied to the gateway on :8081 (nginx-equivalent harness): WS connected, simulation label honest, 34 events (11 trades) streamed through the proxy.
- ✅ **Compose YAML validated** — services `web` (8080→80) + `gateway` (8081→8081), correct build contexts/dockerfiles, `depends_on`.

**Two real bugs found and fixed by this verification:**
1. The gateway image did not copy `tests/fixtures` → `defaultFixturePath()` resolved to `''` → replay mode silently fell back to simulation in the container. **Fixed:** `COPY tests/fixtures ./tests/fixtures` in `apps/gateway/Dockerfile`. Demonstrated: without fixtures, replay → "Falling back… (connect failed)"; with them, replay streams.
2. The web image defaulted `VITE_GATEWAY_URL=ws://localhost/ws` (host port 80, which compose does **not** publish — the web service maps to host port 8080). The worker's socket would have refused to connect. **Fixed:** default is now `ws://localhost:8080/ws`; override for real hosts with `docker build --build-arg VITE_GATEWAY_URL=wss://your.host/ws`.

Remaining Docker-specific steps to verify on a real host: base-image pulls (`node:20-alpine`, `nginx:1.27-alpine`), `docker compose up --build` itself, and the nginx `proxy_pass http://gateway:8081` DNS resolution inside the compose network.

### Production notes
- Terminate TLS at your reverse proxy/platform (nginx config is HTTP-only by design) and serve the app over HTTPS so the WS becomes `wss://` (the app connects to `ws(s)://<origin>/ws`, proxied by nginx to the gateway).
- Keep `ALLOWED_ORIGINS` locked to your real origin(s); `*` is for local/trusted networks only.
- The app needs **no secrets**; if a keyed reference provider is ever added, configure it only in the gateway `.env` and re-run `npm run check:secrets` after building.

### Environment variables (gateway)
| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8081` | Gateway listen port |
| `BINANCE_WS_URL` / `BINANCE_REST_URL` | official endpoints | Binance MODE A |
| `KRAKEN_WS_URL` | `wss://ws.kraken.com/v2` | Kraken MODE B |
| `COINBASE_WS_URL` | `wss://ws-feed.exchange.coinbase.com` | Coinbase MODE A |
| `GEMINI_WS_URL` | `wss://api.gemini.com/v1/marketdata/PAXGUSD` | Gemini MODE A/B |
| `BITSTAMP_WS_URL` / `BITSTAMP_REST_URL` | official endpoints | Bitstamp MODE A/B |
| `SWISSQUOTE_URL` / `SWISSQUOTE_POLL_MS` | official BBO endpoint / `5000` | Reference MODE D |
| `ALLOWED_ORIGINS` | `*` | WS origin allow-list |
| `REPLAY_FIXTURE` | auto-resolved | Replay fixture path |
| `BINANCE_FORCE_RECONNECT_MS` | unset | Testing hook: forced reconnects (soak tests) |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## 7. Operational runbook

1. **Health:** `curl <host>:8081/health` → `{"ok":true,...}`.
2. **Monitor:** top-bar badge (state), freshness, FPS/draw calls; event feed for fallback/stale entries; gateway logs for rate-limit/origin warnings.
3. **Failover:** automatic — the chain absorbs provider failures; every transition is a visible feed event. No operator action needed.
4. **Restart:** `docker compose restart gateway` (stateless; sessions reconnect). Clients auto-reconnect via the worker → gateway with backoff.
5. **Drift/regressions:** run `npm run typecheck && npm test && npm run test:e2e` before any release; run `npx tsx scripts/verify-live.ts <mode>` against a running gateway to sanity-check each live feed; `npm run check:secrets` after builds.
6. **Capacity:** one gateway process handles many WS clients; each session owns one adapter (one upstream socket per venue). Multi-tenant scaling is out of scope for this educational app.

## 8. Provider attribution & licensing

| Provider | Instrument | Access | Docs | Notes |
|---|---|---|---|---|
| Binance | PAXG/USDC | keyless REST + WS | developers.binance.com | Display-only; ToS apply; geo-restricted regions 451 |
| Kraken | XAUT/USD | keyless WS v2 | docs.kraken.com | Display-only; ToS apply |
| Coinbase | PAXG-USD | keyless REST + WS | docs.cdp.coinbase.com/exchange | Display-only; ToS apply |
| Gemini | PAXGUSD | keyless REST + WS | docs.gemini.com/websocket-api | Display-only; ToS apply |
| Bitstamp | PAXG/USD | keyless REST + WS | bitstamp.net/websocket/v2 | Display-only; ToS apply |
| Swissquote | XAU/USD BBO | keyless REST poll | forex-data-feed.swissquote.com | Reference only; no SLA |

All data is displayed live and never redistributed. Replay fixtures are self-recorded/deterministic. Third-party packages: Three.js/R3F/drei (MIT), Zustand (MIT), React (MIT), Vite (MIT), Vitest/Playwright (MIT/Apache), Zod (MIT), ws (MIT). Full license texts ship in `node_modules`; this project's own code is MIT.
