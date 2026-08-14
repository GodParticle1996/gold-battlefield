import { describe, expect, it } from 'vitest';
import { AnalyticsEngine } from '@gb/analytics';
import { VisualMapper } from '@gb/visual-mapping';

const NOW = 1_752_000_000_000;

function metricsWithPrice(price: number, bid: number, ask: number) {
  const engine = new AnalyticsEngine();
  engine.onBook({
    bestBid: bid,
    bestAsk: ask,
    bids: [{ price: bid, quantity: 10 }],
    asks: [{ price: ask, quantity: 10 }],
  });
  engine.onTrade({
    type: 'trade',
    provider: 'test',
    symbol: 'XAUT/USD',
    instrumentType: 'tokenized-gold-spot',
    timestamp: 1,
    tradeId: 't',
    price,
    baseQuantity: 1,
    quoteNotional: price,
    aggressorSide: 'buy',
    isEstimated: false,
  });
  return engine.snapshot();
}

const emptyDepth = { bids: [], asks: [] };

describe('VisualMapper (spec §9)', () => {
  it('centers the price line at the anchor on first update', () => {
    const mapper = new VisualMapper();
    const state = mapper.update(metricsWithPrice(4365, 4364.98, 4365.02), emptyDepth, 83, NOW);
    expect(state.priceLineX).toBe(0);
    expect(state.lastPrice).toBe(4365);
  });

  it('maps price offset into [-1, 1] using the visible range', () => {
    const mapper = new VisualMapper();
    mapper.update(metricsWithPrice(4365, 4364.98, 4365.02), emptyDepth, 83, NOW);
    const state = mapper.update(metricsWithPrice(4366, 4365.98, 4366.02), emptyDepth, 83, NOW);
    expect(state.priceLineX).toBeCloseTo(0.5, 5); // +1 USD over range 2
  });

  it('clamps prices beyond the visible range', () => {
    const mapper = new VisualMapper();
    mapper.update(metricsWithPrice(4365, 4364.98, 4365.02), emptyDepth, 83, NOW);
    const state = mapper.update(metricsWithPrice(4375, 4374.98, 4375.02), emptyDepth, 83, NOW);
    expect(state.priceLineX).toBe(1);
  });

  it('recenters the anchor gradually instead of teleporting', () => {
    const mapper = new VisualMapper();
    mapper.update(metricsWithPrice(4365, 4364.98, 4365.02), emptyDepth, 83, NOW);
    let state = mapper.update(metricsWithPrice(4369, 4368.98, 4369.02), emptyDepth, 83, NOW);
    expect(state.priceLineX).toBe(1);
    const anchorBefore = state.anchor;
    for (let i = 0; i < 200; i++) {
      state = mapper.update(metricsWithPrice(4369, 4368.98, 4369.02), emptyDepth, 83, NOW + i * 83);
    }
    expect(state.anchor).toBeGreaterThan(anchorBefore);
    expect(state.priceLineX).toBeLessThanOrEqual(1);
  });

  it('scales formation strength with depth using log1p', () => {
    const mapper = new VisualMapper();
    const engine = new AnalyticsEngine();
    engine.onBook({
      bestBid: 4365,
      bestAsk: 4365.1,
      bids: [{ price: 4365, quantity: 100 }], // ~436.5k notional
      asks: [{ price: 4365.1, quantity: 5 }], // ~21.8k notional
    });
    const state = mapper.update(engine.snapshot(), emptyDepth, 83, NOW);
    expect(state.bidStrength).toBeGreaterThan(state.askStrength);
    expect(state.bidStrength).toBeGreaterThan(0);
    expect(state.bidStrength).toBeLessThanOrEqual(1);
  });

  it('detects walls from depth levels above the threshold', () => {
    const mapper = new VisualMapper();
    const engine = new AnalyticsEngine();
    engine.onBook({ bestBid: 4365, bestAsk: 4365.1, bids: [], asks: [] });
    const depth = {
      bids: [
        { price: 4364.9, quantity: 600 }, // ~2.6M notional → wall
        { price: 4364.8, quantity: 0.01 }, // tiny → no wall
      ],
      asks: [{ price: 4365.2, quantity: 800 }], // ~3.5M → wall
    };
    const state = mapper.update(engine.snapshot(), depth, 83, NOW);
    expect(state.walls.length).toBe(2);
    expect(state.walls.some((w) => w.side === 'bid')).toBe(true);
    expect(state.walls.some((w) => w.side === 'ask')).toBe(true);
    expect(state.walls[0]!.strength).toBeGreaterThan(0);
  });

  it('registers and expires large-trade effects', () => {
    const mapper = new VisualMapper();
    const engine = new AnalyticsEngine();
    engine.onBook({ bestBid: 4365, bestAsk: 4365.1, bids: [], asks: [] });
    engine.onTrade({
      type: 'trade',
      provider: 'test',
      symbol: 'XAUT/USD',
      instrumentType: 'tokenized-gold-spot',
      timestamp: 1,
      tradeId: 't',
      price: 4365,
      baseQuantity: 1,
      quoteNotional: 4365,
      aggressorSide: 'buy',
      isEstimated: false,
    });
    mapper.addLargeTradeEffect('buy', 4365.2, NOW);
    let state = mapper.update(engine.snapshot(), emptyDepth, 83, NOW);
    // A pressure event is a charge (the wind-up) plus an impact.
    expect(state.effects.map((effect) => effect.kind).sort()).toEqual(['charge', 'impact']);
    expect(state.effects.every((effect) => effect.side === 'buy')).toBe(true);
    // After the lifetime, the effects are pruned.
    state = mapper.update(engine.snapshot(), emptyDepth, 83, NOW + 5_000);
    expect(state.effects.length).toBe(0);
  });

  it('stamps effects with the clock the caller passed, so the renderer can age them', () => {
    // Regression: effects were stamped with Date.now() but aged against
    // performance.now(), which pinned every effect at age zero forever.
    const mapper = new VisualMapper();
    const engine = new AnalyticsEngine();
    engine.onBook({ bestBid: 4365, bestAsk: 4365.1, bids: [], asks: [] });
    mapper.addLargeTradeEffect('sell', 4365, NOW);
    const state = mapper.update(engine.snapshot(), emptyDepth, 83, NOW);

    for (const effect of state.effects) {
      expect(effect.t0).toBe(NOW);
      expect(effect.lifeMs).toBeGreaterThan(0);
      // Half-way through its life the effect must report a usable progress.
      const progress = (NOW + effect.lifeMs / 2 - effect.t0) / effect.lifeMs;
      expect(progress).toBeCloseTo(0.5, 5);
    }
  });
});

describe('VisualMapper fortifications', () => {
  const bigBid = { price: 4364.9, quantity: 600 }; // ~2.6M notional
  const engineWith = (bid: number, ask: number) => {
    const engine = new AnalyticsEngine();
    engine.onBook({ bestBid: bid, bestAsk: ask, bids: [], asks: [] });
    return engine;
  };

  it('keeps a stable wall id across frames so meshes can be pooled', () => {
    const mapper = new VisualMapper();
    const engine = engineWith(4365, 4365.1);
    const depth = { bids: [bigBid], asks: [] };

    const first = mapper.update(engine.snapshot(), depth, 83, NOW);
    const second = mapper.update(engine.snapshot(), depth, 83, NOW + 83);

    expect(first.walls).toHaveLength(1);
    expect(second.walls[0]!.id).toBe(first.walls[0]!.id);
    expect(second.walls[0]!.bornAt).toBe(first.walls[0]!.bornAt);
    expect(second.walls[0]!.phase).toBe('holding');
  });

  it('marks a vanished level overrun when trades printed through it', () => {
    const mapper = new VisualMapper();
    const engine = engineWith(4365, 4365.1);
    mapper.update(engine.snapshot(), { bids: [bigBid], asks: [] }, 83, NOW);

    mapper.noteTrade(4364.8, NOW + 50); // traded below the bid wall
    const state = mapper.update(engine.snapshot(), { bids: [], asks: [] }, 83, NOW + 100);

    expect(state.walls[0]!.phase).toBe('overrun');
    expect(state.walls[0]!.leftAt).toBe(NOW + 100);
    // An overrun wall also spawns its own break effect.
    expect(state.effects.some((effect) => effect.kind === 'wall-break')).toBe(true);
  });

  it('marks a vanished level withdrawn when no trade went near it', () => {
    const mapper = new VisualMapper();
    const engine = engineWith(4365, 4365.1);
    mapper.update(engine.snapshot(), { bids: [bigBid], asks: [] }, 83, NOW);

    // Trades printed, but well above the bid wall — it was never reached.
    mapper.noteTrade(4365.5, NOW + 50);
    const state = mapper.update(engine.snapshot(), { bids: [], asks: [] }, 83, NOW + 100);

    expect(state.walls[0]!.phase).toBe('withdrawn');
    // Cancelled liquidity must not be dramatized as a break (spec §8/§11).
    expect(state.effects.some((effect) => effect.kind === 'wall-break')).toBe(false);
  });

  it('drops dismantled walls once the animation window has passed', () => {
    const mapper = new VisualMapper();
    const engine = engineWith(4365, 4365.1);
    mapper.update(engine.snapshot(), { bids: [bigBid], asks: [] }, 83, NOW);
    mapper.update(engine.snapshot(), { bids: [], asks: [] }, 83, NOW + 100);

    const state = mapper.update(engine.snapshot(), { bids: [], asks: [] }, 83, NOW + 5_000);
    expect(state.walls).toHaveLength(0);
  });

  it('re-derives walls when the wall threshold changes', () => {
    const mapper = new VisualMapper();
    const engine = engineWith(4365, 4365.1);
    const depth = { bids: [{ price: 4364.9, quantity: 30 }], asks: [] }; // ~131k

    expect(mapper.update(engine.snapshot(), depth, 83, NOW).walls).toHaveLength(0);
    mapper.setWallThreshold(100_000);
    expect(mapper.update(engine.snapshot(), depth, 83, NOW + 83).walls).toHaveLength(1);
  });

  it('emits feed entries that word cancellation and consumption differently', () => {
    const mapper = new VisualMapper();
    const engine = engineWith(4365, 4365.1);
    mapper.update(engine.snapshot(), { bids: [bigBid], asks: [] }, 83, NOW);
    expect(mapper.drainFeed().some((entry) => entry.kind === 'wall-add')).toBe(true);

    mapper.update(engine.snapshot(), { bids: [], asks: [] }, 83, NOW + 100);
    const removal = mapper.drainFeed().find((entry) => entry.kind === 'wall-remove');
    expect(removal?.text).toContain('withdrawn');
    expect(removal?.text).not.toContain('liquidat');
    // drainFeed empties the queue.
    expect(mapper.drainFeed()).toHaveLength(0);
  });

  it('widens the map so a deep book is not clamped against the edge', () => {
    // Regression: with a fixed ±2 half-map, every level beyond two dollars
    // piled up on the edge of the field as one unreadable stack.
    const mapper = new VisualMapper();
    const engine = new AnalyticsEngine();
    engine.onBook({
      bestBid: 4365,
      bestAsk: 4365.02,
      bids: [{ price: 4365, quantity: 1 }],
      asks: [{ price: 4365.02, quantity: 1 }],
    });
    // The rendered ladder reaches five dollars either side of the touch.
    const depth = {
      bids: [{ price: 4365, quantity: 1 }, { price: 4360, quantity: 1 }],
      asks: [{ price: 4365.02, quantity: 1 }, { price: 4370, quantity: 1 }],
    };

    // Widens over several frames rather than snapping open on the first one.
    let state = mapper.update(engine.snapshot(), depth, 83, NOW);
    const firstFrameRange = state.range;
    expect(firstFrameRange).toBeLessThan(4);
    for (let i = 1; i < 200; i++) {
      state = mapper.update(engine.snapshot(), depth, 83, NOW + i * 83);
    }

    expect(state.range).toBeGreaterThan(5);
    expect(state.range).toBeGreaterThan(firstFrameRange);
    expect(Math.abs(state.priceLineX)).toBeLessThan(1); // no longer clamped
    expect(Math.abs(state.bestBidX!)).toBeLessThan(1);
    expect(Math.abs(state.bestAskX!)).toBeLessThan(1);
  });

  it('falls back to the book midpoint once the last print goes stale', () => {
    // Regression: a thin venue's last trade can be minutes old and dollars from
    // the live quotes; the front line used to park there, detached from the
    // armies. It now follows the midpoint and reports which source it is using.
    const mapper = new VisualMapper();
    const engine = new AnalyticsEngine();
    engine.onTrade({
      type: 'trade',
      provider: 'test',
      symbol: 'PAXG/USD',
      instrumentType: 'tokenized-gold-spot',
      timestamp: NOW,
      tradeId: 'old',
      price: 4349.02,
      baseQuantity: 1,
      quoteNotional: 4349.02,
      aggressorSide: 'buy',
      isEstimated: false,
    });
    engine.onBook({
      bestBid: 4333.7,
      bestAsk: 4333.9,
      bids: [{ price: 4333.7, quantity: 1 }],
      asks: [{ price: 4333.9, quantity: 1 }],
    });

    const fresh = mapper.update(engine.snapshot(NOW), emptyDepth, 83, NOW);
    expect(fresh.priceSource).toBe('last-trade');
    expect(fresh.lastPrice).toBe(4349.02);

    // Two minutes later the print is stale and the market counts as quiet.
    const stale = mapper.update(engine.snapshot(NOW + 120_000), emptyDepth, 83, NOW + 120_000);
    expect(stale.priceSource).toBe('midpoint');
    expect(stale.lastPrice).toBeCloseTo(4333.8, 5);
  });

  it('keeps the default half-map when everything already fits', () => {
    const mapper = new VisualMapper();
    const engine = new AnalyticsEngine();
    engine.onBook({
      bestBid: 4364.98,
      bestAsk: 4365.02,
      bids: [{ price: 4364.98, quantity: 1 }],
      asks: [{ price: 4365.02, quantity: 1 }],
    });
    let state = mapper.update(engine.snapshot(), emptyDepth, 83, NOW);
    for (let i = 1; i < 60; i++) {
      state = mapper.update(engine.snapshot(), emptyDepth, 83, NOW + i * 83);
    }
    expect(state.range).toBe(2);
  });

  it('builds a readable price ladder across the visible range', () => {
    const mapper = new VisualMapper();
    const engine = engineWith(4365, 4365.1);
    const state = mapper.update(engine.snapshot(), emptyDepth, 83, NOW);

    expect(state.ticks.length).toBeGreaterThan(4);
    expect(state.ticks.every((tick) => tick.x >= -1 && tick.x <= 1)).toBe(true);
    expect(state.ticks.some((tick) => tick.major)).toBe(true);
  });

  it('accumulates a bounded price trail', () => {
    const mapper = new VisualMapper();
    const engine = engineWith(4365, 4365.1);
    for (let i = 0; i < 600; i++) mapper.update(engine.snapshot(), emptyDepth, 83, NOW + i * 83);
    const state = mapper.update(engine.snapshot(), emptyDepth, 83, NOW + 600 * 83);
    expect(state.trail.length).toBeLessThanOrEqual(120);
    expect(state.trail.length).toBeGreaterThan(0);
  });

  it('re-derives the trail from prices when the map recentres', () => {
    // Regression: the trail stored battlefield coordinates, so once the anchor
    // or range moved, old samples marked prices the front line never visited.
    const mapper = new VisualMapper();
    const engine = new AnalyticsEngine();
    const at = (price: number) => {
      engine.onBook({
        bestBid: price - 0.01,
        bestAsk: price + 0.01,
        bids: [{ price: price - 0.01, quantity: 1 }],
        asks: [{ price: price + 0.01, quantity: 1 }],
      });
      return engine.snapshot();
    };

    mapper.update(at(4365), emptyDepth, 500, NOW);
    const anchored = mapper.update(at(4365), emptyDepth, 500, NOW + 600);
    expect(anchored.trail.at(0)).toBeCloseTo(0, 5);

    // Walk the price up hard enough to drag the anchor along.
    let state = anchored;
    for (let i = 1; i <= 40; i++) {
      state = mapper.update(at(4365 + i * 0.2), emptyDepth, 500, NOW + 600 + i * 500);
    }

    // The oldest sample is still $4365, which is now well left of the anchor.
    expect(state.anchor).toBeGreaterThan(4365);
    expect(state.trail[0]!).toBeLessThan(0);
    expect(state.trail[0]!).toBeCloseTo(
      Math.max(-1, (4365 - state.anchor) / state.range),
      5,
    );
  });
});
