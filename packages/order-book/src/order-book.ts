import type { BookLevel, OrderBookDeltaEvent, OrderBookSnapshotEvent } from '@gb/market-types';
import { DELTA_BUFFER_MAX } from '@gb/shared-config';

export interface BookSnapshot {
  /** Bids sorted high → low. */
  bids: BookLevel[];
  /** Asks sorted low → high. */
  asks: BookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  spread: number | null;
  updateId: number;
}

/**
 * Order-book reconstruction (spec §7):
 *  - snapshot applied first, deltas buffered until then;
 *  - sequence rules: drop events with finalSequence <= local id, detect gaps
 *    (firstSequence > local id + 1) and request a resync;
 *  - zero quantity deletes a level; bids kept high→low, asks low→high;
 *  - optional checksum validation (e.g. Kraken CRC32) triggering resync.
 */
export class LocalOrderBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private updateId = 0;
  private applied = false;
  private pending: OrderBookDeltaEvent[] = [];
  private dirtyBids = true;
  private dirtyAsks = true;
  private sortedBids: BookLevel[] = [];
  private sortedAsks: BookLevel[] = [];

  /** Called when a sequence gap or checksum mismatch requires a new snapshot. */
  onResync: (() => void) | null = null;

  /**
   * Optional checksum validator invoked after each applied delta. Return true
   * when the checksum matches the local book (e.g. Kraken CRC32 over top-10).
   */
  checksumValidator: ((delta: OrderBookDeltaEvent) => boolean) | null = null;

  get isApplied(): boolean {
    return this.applied;
  }

  get lastUpdateId(): number {
    return this.updateId;
  }

  /**
   * Drops all state. Required when switching providers so levels from one
   * venue are never merged with another venue's book (spec §14).
   */
  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.pending = [];
    this.updateId = 0;
    this.applied = false;
    this.sortedBids = [];
    this.sortedAsks = [];
    this.dirtyBids = false;
    this.dirtyAsks = false;
  }

  applySnapshot(snap: OrderBookSnapshotEvent): void {
    this.bids.clear();
    this.asks.clear();
    for (const level of snap.bids) {
      if (level.quantity > 0) this.bids.set(level.price, level.quantity);
    }
    for (const level of snap.asks) {
      if (level.quantity > 0) this.asks.set(level.price, level.quantity);
    }
    this.updateId = snap.sequence ?? 0;
    this.applied = true;
    this.dirtyBids = true;
    this.dirtyAsks = true;
    this.flushPending();
  }

  enqueueDelta(delta: OrderBookDeltaEvent): void {
    if (!this.applied) {
      if (this.pending.length < DELTA_BUFFER_MAX) this.pending.push(delta);
      return;
    }
    this.applyDelta(delta);
  }

  private flushPending(): void {
    const pending = this.pending;
    this.pending = [];
    for (const delta of pending) this.applyDelta(delta);
  }

  private applyDelta(delta: OrderBookDeltaEvent): void {
    const first = delta.firstSequence ?? null;
    const last = delta.finalSequence ?? null;

    if (last != null && last <= this.updateId) {
      return; // stale or duplicate
    }
    if (first != null && last != null && first > this.updateId + 1) {
      this.requestResync();
      return;
    }

    this.applyLevels(this.bids, delta.bidUpdates);
    this.applyLevels(this.asks, delta.askUpdates);

    const nextId = Math.max(this.updateId, last ?? first ?? 0);
    if (nextId !== this.updateId) this.updateId = nextId;

    if (this.checksumValidator != null && delta.checksum != null && !this.checksumValidator(delta)) {
      this.requestResync();
    }
  }

  private applyLevels(map: Map<number, number>, updates: BookLevel[]): void {
    if (updates.length === 0) return;
    if (map === this.bids) this.dirtyBids = true;
    else this.dirtyAsks = true;
    for (const update of updates) {
      if (update.quantity === 0) map.delete(update.price);
      else map.set(update.price, update.quantity);
    }
  }

  private requestResync(): void {
    this.applied = false;
    this.pending = [];
    this.onResync?.();
  }

  topBids(n: number): BookLevel[] {
    if (this.dirtyBids) this.sortBids();
    return this.sortedBids.slice(0, n);
  }

  topAsks(n: number): BookLevel[] {
    if (this.dirtyAsks) this.sortAsks();
    return this.sortedAsks.slice(0, n);
  }

  snapshot(): BookSnapshot {
    if (this.dirtyBids) this.sortBids();
    if (this.dirtyAsks) this.sortAsks();
    const bestBid = this.sortedBids.length > 0 ? this.sortedBids[0]!.price : null;
    const bestAsk = this.sortedAsks.length > 0 ? this.sortedAsks[0]!.price : null;
    const midpoint = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
    const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
    return {
      bids: this.sortedBids.slice(0, 200),
      asks: this.sortedAsks.slice(0, 200),
      bestBid,
      bestAsk,
      midpoint,
      spread,
      updateId: this.updateId,
    };
  }

  private sortBids(): void {
    this.sortedBids = [...this.bids.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([price, quantity]) => ({ price, quantity }));
    this.dirtyBids = false;
  }

  private sortAsks(): void {
    this.sortedAsks = [...this.asks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([price, quantity]) => ({ price, quantity }));
    this.dirtyAsks = false;
  }
}
