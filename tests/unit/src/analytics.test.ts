import { describe, expect, it } from 'vitest';
import type { TradeEvent } from '@gb/market-types';
import { AnalyticsEngine } from '@gb/analytics';
import { EXCEPTIONAL_TRADE_DEFAULT_USD, LARGE_TRADE_DEFAULT_USD } from '@gb/shared-config';

function trade(overrides: Partial<TradeEvent> = {}): TradeEvent {
  return {
    type: 'trade',
    provider: 'test',
    symbol: 'XAUT/USD',
    instrumentType: 'tokenized-gold-spot',
    timestamp: 1_752_000_000_000,
    tradeId: 't',
    price: 4365,
    baseQuantity: 1,
    quoteNotional: 4365,
    aggressorSide: 'buy',
    isEstimated: false,
    ...overrides,
  };
}

describe('AnalyticsEngine', () => {
  it('computes BBO, spread, and midpoint from the book', () => {
    const engine = new AnalyticsEngine();
    engine.onBook({ bestBid: 10, bestAsk: 11, bids: [], asks: [] });
    const snap = engine.snapshot();
    expect(snap.bestBid).toBe(10);
    expect(snap.bestAsk).toBe(11);
    expect(snap.midpoint).toBe(10.5);
    expect(snap.spread).toBe(1);
  });

  it('never lets a reference quote override a reconstructed book', () => {
    // Regression: in aggregated mode one venue's ticker overwrote the BBO
    // derived from another venue's book, so the market panel disagreed with
    // the depth ladder next to it by whole dollars.
    const engine = new AnalyticsEngine();
    engine.onBook({
      bestBid: 4350.45,
      bestAsk: 4350.87,
      bids: [{ price: 4350.45, quantity: 1 }],
      asks: [{ price: 4350.87, quantity: 1 }],
    });
    engine.onReference({
      type: 'reference-price',
      provider: 'other-venue',
      symbol: 'PAXG/USDC',
      instrumentType: 'tokenized-gold-spot',
      timestamp: 1,
      bid: 4334.5,
      ask: 4334.7,
      midpoint: 4334.6,
      isDelayed: false,
      isStale: false,
    });

    const snap = engine.snapshot();
    expect(snap.bestBid).toBe(4350.45);
    expect(snap.bestAsk).toBe(4350.87);
    expect(snap.midpoint).toBeCloseTo(4350.66, 5);
  });

  it('uses reference quotes only when there is no book (MODE D)', () => {
    const engine = new AnalyticsEngine();
    engine.onReference({
      type: 'reference-price',
      provider: 'swissquote',
      symbol: 'XAU/USD',
      instrumentType: 'spot-reference',
      timestamp: 1,
      bid: 4334.5,
      ask: 4334.7,
      midpoint: 4334.6,
      isDelayed: false,
      isStale: false,
    });

    const snap = engine.snapshot();
    expect(snap.bestBid).toBe(4334.5);
    expect(snap.bestAsk).toBe(4334.7);
    expect(snap.midpoint).toBeCloseTo(4334.6, 5);
  });

  it('falls back to a composite midpoint when only a midpoint is published', () => {
    const engine = new AnalyticsEngine();
    engine.onReference({
      type: 'reference-price',
      provider: 'aggregated',
      symbol: 'COMPOSITE-XAU',
      instrumentType: 'tokenized-gold-spot',
      timestamp: 1,
      midpoint: 4351.2,
      isDelayed: false,
      isStale: false,
    });

    const snap = engine.snapshot();
    expect(snap.bestBid).toBeNull();
    expect(snap.bestAsk).toBeNull();
    expect(snap.spread).toBeNull();
    expect(snap.midpoint).toBe(4351.2);
  });

  it('computes depth imbalance symmetrically', () => {
    const engine = new AnalyticsEngine();
    engine.onBook({
      bestBid: 10,
      bestAsk: 11,
      bids: [{ price: 10, quantity: 10 }, { price: 9.9, quantity: 10 }],
      asks: [{ price: 11, quantity: 5 }, { price: 11.1, quantity: 5 }],
    });
    const snap = engine.snapshot();
    // bid notional 199 (100 + 99), ask notional 110.5 (55 + 55.5)
    expect(snap.bidDepthNotional).toBeCloseTo(199);
    expect(snap.askDepthNotional).toBeCloseTo(110.5);
    expect(snap.imbalance).toBeCloseTo((199 - 110.5) / (199 + 110.5), 5);
  });

  it('computes signed CVD and excludes unknown-side trades', () => {
    const engine = new AnalyticsEngine();
    engine.onTrade(trade({ tradeId: 'buy-1', quoteNotional: 1000, aggressorSide: 'buy', timestamp: 1 }));
    engine.onTrade(trade({ tradeId: 'sell-1', quoteNotional: 400, aggressorSide: 'sell', timestamp: 2 }));
    engine.onTrade(trade({ tradeId: 'unk-1', quoteNotional: 900, aggressorSide: 'unknown', timestamp: 3 }));
    const snap = engine.snapshot(10_000);
    expect(snap.cvd.available).toBe(true);
    expect(snap.cvd.value).toBe(600);
  });

  it('marks CVD unavailable when no trade side is known', () => {
    const engine = new AnalyticsEngine();
    engine.onTrade(trade({ quoteNotional: 900, aggressorSide: 'unknown' }));
    const snap = engine.snapshot();
    expect(snap.cvd.available).toBe(false);
  });

  it('computes rolling volumes per window', () => {
    const engine = new AnalyticsEngine();
    engine.onTrade(trade({ baseQuantity: 5, timestamp: 1_000 }));
    const snap = engine.snapshot(5_000);
    expect(snap.volumesMs[10_000]).toBe(5);
    expect(snap.volumesMs[300_000]).toBe(5);
  });

  it('classifies trade size with absolute defaults before enough samples', () => {
    const engine = new AnalyticsEngine();
    expect(engine.classifyNotional(100_000)).toBe('normal');
    expect(engine.classifyNotional(LARGE_TRADE_DEFAULT_USD * 1.1)).toBe('large');
    expect(engine.classifyNotional(EXCEPTIONAL_TRADE_DEFAULT_USD * 1.1)).toBe('exceptional');
  });

  it('reports CVD per window, so a label can never disagree with its number', () => {
    const engine = new AnalyticsEngine();
    const now = 1_000_000;
    // Old buy falls outside the 10 s window but inside the 5 m window.
    engine.onTrade(trade({ tradeId: 'old', quoteNotional: 5_000, aggressorSide: 'buy', timestamp: now - 40_000 }));
    engine.onTrade(trade({ tradeId: 'new', quoteNotional: 1_000, aggressorSide: 'sell', timestamp: now - 1_000 }));

    const snap = engine.snapshot(now);
    expect(snap.cvdByWindow[10_000]!.value).toBe(-1_000);
    expect(snap.cvdByWindow[300_000]!.value).toBe(4_000);
    // The default readout is the 1 m window.
    expect(snap.cvd.value).toBe(snap.cvdByWindow[60_000]!.value);
  });

  it('counts large trades instead of always reporting zero', () => {
    const engine = new AnalyticsEngine();
    expect(engine.snapshot().largeTradeCount).toBe(0);

    expect(engine.onTrade(trade({ quoteNotional: 1_000 }))).toBe('normal');
    expect(engine.onTrade(trade({ quoteNotional: LARGE_TRADE_DEFAULT_USD * 1.1 }))).toBe('large');
    expect(engine.onTrade(trade({ quoteNotional: EXCEPTIONAL_TRADE_DEFAULT_USD * 1.1 }))).toBe(
      'exceptional',
    );

    expect(engine.snapshot().largeTradeCount).toBe(2);
  });

  it('tracks trade rate and reports an honest quiet front', () => {
    const engine = new AnalyticsEngine();
    const now = 1_000_000;
    // Oldest first, so the most recent trade lands exactly on `now`.
    for (let i = 14; i >= 0; i--) {
      engine.onTrade(trade({ tradeId: `t${i}`, timestamp: now - i * 1_000 }));
    }

    const busy = engine.snapshot(now);
    expect(busy.tradesPerSecond).toBeCloseTo(0.5, 5); // 15 trades / 30 s window
    expect(busy.activity).toBeGreaterThan(0);
    expect(busy.quiet).toBe(false);
    expect(busy.msSinceLastTrade).toBe(0);

    // Much later, with nothing new printing, the front is quiet.
    const later = engine.snapshot(now + 120_000);
    expect(later.tradesPerSecond).toBe(0);
    expect(later.activity).toBe(0);
    expect(later.quiet).toBe(true);
  });

  it('exposes the last aggressor side for the charge direction', () => {
    const engine = new AnalyticsEngine();
    engine.onTrade(trade({ aggressorSide: 'buy' }));
    engine.onTrade(trade({ tradeId: 's', aggressorSide: 'sell', quoteNotional: 500 }));
    const snap = engine.snapshot();
    expect(snap.lastTradeSide).toBe('sell');
    expect(snap.lastTradeNotional).toBe(500);
  });

  it('classifies trade size with percentile thresholds after enough samples', () => {
    const engine = new AnalyticsEngine();
    for (let i = 0; i < 40; i++) {
      engine.onTrade(trade({ quoteNotional: 1_000_000 }));
    }
    expect(engine.classifyNotional(500_000)).toBe('normal');
    expect(engine.classifyNotional(2_000_000)).toBe('exceptional'); // >= p99 of 1M samples
  });
});
