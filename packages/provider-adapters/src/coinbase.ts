import WebSocket from 'ws';
import type {
  ConnectionStatus,
  FeedEntry,
  MarketEvent,
  OrderBookDeltaEvent,
  OrderBookSnapshotEvent,
  ReferencePriceEvent,
  TradeEvent,
} from '@gb/market-types';
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS } from '@gb/shared-config';
import type { AdapterCapabilities, AdapterHandlers, MarketDataAdapter } from './index';

export interface CoinbaseAdapterOptions extends AdapterHandlers {
  wsUrl?: string;
  symbol?: string;
  /** Testing hook: force a socket close every N ms (soak tests). Default 0 = disabled. */
  forceReconnectMs?: number;
}

const INSTRUMENT = 'tokenized-gold-spot';

interface CoinbaseSnapshotPayload {
  type: 'snapshot';
  product_id?: string;
  sequence?: number;
  bids?: [string, string, number][];
  asks?: [string, string, number][];
}
interface CoinbaseL2UpdatePayload {
  type: 'l2update';
  product_id?: string;
  changes?: [string, string, string][];
  time?: string;
}
interface CoinbaseMatchPayload {
  type: 'match';
  product_id?: string;
  trade_id?: number;
  price?: string;
  size?: string;
  side?: string;
  time?: string;
}
interface CoinbaseTickerPayload {
  type: 'ticker';
  product_id?: string;
  price?: string;
  best_bid?: string;
  best_ask?: string;
  time?: string;
}

const toNum = (value: string | undefined): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
};

const tsOf = (iso: string | undefined, fallback: number): number => {
  if (iso == null) return fallback;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? fallback : t;
};

/** Parse a `snapshot` message into a normalized OrderBookSnapshotEvent. */
export function parseCoinbaseSnapshot(
  payload: CoinbaseSnapshotPayload,
  symbol: string,
): OrderBookSnapshotEvent | null {
  const bids = (payload.bids ?? []).map(([price, qty]) => ({
    price: toNum(price),
    quantity: toNum(qty),
  }));
  const asks = (payload.asks ?? []).map(([price, qty]) => ({
    price: toNum(price),
    quantity: toNum(qty),
  }));
  if (bids.some((l) => !Number.isFinite(l.price) || !Number.isFinite(l.quantity))) return null;
  if (asks.some((l) => !Number.isFinite(l.price) || !Number.isFinite(l.quantity))) return null;
  return {
    type: 'snapshot',
    provider: 'coinbase',
    symbol,
    instrumentType: INSTRUMENT,
    timestamp: Date.now(),
    sequence: typeof payload.sequence === 'number' ? payload.sequence : 0,
    bids,
    asks,
  };
}

/**
 * Parse an `l2update` message into a normalized OrderBookDeltaEvent.
 * Coinbase level2 deltas carry NO sequence numbers, so firstSequence/finalSequence
 * are undefined — the LocalOrderBook applies them in stream order and gap
 * detection is unavailable on this feed (documented limitation).
 */
export function parseCoinbaseL2Update(
  payload: CoinbaseL2UpdatePayload,
  symbol: string,
): OrderBookDeltaEvent | null {
  const bidUpdates: { price: number; quantity: number }[] = [];
  const askUpdates: { price: number; quantity: number }[] = [];
  for (const [side, priceStr, sizeStr] of payload.changes ?? []) {
    const price = toNum(priceStr);
    const quantity = toNum(sizeStr);
    if (!Number.isFinite(price) || !Number.isFinite(quantity)) return null;
    const level = { price, quantity };
    if (side === 'buy') bidUpdates.push(level);
    else if (side === 'sell') askUpdates.push(level);
  }
  if (bidUpdates.length === 0 && askUpdates.length === 0) return null;
  return {
    type: 'delta',
    provider: 'coinbase',
    symbol,
    instrumentType: INSTRUMENT,
    timestamp: tsOf(payload.time, Date.now()),
    bidUpdates,
    askUpdates,
  };
}

/** Parse a `match` message into a normalized TradeEvent (`side` = taker side). */
export function parseCoinbaseMatch(
  payload: CoinbaseMatchPayload,
  symbol: string,
): TradeEvent | null {
  const price = toNum(payload.price);
  const quantity = toNum(payload.size);
  if (!Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || quantity <= 0) {
    return null;
  }
  const side = payload.side;
  return {
    type: 'trade',
    provider: 'coinbase',
    symbol,
    instrumentType: INSTRUMENT,
    timestamp: tsOf(payload.time, Date.now()),
    tradeId: String(payload.trade_id ?? ''),
    price,
    baseQuantity: quantity,
    quoteNotional: price * quantity,
    aggressorSide: side === 'buy' ? 'buy' : side === 'sell' ? 'sell' : 'unknown',
    isEstimated: false,
  };
}

/** Parse a `ticker` message into a normalized ReferencePriceEvent. */
export function parseCoinbaseTicker(
  payload: CoinbaseTickerPayload,
  symbol: string,
): ReferencePriceEvent | null {
  const bid = toNum(payload.best_bid);
  const ask = toNum(payload.best_ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  return {
    type: 'reference-price',
    provider: 'coinbase',
    symbol,
    instrumentType: INSTRUMENT,
    timestamp: tsOf(payload.time, Date.now()),
    bid,
    ask,
    midpoint: (bid + ask) / 2,
    isDelayed: false,
    isStale: false,
  };
}

/**
 * MODE A — Coinbase spot `PAXG-USD` public order flow. Keyless, free.
 * Verified live 2026-08-13:
 *  - WS `level2_batch`: full snapshot + incremental l2update deltas
 *    (zero-size deletes a level; deltas carry no sequence numbers);
 *  - WS `matches`: executed trades with taker side (`side` field);
 *  - WS `ticker`: best bid/ask reference.
 * Reconnect: full resync from a fresh snapshot (no sequence gap recovery possible).
 */
export class CoinbaseAdapter implements MarketDataAdapter {
  readonly provider = 'coinbase';
  readonly symbol: string;
  readonly capabilities: AdapterCapabilities = {
    orderBook: true,
    trades: true,
    aggressorSide: true,
    liquidations: false,
    live: true,
  };

  private readonly wsUrl: string;
  private readonly onEvent: (event: MarketEvent) => void;
  private readonly onStatus: (status: ConnectionStatus) => void;
  private readonly onFeed?: (entry: FeedEntry) => void;

  private socket: WebSocket | null = null;
  private closed = false;
  private reconnectAttempts = 0;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMessageAt = 0;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private forceTimer: ReturnType<typeof setInterval> | null = null;
  private readonly forceReconnectMs: number;
  private state: ConnectionStatus['state'] = 'idle';
  private bufferedDeltas: OrderBookDeltaEvent[] = [];
  private snapshotEmitted = false;

  constructor(options: CoinbaseAdapterOptions) {
    this.wsUrl = options.wsUrl ?? 'wss://ws-feed.exchange.coinbase.com';
    this.symbol = options.symbol ?? 'PAXG-USD';
    this.forceReconnectMs = options.forceReconnectMs ?? 0;
    this.onEvent = options.onEvent;
    this.onStatus = options.onStatus;
    this.onFeed = options.onFeed;
  }

  async connect(): Promise<void> {
    this.closed = false;
    this.setStatus('connecting');
    this.openSocket();
    this.staleTimer = setInterval(() => {
      if (this.state === 'connected' && this.lastMessageAt > 0 && Date.now() - this.lastMessageAt > 60_000) {
        this.setStatus('stale', 'no messages for 60s');
        this.reconnect();
      }
    }, 10_000);
    if (this.forceReconnectMs > 0) {
      this.forceTimer = setInterval(() => this.socket?.close(), this.forceReconnectMs);
    }
  }

  disconnect(): void {
    this.closed = true;
    if (this.backoffTimer != null) clearTimeout(this.backoffTimer);
    if (this.staleTimer != null) clearInterval(this.staleTimer);
    if (this.forceTimer != null) clearInterval(this.forceTimer);
    this.socket?.close();
    this.socket = null;
    this.setStatus('idle');
  }

  getHealth(): ConnectionStatus {
    return {
      provider: this.provider,
      state: this.state,
      lastMessageAt: this.lastMessageAt,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  private openSocket(): void {
    if (this.closed) return;
    const socket = new WebSocket(this.wsUrl);
    this.socket = socket;

    socket.on('open', () => {
      if (this.closed) return;
      this.reconnectAttempts = 0;
      this.setStatus('connected');
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          product_ids: [this.symbol],
          channels: ['level2_batch', 'matches', 'ticker'],
        }),
      );
    });

    socket.on('message', (data) => {
      this.lastMessageAt = Date.now();
      this.handleMessage(String(data));
    });

    socket.on('close', () => {
      if (this.closed) return;
      this.reconnect();
    });

    socket.on('error', () => {
      // close handler triggers reconnect.
    });
  }

  private reconnect(): void {
    this.socket?.close();
    this.socket = null;
    this.bufferedDeltas = [];
    this.snapshotEmitted = false;
    if (this.closed) return;
    this.setStatus('reconnecting', `attempt ${this.reconnectAttempts + 1}`);
    const backoff =
      Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempts, 6)) *
      (0.8 + Math.random() * 0.4); // jitter
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 8) {
      this.setStatus('failed', 'max reconnect attempts exceeded');
      return;
    }
    this.backoffTimer = setTimeout(() => this.openSocket(), backoff);
  }

  private handleMessage(raw: string): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return; // malformed frame — drop safely
    }
    if (payload.type === 'error') {
      this.onFeed?.({ kind: 'warning', text: `Coinbase WS error: ${String(payload.message ?? '')}`, ts: Date.now() });
      return;
    }
    if (payload.type === 'snapshot') {
      this.emitSnapshot(payload as unknown as CoinbaseSnapshotPayload);
    } else if (payload.type === 'l2update') {
      this.bufferOrEmitDelta(payload as unknown as CoinbaseL2UpdatePayload);
    } else if (payload.type === 'match') {
      const trade = parseCoinbaseMatch(payload as unknown as CoinbaseMatchPayload, this.symbol);
      if (trade != null) this.onEvent(trade);
    } else if (payload.type === 'ticker') {
      const reference = parseCoinbaseTicker(payload as unknown as CoinbaseTickerPayload, this.symbol);
      if (reference != null) this.onEvent(reference);
    }
  }

  private emitSnapshot(payload: CoinbaseSnapshotPayload): void {
    if (this.snapshotEmitted) return;
    const snapshot = parseCoinbaseSnapshot(payload, this.symbol);
    if (snapshot == null) {
      this.onFeed?.({ kind: 'warning', text: 'Coinbase snapshot malformed — waiting for next', ts: Date.now() });
      return;
    }
    this.onEvent(snapshot);
    this.snapshotEmitted = true;
    const buffered = this.bufferedDeltas;
    this.bufferedDeltas = [];
    for (const delta of buffered) this.onEvent(delta);
  }

  private bufferOrEmitDelta(payload: CoinbaseL2UpdatePayload): void {
    const delta = parseCoinbaseL2Update(payload, this.symbol);
    if (delta == null) return;
    if (!this.snapshotEmitted) {
      if (this.bufferedDeltas.length < 10_000) this.bufferedDeltas.push(delta);
    } else {
      this.onEvent(delta);
    }
  }

  private setStatus(state: ConnectionStatus['state'], staleReason?: string): void {
    this.state = state;
    this.onStatus({
      provider: 'coinbase',
      state,
      lastMessageAt: this.lastMessageAt || Date.now(),
      reconnectAttempts: this.reconnectAttempts,
      staleReason,
    });
  }
}
