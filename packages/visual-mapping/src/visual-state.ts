import type { MarketMetrics } from '@gb/analytics';
import type { AggressorSide, BookLevel, FeedEntry } from '@gb/market-types';
import {
  CAP_NOTIONAL,
  EFFECT_LIFE_MS,
  MAX_PRICE_RANGE,
  RANGE_GROW_RATE,
  RANGE_PADDING,
  RANGE_SHRINK_RATE,
  RECENTER_EDGE_FRACTION,
  REF_NOTIONAL,
  TRAIL_MAX,
  VISIBLE_PRICE_RANGE,
  WALL_DISMANTLE_MS,
  WALL_THRESHOLD_USD,
  clamp,
} from '@gb/shared-config';

/**
 * How a fortification is currently behaving.
 *  - `holding`     — the level is still resting in the book;
 *  - `overrun`     — the level vanished while trades were printing at/through
 *                    its price, so it was most likely consumed;
 *  - `withdrawn`   — the level vanished with no trade near it, so the resting
 *                    orders were most likely cancelled.
 *
 * `overrun` vs `withdrawn` is an *inference*, not provider-reported fact: an
 * order book only tells us a level disappeared, never why (spec §8). The UI
 * words both cases carefully and never calls either one a liquidation.
 */
export type WallPhase = 'holding' | 'overrun' | 'withdrawn';

export interface Wall {
  /** Stable across frames so the renderer can pool meshes instead of remounting. */
  id: string;
  side: 'bid' | 'ask';
  price: number;
  x: number;
  notional: number;
  strength: number;
  /** Epoch ms when the level first crossed the wall threshold (build-up animation). */
  bornAt: number;
  phase: WallPhase;
  /** Epoch ms when the level left the book; null while holding. */
  leftAt: number | null;
}

export type EffectKind = 'charge' | 'impact' | 'wall-break';

export interface VisualEffect {
  id: number;
  kind: EffectKind;
  side: AggressorSide;
  price: number;
  x: number;
  /** 0..1 — drives radius, particle count, and SFX gain. */
  magnitude: number;
  /**
   * Epoch milliseconds (`Date.now()`). The renderer ages effects against the
   * same clock; mixing `Date.now()` here with `performance.now()` there is what
   * previously froze every effect at age zero.
   */
  t0: number;
  lifeMs: number;
}

export interface PriceTick {
  price: number;
  x: number;
  /** Every 5th tick is a major band, labelled in the scene. */
  major: boolean;
}

export interface DepthSlice {
  bids: BookLevel[];
  asks: BookLevel[];
}

/**
 * What the front line is currently showing. A stale last trade is not the
 * current price, so the line falls back to the book midpoint and says so
 * rather than parking the battle at a price that no longer exists.
 */
export type PriceSource = 'last-trade' | 'midpoint' | null;

export interface VisualState {
  /** Price-line x position in [-1, 1] (battlefield coordinates). */
  priceLineX: number;
  priceSource: PriceSource;
  bestBidX: number | null;
  bestAskX: number | null;
  /** 0..1 formation strengths derived from resting depth (log1p scaling). */
  bidStrength: number;
  askStrength: number;
  imbalance: number;
  anchor: number;
  range: number;
  lastPrice: number | null;
  /** Fortifications where a price level exceeds the wall threshold. */
  walls: Wall[];
  /** Active effects with battlefield x + lifetime. */
  effects: VisualEffect[];
  /** Price ladder for terrain bands and in-scene labels. */
  ticks: PriceTick[];
  /** Recent price-line positions, oldest first — the scar the front line leaves. */
  trail: number[];
  /** -1..1 smoothed order-flow push; leans the armies toward the pressure. */
  momentum: number;
  /** 0..1 executed-trade rate; paces marching and dust. */
  activity: number;
  /** True when no trade has printed for a while — units stand down honestly. */
  quiet: boolean;
  msSinceLastTrade: number | null;
}

const MAX_EFFECTS = 24;
const MAX_WALLS = 16;
const MOMENTUM_SMOOTHING = 0.12;
/** One trail sample every 500 ms → TRAIL_MAX covers a full minute of history. */
const TRAIL_SAMPLE_MS = 500;

const strengthOf = (notional: number): number =>
  clamp(Math.log1p(notional / REF_NOTIONAL) / Math.log1p(CAP_NOTIONAL / REF_NOTIONAL), 0, 1);

/**
 * Maps market state → stable battlefield coordinates (spec §9):
 *   visualPosition = clamp((price - anchor) / visiblePriceRange, -1, 1)
 * The anchor recenters gradually when price approaches the map boundary —
 * no teleporting unless the user resets the camera.
 */
export class VisualMapper {
  private anchor: number | null = null;
  private effects: VisualEffect[] = [];
  private nextEffectId = 1;
  private walls = new Map<string, Wall>();
  /**
   * Stored as prices, not battlefield coordinates: the anchor and the range
   * both move, so a normalized sample recorded earlier would end up marking a
   * price the front line never visited.
   */
  private trailPrices: number[] = [];
  private lastTrailAt = 0;
  private momentum = 0;
  private pendingFeed: FeedEntry[] = [];
  /** Trade prices seen since the previous update, used to explain vanished walls. */
  private recentTradePrices: Array<{ price: number; ts: number }> = [];

  constructor(
    private range = VISIBLE_PRICE_RANGE,
    private readonly recenterRate = 0.25,
    private wallThresholdUsd = WALL_THRESHOLD_USD,
    private readonly minRange = VISIBLE_PRICE_RANGE,
  ) {}

  /**
   * Changes what counts as a wall. Tracked fortifications are dropped so the
   * next reconcile rebuilds them against the new threshold instead of leaving
   * stale walls standing.
   */
  setWallThreshold(usd: number): void {
    if (!Number.isFinite(usd) || usd <= 0 || usd === this.wallThresholdUsd) return;
    this.wallThresholdUsd = usd;
    this.walls.clear();
  }

  /** Register a large-trade "pressure event" — never called a liquidation (spec §8). */
  addLargeTradeEffect(side: AggressorSide, price: number, nowMs: number, magnitude = 0.6): void {
    this.pushEffect('charge', side, price, nowMs, magnitude);
    this.pushEffect('impact', side, price, nowMs, magnitude);
  }

  /** Record every executed trade price so wall disappearances can be explained. */
  noteTrade(price: number, nowMs: number): void {
    this.recentTradePrices.push({ price, ts: nowMs });
    if (this.recentTradePrices.length > 256) this.recentTradePrices.shift();
  }

  /** Feed entries generated by the mapper (wall added / overrun / withdrawn). */
  drainFeed(): FeedEntry[] {
    const out = this.pendingFeed;
    this.pendingFeed = [];
    return out;
  }

  xForPrice(price: number): number {
    const anchor = this.anchor ?? price;
    return clamp((price - anchor) / this.range, -1, 1);
  }

  update(metrics: MarketMetrics, depth: DepthSlice, dtMs: number, nowMs: number): VisualState {
    /**
     * The front line follows the last executed trade — but only while that
     * trade is still current. On a thin venue (or in aggregated mode, where
     * trades arrive from venues the book does not come from) the last print can
     * be minutes old and dollars away from the live quotes, which detached the
     * front line from the armies defending it.
     */
    const tradePriceUsable = metrics.lastPrice != null && !metrics.quiet;
    const price = tradePriceUsable ? metrics.lastPrice : (metrics.midpoint ?? metrics.lastPrice);
    const priceSource: PriceSource =
      price == null ? null : tradePriceUsable ? 'last-trade' : metrics.midpoint != null ? 'midpoint' : 'last-trade';

    // The map always centres on the live book when there is one.
    const reference = metrics.midpoint ?? price;

    if (reference != null) {
      if (this.anchor == null) this.anchor = reference;
      this.adaptRange(metrics, depth, price, dtMs);

      const edge = this.range * RECENTER_EDGE_FRACTION;
      const offset = reference - this.anchor;
      if (Math.abs(offset) > edge) {
        const excess = (Math.abs(offset) - edge) * Math.sign(offset);
        this.anchor += excess * clamp(dtMs / 2000, 0, 1) * this.recenterRate;
      }
    }

    const toX = (p: number | null): number | null =>
      p == null || this.anchor == null ? null : clamp((p - this.anchor) / this.range, -1, 1);

    // Short-window signed flow → smoothed lean. Descriptive only (spec §8).
    const shortCvd = metrics.cvdByWindow[10_000];
    const target =
      shortCvd?.available === true
        ? clamp(Math.sign(shortCvd.value) * strengthOf(Math.abs(shortCvd.value)), -1, 1)
        : 0;
    this.momentum += (target - this.momentum) * MOMENTUM_SMOOTHING;

    const priceLineX = price == null ? 0 : toX(price)!;
    // Sampled on a slow cadence so TRAIL_MAX covers a useful stretch of history
    // rather than the last few seconds of frames.
    if (price != null && nowMs - this.lastTrailAt >= TRAIL_SAMPLE_MS) {
      this.lastTrailAt = nowMs;
      this.trailPrices.push(price);
      if (this.trailPrices.length > TRAIL_MAX) this.trailPrices.shift();
    }

    this.reconcileWalls(depth, nowMs, toX);
    this.pruneTradePrices(nowMs);

    return {
      priceLineX,
      priceSource,
      bestBidX: toX(metrics.bestBid),
      bestAskX: toX(metrics.bestAsk),
      bidStrength: strengthOf(metrics.bidDepthNotional),
      askStrength: strengthOf(metrics.askDepthNotional),
      imbalance: metrics.imbalance,
      anchor: this.anchor ?? 0,
      range: this.range,
      lastPrice: price,
      walls: [...this.walls.values()].slice(0, MAX_WALLS),
      effects: this.liveEffects(nowMs),
      ticks: this.buildTicks(),
      trail: this.trailPrices.map((p) => this.xForPrice(p)),
      momentum: this.momentum,
      activity: metrics.activity,
      quiet: metrics.quiet,
      msSinceLastTrade: metrics.msSinceLastTrade,
    };
  }

  /**
   * Widens the half-map so everything worth seeing fits: the visible depth
   * ladder, top-of-book, and the last trade. Never narrows below `minRange`.
   */
  private adaptRange(
    metrics: MarketMetrics,
    depth: DepthSlice,
    price: number | null,
    dtMs: number,
  ): void {
    if (this.anchor == null) return;

    let span = 0;
    const consider = (value: number | null | undefined): void => {
      if (value == null || !Number.isFinite(value)) return;
      span = Math.max(span, Math.abs(value - this.anchor!));
    };

    consider(price);
    consider(metrics.bestBid);
    consider(metrics.bestAsk);
    // Only the levels that actually get drawn need to fit on the map.
    consider(depth.bids[depth.bids.length - 1]?.price);
    consider(depth.asks[depth.asks.length - 1]?.price);

    const target = clamp(Math.max(this.minRange, span * RANGE_PADDING), this.minRange, MAX_PRICE_RANGE);
    const rate = target > this.range ? RANGE_GROW_RATE : RANGE_SHRINK_RATE;
    this.range += (target - this.range) * clamp((dtMs / 1000) * rate * 12, 0, 1);
  }

  private pushEffect(
    kind: EffectKind,
    side: AggressorSide,
    price: number,
    nowMs: number,
    magnitude: number,
  ): void {
    this.effects.push({
      id: this.nextEffectId++,
      kind,
      side,
      price,
      x: this.xForPrice(price),
      magnitude: clamp(magnitude, 0, 1),
      t0: nowMs,
      lifeMs: EFFECT_LIFE_MS[kind],
    });
    while (this.effects.length > MAX_EFFECTS) this.effects.shift();
  }

  /**
   * Diffs the current book against the tracked fortifications so walls keep a
   * stable identity, animate their build-up, and dismantle (never explode)
   * when the resting orders go away (spec §10).
   */
  private reconcileWalls(
    depth: DepthSlice,
    nowMs: number,
    toX: (p: number | null) => number | null,
  ): void {
    const seen = new Set<string>();

    const ingest = (levels: BookLevel[], side: 'bid' | 'ask'): void => {
      for (const level of levels.slice(0, 20)) {
        const notional = level.price * level.quantity;
        if (notional < this.wallThresholdUsd) continue;
        const id = `${side}@${level.price}`;
        seen.add(id);
        const existing = this.walls.get(id);
        if (existing == null) {
          this.walls.set(id, {
            id,
            side,
            price: level.price,
            x: toX(level.price) ?? 0,
            notional,
            strength: strengthOf(notional),
            bornAt: nowMs,
            phase: 'holding',
            leftAt: null,
          });
          this.pendingFeed.push({
            kind: 'wall-add',
            text: `${side === 'bid' ? 'Buy' : 'Sell'} wall formed at $${level.price.toFixed(2)} — ${formatUsd(notional)} resting`,
            ts: nowMs,
          });
        } else {
          existing.notional = notional;
          existing.strength = strengthOf(notional);
          existing.x = toX(level.price) ?? existing.x;
          // A wall that came back before finishing its dismantle keeps holding.
          existing.phase = 'holding';
          existing.leftAt = null;
        }
      }
    };

    ingest(depth.bids, 'bid');
    ingest(depth.asks, 'ask');

    for (const wall of [...this.walls.values()]) {
      wall.x = toX(wall.price) ?? wall.x;
      if (seen.has(wall.id)) continue;

      if (wall.leftAt == null) {
        wall.leftAt = nowMs;
        wall.phase = this.tradedThrough(wall) ? 'overrun' : 'withdrawn';
        this.pendingFeed.push({
          kind: 'wall-remove',
          text:
            wall.phase === 'overrun'
              ? `${wall.side === 'bid' ? 'Buy' : 'Sell'} wall at $${wall.price.toFixed(2)} overrun — trades printed through it`
              : `${wall.side === 'bid' ? 'Buy' : 'Sell'} wall at $${wall.price.toFixed(2)} withdrawn — orders cancelled, no trade there`,
          ts: nowMs,
        });
        if (wall.phase === 'overrun') {
          this.pushEffect(
            'wall-break',
            wall.side === 'bid' ? 'sell' : 'buy',
            wall.price,
            nowMs,
            wall.strength,
          );
        }
      } else if (nowMs - wall.leftAt > WALL_DISMANTLE_MS) {
        this.walls.delete(wall.id);
      }
    }
  }

  /**
   * Heuristic (never presented as fact): did trades print at or beyond this
   * level while it was in the book? A bid wall is overrun by trades at or below
   * its price, an ask wall by trades at or above it.
   */
  private tradedThrough(wall: Wall): boolean {
    for (const trade of this.recentTradePrices) {
      if (wall.side === 'bid' ? trade.price <= wall.price : trade.price >= wall.price) return true;
    }
    return false;
  }

  private pruneTradePrices(nowMs: number): void {
    const cutoff = nowMs - 2_000;
    while (this.recentTradePrices.length > 0 && this.recentTradePrices[0]!.ts < cutoff) {
      this.recentTradePrices.shift();
    }
  }

  /** Price ladder covering the visible range, snapped to a readable step. */
  private buildTicks(): PriceTick[] {
    if (this.anchor == null) return [];
    const step = niceStep(this.range * 2, 10);
    const first = Math.ceil((this.anchor - this.range) / step) * step;
    const out: PriceTick[] = [];
    for (let price = first; price <= this.anchor + this.range + 1e-9; price += step) {
      const rounded = Math.round(price / step) * step;
      out.push({
        price: rounded,
        x: clamp((rounded - this.anchor) / this.range, -1, 1),
        major: Math.abs(Math.round(rounded / step) % 5) === 0,
      });
      if (out.length > 64) break;
    }
    return out;
  }

  private liveEffects(nowMs: number): VisualEffect[] {
    this.effects = this.effects.filter((effect) => nowMs - effect.t0 < effect.lifeMs);
    // Re-derive x every frame so effects stay anchored to their price while the
    // map recenters, instead of drifting away from where they happened.
    return this.effects.map((effect) => ({ ...effect, x: this.xForPrice(effect.price) }));
  }
}

function niceStep(totalRange: number, targetCount: number): number {
  const raw = totalRange / Math.max(1, targetCount);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const snapped = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return snapped * magnitude;
}

function formatUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}k`;
  return `$${value.toFixed(0)}`;
}
