import WebSocket from 'ws';
import type {
  ConnectionStatus,
  FeedEntry,
  MarketEvent,
  OrderBookDeltaEvent,
  OrderBookSnapshotEvent,
  TradeEvent,
} from '@gb/market-types';
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS } from '@gb/shared-config';
import type { AdapterCapabilities, AdapterHandlers, MarketDataAdapter } from './index';

export interface BitstampAdapterOptions extends AdapterHandlers {
  wsUrl?: string;
  restUrl?: string;
  /** Symbol as listed on Bitstamp, e.g. `PAXGUSD`. */
  symbol?: string;
  /**
   * Diff feeds carry no sequence numbers, so a drifted book cannot be detected.
   * Periodically re-fetch the REST book as a self-healing resync (default 5 min).
   */
  resyncIntervalMs?: number;
  /** Testing hook: force a socket close every N ms (soak tests). Default 0 = disabled. */
  forceReconnectMs?: number;
}

const INSTRUMENT = 'tokenized-gold-spot';
const DEFAULT_RESYNC_MS = 300_000;

/** REST `/api/v2/order_book/{pair}/` payload. */
interface BitstampRestBook {
  bids?: [string, string][];
  asks?: [string, string][];
}
/** `data` field of a WS `diff_order_book` message (changed levels only). */
interface BitstampDiffData {
  bids?: [string, string][];
  asks?: [string, string][];
}
/** A WS `live_trades` message. `type`: 0 = buy, 1 = sell (taker side per docs). */
interface BitstampTradeMessage {
  event?: string;
  channel?: string;
  data?: {
    id?: number;
    price?: string;
    amount?: string;
    type?: number;
    microtimestamp?: string;
    timestamp?: string;
  };
}

const toNum = (value: string | number | undefined): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
};

/** Parse the REST order book into a normalized OrderBookSnapshotEvent. */
export function parseBitstampBookSnapshot(
  payload: BitstampRestBook,
  symbol: string,
): OrderBookSnapshotEvent | null {
  const bids = (payload.bids ?? []).map(([price, qty]) => ({ price: toNum(price), quantity: toNum(qty) }));
  const asks = (payload.asks ?? []).map(([price, qty]) => ({ price: toNum(price), quantity: toNum(qty) }));
  if (bids.some((l) => !Number.isFinite(l.price) || !Number.isFinite(l.quantity))) return null;
  if (asks.some((l) => !Number.isFinite(l.price) || !Number.isFinite(l.quantity))) return null;
  return {
    type: 'snapshot',
    provider: 'bitstamp',
    symbol,
    instrumentType: INSTRUMENT,
    timestamp: Date.now(),
    sequence: 0,
    bids,
    asks,
  };
}

/**
 * Parse a `diff_order_book` `data` payload into a delta. Levels with amount `0`
 * are removals. Bitstamp diffs carry NO sequence numbers → the LocalOrderBook
 * applies them in stream order and gap detection is unavailable (documented;
 * mitigated by periodic REST resyncs).
 */
export function parseBitstampDiff(
  data: BitstampDiffData,
  symbol: string,
): OrderBookDeltaEvent | null {
  const bidUpdates = (data.bids ?? []).map(([price, qty]) => ({ price: toNum(price), quantity: toNum(qty) }));
  const askUpdates = (data.asks ?? []).map(([price, qty]) => ({ price: toNum(price), quantity: toNum(qty) }));
  if (bidUpdates.some((l) => !Number.isFinite(l.price) || !Number.isFinite(l.quantity))) return null;
  if (askUpdates.some((l) => !Number.isFinite(l.price) || !Number.isFinite(l.quantity))) return null;
  if (bidUpdates.length === 0 && askUpdates.length === 0) return null;
  return {
    type: 'delta',
    provider: 'bitstamp',
    symbol,
    instrumentType: INSTRUMENT,
    timestamp: Date.now(),
    bidUpdates,
    askUpdates,
  };
}

/**
 * Parse a `live_trades` message into a TradeEvent. `type` is 0 (buy) or 1 (sell)
 * per Bitstamp docs — the taker side; anything else is marked unknown.
 */
export function parseBitstampTrade(
  message: BitstampTradeMessage,
  symbol: string,
): TradeEvent | null {
  const price = toNum(message.data?.price);
  const quantity = toNum(message.data?.amount);
  if (!Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || quantity <= 0) {
    return null;
  }
  const side = message.data?.type;
  return {
    type: 'trade',
    provider: 'bitstamp',
    symbol,
    instrumentType: INSTRUMENT,
    timestamp: Date.now(),
    tradeId: String(message.data?.id ?? ''),
    price,
    baseQuantity: quantity,
    quoteNotional: price * quantity,
    aggressorSide: side === 0 ? 'buy' : side === 1 ? 'sell' : 'unknown',
    isEstimated: false,
  };
}

/**
 * MODE A/B — Bitstamp spot `PAXG/USD` public order flow. Keyless, free.
 * Verified live 2026-08-13:
 *  - `diff_order_book_{pair}` WS channel sends CHANGED levels only (no initial
 *    book, no sequence numbers); `0.000000` amount deletes a level;
 *  - initial book comes from the REST `/api/v2/order_book/{pair}/` endpoint
 *    (lowercase slug; uppercase 404s — verified);
 *  - `live_trades_{pair}` carries the taker side (`type` 0 buy / 1 sell per docs;
 *    PAXG trades are rare — parse unit-tested, not yet live-captured);
 *  - the server may send `bts:request_reconnect` — handled by reconnecting.
 * Reconnect/self-healing: fresh REST snapshot on (re)connect + every 5 min.
 */
export class BitstampAdapter implements MarketDataAdapter {
  readonly provider = 'bitstamp';
  readonly symbol: string;
  readonly capabilities: AdapterCapabilities = {
    orderBook: true,
    trades: true,
    aggressorSide: true,
    liquidations: false,
    live: true,
  };

  private readonly wsUrl: string;
  private readonly restUrl: string;
  /** Lowercase pair slug used in URLs/channels: PAXGUSD → paxgusd. */
  private readonly pair: string;
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
  private resyncTimer: ReturnType<typeof setInterval> | null = null;
  private readonly resyncIntervalMs: number;
  private readonly forceReconnectMs: number;
  private state: ConnectionStatus['state'] = 'idle';
  private bufferedDeltas: OrderBookDeltaEvent[] = [];
  private snapshotEmitted = false;

  constructor(options: BitstampAdapterOptions) {
    this.wsUrl = options.wsUrl ?? 'wss://ws.bitstamp.net';
    this.restUrl = options.restUrl ?? 'https://www.bitstamp.net';
    this.symbol = (options.symbol ?? 'PAXGUSD').toUpperCase();
    this.pair = this.symbol.toLowerCase();
    this.resyncIntervalMs = options.resyncIntervalMs ?? DEFAULT_RESYNC_MS;
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
    // Periodic full-book resync: diff feeds cannot detect drift (no sequences).
    this.resyncTimer = setInterval(() => {
      if (this.state === 'connected') void this.fetchSnapshot(true);
    }, this.resyncIntervalMs);
    if (this.forceReconnectMs > 0) {
      this.forceTimer = setInterval(() => this.socket?.close(), this.forceReconnectMs);
    }
  }

  disconnect(): void {
    this.closed = true;
    if (this.backoffTimer != null) clearTimeout(this.backoffTimer);
    if (this.staleTimer != null) clearInterval(this.staleTimer);
    if (this.resyncTimer != null) clearInterval(this.resyncTimer);
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
      socket.send(JSON.stringify({ event: 'bts:subscribe', data: { channel: `diff_order_book_${this.pair}` } }));
      socket.send(JSON.stringify({ event: 'bts:subscribe', data: { channel: `live_trades_${this.pair}` } }));
      void this.fetchSnapshot(false);
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

  private async fetchSnapshot(periodic: boolean): Promise<void> {
    try {
      const response = await fetch(`${this.restUrl}/api/v2/order_book/${this.pair}/`);
      if (!response.ok) throw new Error(`order book HTTP ${response.status}`);
      const payload = (await response.json()) as BitstampRestBook;
      const snapshot = parseBitstampBookSnapshot(payload, this.symbol);
      if (snapshot == null) {
        this.onFeed?.({ kind: 'warning', text: 'Bitstamp REST book malformed', ts: Date.now() });
        return;
      }
      this.onEvent(snapshot);
      this.snapshotEmitted = true;
      // Reference price from the REST book's best bid/ask (delayed by nature —
      // polled at the resync cadence; used by the aggregated composite too).
      // Max/min rather than index 0: the REST payload ordering is not contractual.
      const bid = snapshot.bids.reduce((best, level) => Math.max(best, level.price), 0);
      const ask = snapshot.asks.reduce((best, level) => Math.min(best, level.price), Number.POSITIVE_INFINITY);
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
        this.onEvent({
          type: 'reference-price',
          provider: 'bitstamp',
          symbol: this.symbol,
          instrumentType: INSTRUMENT,
          timestamp: Date.now(),
          bid,
          ask,
          midpoint: (bid + ask) / 2,
          isDelayed: true,
          isStale: false,
        });
      }
      // Flush deltas buffered while the snapshot was loading (or since the last resync).
      const buffered = this.bufferedDeltas;
      this.bufferedDeltas = [];
      for (const delta of buffered) this.onEvent(delta);
      if (periodic) {
        this.onFeed?.({ kind: 'provider-change', text: 'Bitstamp periodic book resync applied', ts: Date.now() });
      }
    } catch (error) {
      this.setStatus('failed', error instanceof Error ? error.message : 'snapshot failed');
    }
  }

  private handleMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return; // malformed frame — drop safely
    }
    const event = message.event;
    if (event === 'data') {
      this.bufferOrEmitDiff(message.data as BitstampDiffData);
    } else if (event === 'trade') {
      const trade = parseBitstampTrade(message as unknown as BitstampTradeMessage, this.symbol);
      if (trade != null) this.onEvent(trade);
    } else if (event === 'bts:request_reconnect') {
      // Bitstamp asks clients to reconnect when it restarts its WS infrastructure.
      this.socket?.close();
    }
    // 'bts:subscription_succeeded' needs no processing.
  }

  private bufferOrEmitDiff(data: BitstampDiffData): void {
    const delta = parseBitstampDiff(data, this.symbol);
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
      provider: 'bitstamp',
      state,
      lastMessageAt: this.lastMessageAt || Date.now(),
      reconnectAttempts: this.reconnectAttempts,
      staleReason,
    });
  }
}
