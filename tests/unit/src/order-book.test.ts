import { describe, expect, it } from 'vitest';
import type { OrderBookDeltaEvent, OrderBookSnapshotEvent } from '@gb/market-types';
import { LocalOrderBook } from '@gb/order-book';

function snapshot(sequence: number, bids: [number, number][], asks: [number, number][]): OrderBookSnapshotEvent {
  return {
    type: 'snapshot',
    provider: 'test',
    symbol: 'XAUT/USD',
    instrumentType: 'tokenized-gold-spot',
    timestamp: 1_752_000_000_000,
    sequence,
    bids: bids.map(([price, quantity]) => ({ price, quantity })),
    asks: asks.map(([price, quantity]) => ({ price, quantity })),
  };
}

function delta(
  firstSequence: number,
  finalSequence: number,
  bidUpdates: [number, number][] = [],
  askUpdates: [number, number][] = [],
  checksum?: number,
): OrderBookDeltaEvent {
  return {
    type: 'delta',
    provider: 'test',
    symbol: 'XAUT/USD',
    instrumentType: 'tokenized-gold-spot',
    timestamp: 1_752_000_000_000,
    firstSequence,
    finalSequence,
    bidUpdates: bidUpdates.map(([price, quantity]) => ({ price, quantity })),
    askUpdates: askUpdates.map(([price, quantity]) => ({ price, quantity })),
    checksum,
  };
}

describe('LocalOrderBook', () => {
  it('applies a snapshot with sorted bids (high→low) and asks (low→high)', () => {
    const book = new LocalOrderBook();
    book.applySnapshot(snapshot(100, [[10, 1], [9, 2], [11, 3]], [[12, 4], [13, 5], [11.5, 6]]));
    const snap = book.snapshot();
    expect(snap.bestBid).toBe(11);
    expect(snap.bestAsk).toBe(11.5);
    expect(snap.midpoint).toBe(11.25);
    expect(snap.spread).toBe(0.5);
    expect(snap.bids.map((l) => l.price)).toEqual([11, 10, 9]);
    expect(snap.asks.map((l) => l.price)).toEqual([11.5, 12, 13]);
    expect(snap.updateId).toBe(100);
  });

  it('buffers deltas until the snapshot arrives, then applies them in order', () => {
    const book = new LocalOrderBook();
    book.enqueueDelta(delta(2, 2, [[10, 5]], [[11, 5]]));
    book.enqueueDelta(delta(3, 3, [[9, 7]]));
    expect(book.isApplied).toBe(false);
    book.applySnapshot(snapshot(1, [[10, 1]], [[11, 1]]));
    expect(book.isApplied).toBe(true);
    const snap = book.snapshot();
    expect(snap.bestBid).toBe(10);
    expect(snap.bids.find((l) => l.price === 10)?.quantity).toBe(5);
    expect(snap.bids.find((l) => l.price === 9)?.quantity).toBe(7);
    expect(snap.asks.find((l) => l.price === 11)?.quantity).toBe(5);
    expect(snap.updateId).toBe(3);
  });

  it('ignores stale and duplicate deltas (finalSequence <= local update id)', () => {
    const book = new LocalOrderBook();
    book.applySnapshot(snapshot(100, [[10, 1]], [[11, 1]]));
    book.enqueueDelta(delta(100, 100, [[10, 99]])); // equal to snapshot id → stale
    book.enqueueDelta(delta(101, 101, [[10, 2]])); // applied
    book.enqueueDelta(delta(101, 101, [[10, 3]])); // duplicate → ignored
    expect(book.snapshot().bids.find((l) => l.price === 10)?.quantity).toBe(2);
    expect(book.lastUpdateId).toBe(101);
  });

  it('detects sequence gaps and requests a resync', () => {
    const book = new LocalOrderBook();
    let resyncs = 0;
    book.onResync = () => {
      resyncs += 1;
    };
    book.applySnapshot(snapshot(100, [[10, 1]], [[11, 1]]));
    book.enqueueDelta(delta(200, 200, [[10, 5]])); // first > local+1 → gap
    expect(resyncs).toBe(1);
    expect(book.isApplied).toBe(false); // book discarded pending resync
    // A fresh snapshot clears the resync state.
    book.applySnapshot(snapshot(300, [[10, 9]], [[11, 9]]));
    expect(book.snapshot().bestBid).toBe(10);
    expect(book.lastUpdateId).toBe(300);
  });

  it('deletes a level when quantity is zero and inserts new levels sorted', () => {
    const book = new LocalOrderBook();
    book.applySnapshot(snapshot(10, [[10, 1], [9.5, 2]], [[10.5, 3], [11, 4]]));
    book.enqueueDelta(delta(11, 11, [[10, 0], [9.4, 8]], [[10.5, 0], [10.7, 5]]));
    const snap = book.snapshot();
    expect(snap.bids.map((l) => l.price)).toEqual([9.5, 9.4]);
    expect(snap.asks.map((l) => l.price)).toEqual([10.7, 11]);
    expect(snap.bestBid).toBe(9.5);
    expect(snap.bestAsk).toBe(10.7);
  });

  it('caps topN queries', () => {
    const book = new LocalOrderBook();
    const bids: [number, number][] = [];
    const asks: [number, number][] = [];
    for (let i = 0; i < 25; i++) {
      bids.push([100 - i, 1]);
      asks.push([101 + i, 1]);
    }
    book.applySnapshot(snapshot(1, bids, asks));
    expect(book.topBids(5)).toHaveLength(5);
    expect(book.topBids(5)[0]!.price).toBe(100);
    expect(book.topAsks(5)[0]!.price).toBe(101);
  });

  it('triggers resync when an optional checksum validator fails', () => {
    const book = new LocalOrderBook();
    let resyncs = 0;
    book.onResync = () => {
      resyncs += 1;
    };
    book.applySnapshot(snapshot(10, [[10, 1]], [[11, 1]]));
    book.checksumValidator = () => false;
    book.enqueueDelta(delta(11, 11, [[10, 2]], [], 12345));
    expect(resyncs).toBe(1);
    // Without a checksum field the validator is not consulted.
    const book2 = new LocalOrderBook();
    let resyncs2 = 0;
    book2.onResync = () => {
      resyncs2 += 1;
    };
    book2.applySnapshot(snapshot(10, [[10, 1]], [[11, 1]]));
    book2.checksumValidator = () => false;
    book2.enqueueDelta(delta(11, 11, [[10, 2]]));
    expect(resyncs2).toBe(0);
  });

  it('keeps the book consistent across many interleaved updates', () => {
    const book = new LocalOrderBook();
    book.applySnapshot(snapshot(0, [[10, 1], [9, 1]], [[11, 1], [12, 1]]));
    let seq = 1;
    for (let i = 0; i < 500; i++) {
      book.enqueueDelta(delta(seq, seq, [[10, i % 2 === 0 ? 0 : 10]], [[11, i % 3 === 0 ? 0 : 11]]));
      seq += 1;
    }
    const snap = book.snapshot();
    expect(snap.updateId).toBe(500);
    expect(snap.bestBid).toBeGreaterThanOrEqual(9);
    expect(snap.bestAsk).toBeLessThanOrEqual(12);
  });

  it('reset() clears every level so venues are never merged', () => {
    // Spec §14: switching providers must not leave one venue's levels in the
    // book while the next venue's snapshot is still in flight.
    const book = new LocalOrderBook();
    book.applySnapshot(snapshot(100, [[10, 1]], [[11, 1]]));
    expect(book.snapshot().bestBid).toBe(10);

    book.reset();

    const cleared = book.snapshot();
    expect(book.isApplied).toBe(false);
    expect(cleared.bestBid).toBeNull();
    expect(cleared.bestAsk).toBeNull();
    expect(cleared.bids).toHaveLength(0);
    expect(cleared.asks).toHaveLength(0);
    expect(cleared.updateId).toBe(0);

    // Deltas arriving after a reset are buffered, not applied to a stale book.
    book.enqueueDelta(delta(101, 101, [[10, 9]]));
    expect(book.snapshot().bestBid).toBeNull();
    book.applySnapshot(snapshot(200, [[20, 1]], [[21, 1]]));
    expect(book.snapshot().bestBid).toBe(20);
  });
});
