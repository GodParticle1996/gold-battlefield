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

export interface GeminiAdapterOptions extends AdapterHandlers {
  /** Base marketdata URL without query params, e.g. `wss://api.gemini.com/v1/marketdata/PAXGUSD`. */
  wsUrl?: string;
  /** Symbol as listed on Gemini, e.g. `PAXGUSD`. */
  symbol?: string;
  /** Testing hook: force a socket close every N ms (soak tests). Default 0 = disabled. */
  forceReconnectMs?: number;
}

const INSTRUMENT = 'tokenized-gold-spot';

/** Order-book change event. `remaining` is the CUMULATIVE size at the price level. */
interface GeminiChangeEvent {
  type?: string;
  side?: string; // 'bid' | 'ask'
  price?: string;
  remaining?: string; // absolute level size; '0' deletes the level
  delta?: string; // not used for book reconstruction (remaining is authoritative)
  reason?: string; // 'initial' | 'place' | 'cancel'
}
interface GeminiTradeEvent {
  type?: string;
  tid?: number;
  price?: string;
  amount?: string;
  quantity?: string;
  makerSide?: string;
  takerSide?: string;
  side?: string;
  timestampms?: number;
  timestamp?: number;
}
interface GeminiUpdatePayload {
  type?: string;
  events?: unknown[];
  socket_sequence?: number;
  eventId?: number;
  timestampms?: number;
}
interface GeminiTickerPayload {
  type?: string;
  symbol?: string;
  bid?: string;
  ask?: string;
  last?: string;
  timestampms?: number;
}

const toNum = (value: string | number | undefined): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
};

/**
 * Extract per-side level updates from an `update` message's change events.
 * `remaining` is absolute — the LocalOrderBook sets (not accumulates) level
 * quantity, and `remaining: 0` deletes the level.
 */
function parseGeminiChanges(
  events: unknown[],
  symbol: string,
): { bidUpdates: { price: number; quantity: number }[]; askUpdates: { price: number; quantity: number }[] } | null {
  const bidUpdates: { price: number; quantity: number }[] = [];
  const askUpdates: { price: number; quantity: number }[] = [];
  for (const raw of events) {
    const event = raw as GeminiChangeEvent;
    if (event.type !== 'change') continue;
    const price = toNum(event.price);
    const quantity = toNum(event.remaining);
    if (!Number.isFinite(price) || !Number.isFinite(quantity)) return null;
    const level = { price, quantity };
    if (event.side === 'bid') bidUpdates.push(level);
    else if (event.side === 'ask') askUpdates.push(level);
  }
  return { bidUpdates, askUpdates };
}

/**
 * Build the initial full book from the FIRST `update` message on a socket
 * (change events carry `reason: 'initial'`). The snapshot uses the initial
 * update's OWN socket_sequence (0 on a fresh socket) so the first incremental
 * delta (sequence 1) applies cleanly; falls back to 1 if absent.
 */
export function parseGeminiInitialSnapshot(
  payload: GeminiUpdatePayload,
  symbol: string,
): OrderBookSnapshotEvent | null {
  const changes = parseGeminiChanges(payload.events ?? [], symbol);
  if (changes == null) return null;
  const bids = changes.bidUpdates.filter((level) => level.quantity > 0);
  const asks = changes.askUpdates.filter((level) => level.quantity > 0);
  if (bids.length === 0 && asks.length === 0) return null;
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  return {
    type: 'snapshot',
    provider: 'gemini',
    symbol,
    instrumentType: INSTRUMENT,
    timestamp: payload.timestampms ?? Date.now(),
    sequence: typeof payload.socket_sequence === 'number' ? payload.socket_sequence : 1,
    bids,
    asks,
  };
}

/**
 * Build a delta from an incremental `update` message. Gemini provides
 * `socket_sequence` (per-socket, contiguous) → real gap detection downstream.
 */
export function parseGeminiDelta(
  payload: GeminiUpdatePayload,
  symbol: string,
): OrderBookDeltaEvent | null {
  const changes = parseGeminiChanges(payload.events ?? [], symbol);
  if (changes == null) return null;
  if (changes.bidUpdates.length === 0 && changes.askUpdates.length === 0) return null;
  const sequence = payload.socket_sequence;
  return {
    type: 'delta',
    provider: 'gemini',
    symbol,
    instrumentType: INSTRUMENT,
    timestamp: payload.timestampms ?? Date.now(),
    firstSequence: typeof sequence === 'number' ? sequence : undefined,
    finalSequence: typeof sequence === 'number' ? sequence : undefined,
    bidUpdates: changes.bidUpdates,
    askUpdates: changes.askUpdates,
  };
}

/** Parse a trade event (`takerSide`/`side` = aggressor). Block trades included, side unknown when absent. */
export function parseGeminiTrade(event: unknown, symbol: string): TradeEvent | null {
  const trade = event as GeminiTradeEvent;
  if (trade.type !== 'trade' && trade.type !== 'block_trade') return null;
  const price = toNum(trade.price);
  const quantity = toNum(trade.amount ?? trade.quantity);
  if (!Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || quantity <= 0) {
    return null;
  }
  const taker = trade.takerSide ?? trade.side;
  return {
    type: 'trade',
    provider: 'gemini',
    symbol,
    instrumentType: INSTRUMENT,
    timestamp: trade.timestampms ?? trade.timestamp ?? Date.now(),
    tradeId: String(trade.tid ?? ''),
    price,
    baseQuantity: quantity,
    quoteNotional: price * quantity,
    aggressorSide: taker === 'buy' ? 'buy' : taker === 'sell' ? 'sell' : 'unknown',
    isEstimated: false,
  };
}

/** Parse a `ticker` message into a ReferencePriceEvent. */
export function parseGeminiTicker(payload: GeminiTickerPayload, symbol: string): ReferencePriceEvent | null {
  const bid = toNum(payload.bid);
  const ask = toNum(payload.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  return {
    type: 'reference-price',
    provider: 'gemini',
    symbol,
    instrumentType: INSTRUMENT,
    timestamp: payload.timestampms ?? Date.now(),
    bid,
    ask,
    midpoint: (bid + ask) / 2,
    isDelayed: false,
    isStale: false,
  };
}

/**
 * MODE A/B — Gemini spot `PAXGUSD` public order flow. Keyless, free.
 * Verified live 2026-08-13:
 *  - WS marketdata (NO heartbeat param — verified 2026-08-13 that heartbeats
 *    consume socket_sequence slots and cause false gaps): first `update` =
 *    FULL initial book (change events with `reason: 'initial'`, socket_sequence
 *    0); later updates = incremental changes whose `remaining` is the
 *    CUMULATIVE level size (0 = delete);
 *  - `socket_sequence` on incremental updates (contiguous 1..N, verified 0 gaps
 *    over 195 updates) → sequence-gap detection;
 *  - trade events carry taker side (`takerSide`); ticker gives best bid/ask.
 * Reconnect: fresh socket → fresh initial book (full resync).
 */
export class GeminiAdapter implements MarketDataAdapter {
  readonly provider = 'gemini';
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

  constructor(options: GeminiAdapterOptions) {
    this.wsUrl = options.wsUrl ?? 'wss://api.gemini.com/v1/marketdata/PAXGUSD';
    this.symbol = options.symbol ?? 'PAXGUSD';
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
    // No heartbeat param: heartbeats consume socket_sequence slots and would
    // create false sequence gaps (verified live 2026-08-13). Liveness is
    // covered by the stale timer below (60 s without any message).
    const socket = new WebSocket(this.wsUrl);
    this.socket = socket;

    socket.on('open', () => {
      if (this.closed) return;
      this.reconnectAttempts = 0;
      this.setStatus('connected');
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          subscriptions: [
            { name: 'l2', symbols: [this.symbol] },
            { name: 'trade', symbols: [this.symbol] },
            { name: 'ticker', symbols: [this.symbol] },
          ],
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
    const type = payload.type;
    if (type === 'update') {
      this.handleUpdate(payload as unknown as GeminiUpdatePayload);
    } else if (type === 'trade') {
      const trade = parseGeminiTrade(payload, this.symbol);
      if (trade != null) this.onEvent(trade);
    } else if (type === 'ticker') {
      const reference = parseGeminiTicker(payload as unknown as GeminiTickerPayload, this.symbol);
      if (reference != null) this.onEvent(reference);
    }
    // 'heartbeat' and 'subscription_ack' need no processing (heartbeat keeps staleness fresh).
  }

  private handleUpdate(payload: GeminiUpdatePayload): void {
    const events = payload.events ?? [];
    // Any trade/block_trade events ride inside update messages.
    for (const event of events) {
      const trade = parseGeminiTrade(event, this.symbol);
      if (trade != null) this.onEvent(trade);
    }
    if (!this.snapshotEmitted) {
      const snapshot = parseGeminiInitialSnapshot(payload, this.symbol);
      if (snapshot == null) return; // malformed initial book — wait for next message
      this.onEvent(snapshot);
      this.snapshotEmitted = true;
      const buffered = this.bufferedDeltas;
      this.bufferedDeltas = [];
      for (const delta of buffered) this.onEvent(delta);
      return;
    }
    const delta = parseGeminiDelta(payload, this.symbol);
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
      provider: 'gemini',
      state,
      lastMessageAt: this.lastMessageAt || Date.now(),
      reconnectAttempts: this.reconnectAttempts,
      staleReason,
    });
  }
}
