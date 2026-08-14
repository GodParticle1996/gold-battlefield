import type { ConnectionStatus, FeedEntry, MarketEvent } from '@gb/market-types';
import { VOLUME_WINDOWS_MS } from '@gb/shared-config';
import type { AdapterCapabilities, AdapterHandlers, MarketDataAdapter } from './index';

export interface SimulationAdapterOptions extends AdapterHandlers {
  seed?: number;
  intervalMs?: number;
  symbol?: string;
}

/** Deterministic PRNG (mulberry32) so simulation runs are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * MODE G — synthetic simulation (spec §4/§5). Never mixed with live data;
 * every trade is marked isEstimated and the UI shows the simulation label.
 */
export class SimulationAdapter implements MarketDataAdapter {
  readonly provider = 'simulation';
  readonly symbol: string;
  readonly capabilities: AdapterCapabilities = {
    orderBook: true,
    trades: true,
    aggressorSide: true,
    liquidations: false,
    live: false,
  };

  private readonly onEvent: (event: MarketEvent) => void;
  private readonly onStatus: (status: ConnectionStatus) => void;
  private readonly onFeed?: (entry: FeedEntry) => void;

  private readonly rng: () => number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private price = 4365;
  private seq = 0;
  private tradeId = 0;
  private step = 0;
  private state: ConnectionStatus['state'] = 'idle';
  private lastEmitAt = 0;

  constructor(options: SimulationAdapterOptions) {
    this.rng = mulberry32(options.seed ?? 42);
    this.intervalMs = options.intervalMs ?? 500;
    this.symbol = options.symbol ?? 'SIM-XAU-USD';
    this.onEvent = options.onEvent;
    this.onStatus = options.onStatus;
    this.onFeed = options.onFeed;
  }

  async connect(): Promise<void> {
    this.state = 'connecting';
    this.setStatus('connecting');
    this.emitSnapshot();
    this.lastEmitAt = Date.now();
    this.setStatus('connected');
    this.timer = setInterval(() => this.stepOnce(), this.intervalMs);
  }

  disconnect(): void {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
    this.setStatus('idle');
  }

  getHealth(): ConnectionStatus {
    return {
      provider: this.provider,
      state: this.state,
      lastMessageAt: this.lastEmitAt,
      reconnectAttempts: 0,
    };
  }

  private setStatus(state: ConnectionStatus['state']): void {
    this.state = state;
    this.onStatus({
      provider: this.provider,
      state,
      lastMessageAt: Date.now(),
      reconnectAttempts: 0,
    });
  }

  private now(): number {
    return Date.now();
  }

  private emitSnapshot(): void {
    const ts = this.now();
    const bids: { price: number; quantity: number }[] = [];
    const asks: { price: number; quantity: number }[] = [];
    for (let i = 1; i <= 12; i++) {
      bids.push({ price: round(this.price - 0.05 * i), quantity: roundQty(5 + this.rng() * 40) });
      asks.push({ price: round(this.price + 0.05 * i), quantity: roundQty(5 + this.rng() * 40) });
    }
    this.onEvent({
      type: 'snapshot',
      provider: this.provider,
      symbol: this.symbol,
      instrumentType: 'simulation',
      timestamp: ts,
      sequence: ++this.seq,
      bids,
      asks,
    });
  }

  private stepOnce(): void {
    this.step += 1;
    const ts = this.now();
    this.lastEmitAt = ts;

    // Random-walk price with occasional larger moves.
    const drift = (this.rng() - 0.5) * 0.8;
    const jump = this.step % 40 === 0 ? (this.rng() - 0.5) * 3.0 : 0;
    this.price = Math.max(4000, Math.min(4700, this.price + drift + jump));

    // Consistent book refresh: a full snapshot per step keeps bids strictly
    // below asks (no crossed books from stale levels).
    const bids: { price: number; quantity: number }[] = [];
    const asks: { price: number; quantity: number }[] = [];
    for (let i = 1; i <= 12; i++) {
      bids.push({ price: round(this.price - 0.05 * i), quantity: roundQty(5 + this.rng() * 40) });
      asks.push({ price: round(this.price + 0.05 * i), quantity: roundQty(5 + this.rng() * 40) });
    }
    this.onEvent({
      type: 'snapshot',
      provider: this.provider,
      symbol: this.symbol,
      instrumentType: 'simulation',
      timestamp: ts,
      sequence: ++this.seq,
      bids,
      asks,
    });

    // Trade every step; occasionally a large (pressure) trade.
    const isLarge = this.step % 24 === 0;
    const quantity = isLarge ? 20 + this.rng() * 280 : 0.05 + this.rng() * 4;
    const side = this.rng() < 0.5 ? 'buy' : 'sell';
    const price = round(this.price + (side === 'buy' ? 0.02 : -0.02) * this.rng());
    this.tradeId += 1;
    this.onEvent({
      type: 'trade',
      provider: this.provider,
      symbol: this.symbol,
      instrumentType: 'simulation',
      timestamp: ts,
      tradeId: `sim-${this.tradeId}`,
      price,
      baseQuantity: quantity,
      quoteNotional: quantity * price,
      aggressorSide: side,
      isEstimated: true,
    });
    if (isLarge) {
      this.onFeed?.({
        kind: 'large-trade',
        text: `Large-trade event: ${side === 'buy' ? 'aggressive buy' : 'aggressive sell'} ${quantity.toFixed(1)} oz @ $${price.toFixed(2)}`,
        ts,
      });
    }

    // Reference-price keep-alive so freshness metrics stay live.
    this.onEvent({
      type: 'reference-price',
      provider: this.provider,
      symbol: this.symbol,
      instrumentType: 'simulation',
      timestamp: ts,
      bid: round(this.price - 0.03),
      ask: round(this.price + 0.03),
      midpoint: this.price,
      isDelayed: false,
      isStale: false,
    });

    // Keep the rolling-window arrays honest.
    void VOLUME_WINDOWS_MS;
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundQty(value: number): number {
  return Math.round(value * 10000) / 10000;
}
