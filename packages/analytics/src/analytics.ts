import type {
  AggressorSide,
  BookLevel,
  ReferencePriceEvent,
  TradeEvent,
} from '@gb/market-types';
import {
  ACTIVITY_SATURATION_TPS,
  ACTIVITY_WINDOW_MS,
  DEFAULT_CVD_WINDOW_MS,
  EVENT_RING_MAX,
  EXCEPTIONAL_TRADE_DEFAULT_USD,
  LARGE_TRADE_DEFAULT_USD,
  QUIET_AFTER_MS,
  THRESHOLD_MIN_SAMPLES,
  THRESHOLD_SAMPLE_SIZE,
  VOLUME_WINDOWS_MS,
  clamp,
} from '@gb/shared-config';

export interface CvdReading {
  available: boolean;
  value: number;
}

export interface MarketMetrics {
  lastPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  spread: number | null;
  bidDepthNotional: number;
  askDepthNotional: number;
  /** (bidDepth - askDepth) / (bidDepth + askDepth); descriptive, not predictive. */
  imbalance: number;
  volumesMs: Record<number, number>;
  /** CVD over DEFAULT_CVD_WINDOW_MS; marked unavailable when trade side is unknown. */
  cvd: CvdReading;
  /** CVD per rolling window, so the HUD label can never disagree with the number. */
  cvdByWindow: Record<number, CvdReading>;
  lastTradeAt: number | null;
  lastEventAt: number;
  largeTradeCount: number;
  /** Aggressor side of the most recent classified trade (drives the charge direction). */
  lastTradeSide: AggressorSide | null;
  lastTradeNotional: number | null;
  /** Executed trades per second over ACTIVITY_WINDOW_MS. */
  tradesPerSecond: number;
  /** tradesPerSecond normalized to 0..1 for visual pacing. */
  activity: number;
  /** True when no executed trade has arrived for QUIET_AFTER_MS. */
  quiet: boolean;
  msSinceLastTrade: number | null;
}

export type TradeClass = 'normal' | 'large' | 'exceptional';

/**
 * Analytics engine (spec §9): BBO/spread/midpoint from the reconstructed book,
 * depth imbalance, signed notional, CVD, rolling volumes, and percentile-based
 * trade-size thresholds. Purely descriptive — never a forecast.
 */
export class AnalyticsEngine {
  private trades: TradeEvent[] = [];
  private notionalSamples: number[] = [];
  private lastPrice: number | null = null;
  /**
   * BBO is tracked separately by origin. A reconstructed order book is the
   * authoritative quote for the venue on screen; a reference-price feed is the
   * MODE D fallback for when there is no book at all. Letting reference quotes
   * overwrite book quotes put one venue's ticker on top of another venue's
   * ladder, so the panel disagreed with the depth it was showing.
   */
  private bookBestBid: number | null = null;
  private bookBestAsk: number | null = null;
  private refBid: number | null = null;
  private refAsk: number | null = null;
  private refMidpoint: number | null = null;
  private topBids: BookLevel[] = [];
  private topAsks: BookLevel[] = [];
  private lastEventAt = 0;
  private lastTradeAt: number | null = null;
  private largeTradeCount = 0;
  private lastTradeSide: AggressorSide | null = null;
  private lastTradeNotional: number | null = null;

  /**
   * Ingests an executed trade and returns its size classification. The caller
   * gets the class back rather than re-deriving it, so the "large trade"
   * counter and the visual effect can never disagree.
   */
  onTrade(trade: TradeEvent): TradeClass {
    this.trades.push(trade);
    if (this.trades.length > EVENT_RING_MAX) this.trades.shift();
    this.lastPrice = trade.price;
    this.lastTradeAt = trade.timestamp;
    this.lastEventAt = trade.timestamp;
    this.lastTradeSide = trade.aggressorSide;
    this.lastTradeNotional = trade.quoteNotional;

    const notional = Math.abs(trade.quoteNotional);
    this.notionalSamples.push(notional);
    if (this.notionalSamples.length > THRESHOLD_SAMPLE_SIZE) this.notionalSamples.shift();

    const maxWindow = Math.max(...VOLUME_WINDOWS_MS);
    const cutoff = trade.timestamp - maxWindow;
    while (this.trades.length > 0 && this.trades[0]!.timestamp < cutoff) this.trades.shift();

    const classification = this.classifyNotional(notional);
    if (classification !== 'normal') this.largeTradeCount += 1;
    return classification;
  }

  onBook(snap: {
    bestBid: number | null;
    bestAsk: number | null;
    bids: BookLevel[];
    asks: BookLevel[];
  }): void {
    this.bookBestBid = snap.bestBid;
    this.bookBestAsk = snap.bestAsk;
    this.topBids = snap.bids;
    this.topAsks = snap.asks;
    if (snap.bestBid != null && snap.bestAsk != null) this.lastEventAt = Date.now();
  }

  onReference(ref: ReferencePriceEvent): void {
    if (ref.bid != null) this.refBid = ref.bid;
    if (ref.ask != null) this.refAsk = ref.ask;
    if (ref.midpoint != null) this.refMidpoint = ref.midpoint;
    if (ref.midpoint != null && this.lastPrice == null) this.lastPrice = ref.midpoint;
    this.lastEventAt = Math.max(this.lastEventAt, ref.timestamp);
  }

  snapshot(now = Date.now()): MarketMetrics {
    // The reconstructed book wins whenever it has a quote; reference feeds fill
    // in only where there is no book (MODE D) — never on top of one.
    const bestBid = this.bookBestBid ?? this.refBid;
    const bestAsk = this.bookBestAsk ?? this.refAsk;
    const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
    const midpoint =
      bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : this.refMidpoint;
    const bidDepth = this.topBids.reduce((sum, l) => sum + l.price * l.quantity, 0);
    const askDepth = this.topAsks.reduce((sum, l) => sum + l.price * l.quantity, 0);
    const imbalance = bidDepth + askDepth > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0;

    // One pass per window for volume + signed notional, so the CVD readout is
    // always over the window its label claims (spec §9).
    const volumesMs: Record<number, number> = {};
    const cvdByWindow: Record<number, CvdReading> = {};
    for (const window of VOLUME_WINDOWS_MS) {
      const cutoff = now - window;
      let volume = 0;
      let signed = 0;
      let anyKnown = false;
      for (const trade of this.trades) {
        if (trade.timestamp < cutoff) continue;
        volume += trade.baseQuantity;
        if (trade.aggressorSide === 'buy') {
          signed += trade.quoteNotional;
          anyKnown = true;
        } else if (trade.aggressorSide === 'sell') {
          signed -= trade.quoteNotional;
          anyKnown = true;
        }
        // 'unknown' side: counted in volume, excluded from CVD (spec §8/§9).
      }
      volumesMs[window] = volume;
      cvdByWindow[window] = { available: anyKnown, value: signed };
    }

    let recentTrades = 0;
    const activityCutoff = now - ACTIVITY_WINDOW_MS;
    for (const trade of this.trades) {
      if (trade.timestamp >= activityCutoff) recentTrades += 1;
    }
    const tradesPerSecond = recentTrades / (ACTIVITY_WINDOW_MS / 1000);
    const msSinceLastTrade = this.lastTradeAt == null ? null : Math.max(0, now - this.lastTradeAt);

    return {
      lastPrice: this.lastPrice,
      bestBid,
      bestAsk,
      midpoint,
      spread,
      bidDepthNotional: bidDepth,
      askDepthNotional: askDepth,
      imbalance,
      volumesMs,
      cvd: cvdByWindow[DEFAULT_CVD_WINDOW_MS] ?? { available: false, value: 0 },
      cvdByWindow,
      lastTradeAt: this.lastTradeAt,
      lastEventAt: this.lastEventAt,
      largeTradeCount: this.largeTradeCount,
      lastTradeSide: this.lastTradeSide,
      lastTradeNotional: this.lastTradeNotional,
      tradesPerSecond,
      activity: clamp(tradesPerSecond / ACTIVITY_SATURATION_TPS, 0, 1),
      quiet: msSinceLastTrade == null || msSinceLastTrade > QUIET_AFTER_MS,
      msSinceLastTrade,
    };
  }

  /** Percentile-based classification; falls back to absolute defaults until enough samples. */
  classifyNotional(notional: number): TradeClass {
    const absolute = Math.abs(notional);
    if (this.notionalSamples.length >= THRESHOLD_MIN_SAMPLES) {
      const sorted = [...this.notionalSamples].sort((a, b) => a - b);
      const p90 = percentile(sorted, 0.9);
      const p99 = percentile(sorted, 0.99);
      if (absolute >= p99) return 'exceptional';
      if (absolute >= p90) return 'large';
      return 'normal';
    }
    if (absolute >= EXCEPTIONAL_TRADE_DEFAULT_USD) return 'exceptional';
    if (absolute >= LARGE_TRADE_DEFAULT_USD) return 'large';
    return 'normal';
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[index]!;
}
