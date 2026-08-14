# Visualization pass — bug fixes and the ambient-watching rebuild

This pass reframed the app around how it is actually used: **an ambient live
visualization you leave running and watch**, not a dashboard you operate and not
a game you play. The market is never narrated; the scene is labelled instead.

Product decisions taken for this pass:

| Decision | Choice |
|---|---|
| Visual direction | Stylized low-poly army, fully procedural (no 3D assets) |
| Layout | Cinematic full-bleed canvas, floating HUD, chrome-free TV mode |
| Default data source | Aggregated live across all five gold-token venues |
| Explanation style | In-scene labels + a static legend — no commentary track |
| Audio | Synthesized SFX on large trades and wall breaks only, off by default |
| Target | Desktop / laptop browser |

---

## Correctness bugs fixed

### 1. Effects were frozen at age zero

`VisualMapper` stamped every effect with `Date.now()` (epoch milliseconds) while
the renderer aged it against `performance.now()` (milliseconds since page load).
The computed age was hugely negative, clamped to zero, and the expanding
shockwave never expanded, faded, or expired. Both sides now use the same clock,
and `visual-mapping.test.ts` pins the contract.

### 2. Stale duplicate of every package

`apps/packages/` held a complete second copy of all six packages, four of which
had already diverged from the real ones in `packages/`. Nothing referenced it.
Deleted.

### 3. `largeTradeCount` was always zero

The counter was declared, published in `MarketMetrics`, and never incremented.
`AnalyticsEngine.onTrade` now classifies the trade, increments the counter, and
*returns* the classification so the caller cannot derive a different answer than
the counter did.

### 4. CVD label disagreed with the CVD number

The panel read `CVD (1m)` while the value was summed over the entire retained
trade ring (five minutes). CVD is now computed per rolling window
(`cvdByWindow`), the readout is window-selectable, and the label always names
the window the number came from.

### 5. Order book was never cleared on provider switch

Spec §14 requires that levels from one venue are never merged with another's.
`LocalOrderBook` had no way to drop state, so the previous venue's book stayed
on screen until the next snapshot landed. Added `reset()`, called by the worker
on every mode change.

### 6. Aggregated mode mixed incomparable venues

The book came from one venue while trades were forwarded from all five. When a
venue lagged or quoted in a different unit, its prints landed at prices that did
not exist in the displayed book — the front line detached from the armies by
whole dollars. `isVenueComparable` now excludes a venue whose midpoint drifts
more than 0.2% from the composite, with a visible feed warning. This implements
spec §4's "only aggregate compatible measurements" rather than blending
silently.

### 7. A stale print was presented as the current price

On a thin venue the last trade can be minutes old and dollars away from the live
quotes. The front line parked there. It now falls back to the book midpoint once
the market is quiet and reports which source it is using (`priceSource`), with
the in-scene tag reading `$4352.09 mid`.

### 8. Reference quotes overwrote the reconstructed book

`AnalyticsEngine.onReference` assigned straight into the BBO fields, so a
reference-price ticker replaced the best bid/ask derived from the order book.
In aggregated mode this put one venue's ticker on top of another venue's
ladder: the market panel read `best bid 4334.50` while the depth panel beside
it showed a top bid of `4350.45`. BBO is now tracked by origin — the
reconstructed book always wins, and reference quotes fill in only where there
is no book (MODE D). The composite reference emitted by the aggregated adapter
also no longer carries a bid/ask at all, because there is no such thing as a
composite quote across venues; only the composite midpoint is defensible.

### 9. The price map clamped everything to its edges

`VISIBLE_PRICE_RANGE` was a fixed ±$2 on a ~$4,350 instrument, so any book
deeper than two dollars piled up as one unreadable stack on the boundary. The
half-map is now adaptive: it widens quickly to fit top-of-book, the rendered
depth ladder, and the last trade, and narrows slowly, with ±$2 as the floor.

### 10. The price trail marked prices that never happened

The trail stored battlefield coordinates. Once the anchor recentred or the range
changed, old samples pointed at prices the front line had never visited. It now
stores prices and re-derives coordinates every frame, sampled at 2 Hz so the
buffer covers a full minute.

### 11. Walls remounted on every price shift

Fortifications were keyed by their x position, so React tore down and rebuilt
every mesh whenever the ladder moved. Walls now carry a stable
`${side}@${price}` id, keep their `bornAt` for the build-up animation, and are
diffed frame to frame.

### 12. Merged geometry threw on every mount

`mergeGeometries` rejects a mix of indexed and non-indexed inputs, and three's
polyhedra are non-indexed while its boxes and cylinders are indexed. The soldier
geometry threw on construction and the error boundary swallowed the whole scene.
All parts are normalized to non-indexed before merging.

### 13. HUD overflowed the viewport

`align-items: flex-start` let the side columns grow with their content, so a
long event feed spilled over the battlefield with no panel behind it, and the
disclaimer sat underneath the controls bar. The columns now stretch with
`min-height: 0`, the feed scrolls internally, and the bottom strip is reserved.

---

## Performance fixes

- **Order book re-sorted per message.** `analytics.onBook(book.snapshot())` ran
  on every delta, and `snapshot()` re-sorts both sides whenever the book is
  dirty — O(n log n) per network message. The frame tick now does it once per
  rendered frame.
- **Control bar re-rendered 12×/second.** `useStore` was called with an
  object-literal selector, which returns a new reference on every store tick.
  Replaced with per-field selectors.
- **Army matrices reallocated at 12 Hz.** Six hundred `Matrix4` objects were
  rebuilt through `useMemo` whenever formation strength changed, and units
  teleported between positions. Per-unit state now lives in preallocated typed
  arrays, positions are integrated in `useFrame` with frame-rate-independent
  smoothing, and the hot loop allocates nothing.
- **Effects pooled.** Rings, charge wedges, and debris run on fixed-size pools
  allocated once and hidden when idle, so a burst of large trades cannot spike
  draw calls or GC.
- **Label textures bounded.** Every distinct in-scene string rasterizes a canvas
  and uploads a texture; the cache is a 96-entry LRU that disposes evictions,
  and volatile label text is throttled.

Measured in the headless verification run (software WebGL, no GPU): **30–31 draw
calls** for the full scene with both armies, walls, effects, terrain, and
labels.

---

## Behaviour that was deliberately left honest

- Quiet markets are shown as quiet. When no trade has printed for
  `QUIET_AFTER_MS`, units stand down and the field says `FRONT QUIET · no trades
  for Ns`. The scene never manufactures activity to look busy.
- `overrun` vs `withdrawn` for a vanished wall is an **inference**, not
  provider-reported fact — an order book only reports that a level disappeared,
  never why. Both the code comments and the legend say so, and the wording never
  implies a trade that may not have happened.
- No liquidation effects exist. No spot-gold venue reports liquidations, so the
  app renders none; large trades are called pressure events.
- Cancelled liquidity dismantles and sinks. It never explodes.

---

## Verification

```bash
npm run typecheck   # clean across all workspaces
npm test            # 98 unit tests
npm run test:e2e    # 4 Playwright smoke tests
npm run check:secrets
npm run build
```
