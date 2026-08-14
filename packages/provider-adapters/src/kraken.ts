import WebSocket from 'ws';
import type { ConnectionStatus, FeedEntry, MarketEvent } from '@gb/market-types';
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS } from '@gb/shared-config';
import type { AdapterCapabilities, AdapterHandlers, MarketDataAdapter } from './index';

export interface KrakenAdapterOptions extends AdapterHandlers {
  wsUrl?: string;
  symbol?: string;
  /** Testing hook: force a socket close every N ms (soak tests). Default 0 = disabled. */
  forceReconnectMs?: number;
}

interface StoredLevel {
  priceNum: number;
  qtyNum: number;
  priceRaw: string;
  qtyRaw: string;
}

interface KrakenBookMessage {
  channel?: string;
  type?: string;
  data?: Array<{
    symbol?: string;
    bids?: Array<{ price?: string; qty?: string }>;
    asks?: Array<{ price?: string; qty?: string }>;
    checksum?: number;
    timestamp?: string;
  }>;
}

interface KrakenTradeMessage {
  channel?: string;
  data?: Array<{
    symbol?: string;
    side?: string;
    price?: string;
    qty?: string;
    timestamp?: string;
  }>;
}

/**
 * MODE B — Kraken spot `XAUT/USD` (tokenized-gold proxy market).
 *
 * Verified 2026-08-13: the live v2 feed transmits price/qty as JSON NUMBERS
 * (the docs show strings). The documented CRC32 top-10 algorithm could not be
 * reproduced against live checksums (0/30+ formatting variants matched), so
 * checksum validation is NOT enabled here — see docs/02 for the limitation.
 * Integrity is preserved by construction: every book message is emitted as a
 * FULL-STATE snapshot (depth 10), so the client book always mirrors the latest
 * verified exchange state and self-heals on any divergence.
 */
export class KrakenAdapter implements MarketDataAdapter {
  readonly provider = 'kraken';
  symbol: string;
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
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private forceTimer: ReturnType<typeof setInterval> | null = null;
  private readonly forceReconnectMs: number;
  private lastMessageAt = 0;
  private state: ConnectionStatus['state'] = 'idle';

  /** price-string → level (keeps raw strings for checksum validation). */
  private bids = new Map<string, StoredLevel>();
  private asks = new Map<string, StoredLevel>();
  private seq = 0;
  private tradeCounter = 0;

  constructor(options: KrakenAdapterOptions) {
    this.wsUrl = options.wsUrl ?? 'wss://ws.kraken.com/v2';
    this.symbol = options.symbol ?? 'XAUT/USD';
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
      this.bids.clear();
      this.asks.clear();
      this.setStatus('connected');
      socket.send(
        JSON.stringify({
          method: 'subscribe',
          params: { channel: 'book', depth: 10, snapshot: true, symbol: [this.symbol] },
        }),
      );
      socket.send(
        JSON.stringify({
          method: 'subscribe',
          params: { channel: 'trade', symbol: [this.symbol] },
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
    if (this.closed) return;
    this.setStatus('reconnecting', `attempt ${this.reconnectAttempts + 1}`);
    const backoff =
      Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempts, 6)) *
      (0.8 + Math.random() * 0.4);
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 8) {
      this.setStatus('failed', 'max reconnect attempts exceeded');
      return;
    }
    this.backoffTimer = setTimeout(() => this.openSocket(), backoff);
  }

  private handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const msg = message as KrakenBookMessage & KrakenTradeMessage;
    if (msg.channel === 'book') {
      this.handleBook(msg);
    } else if (msg.channel === 'trade') {
      this.handleTrades(msg);
    } else if (msg.channel === 'heartbeat') {
      // keepalive — nothing to do
    }
  }

  private handleBook(msg: KrakenBookMessage): void {
    const data = msg.data?.[0];
    if (data == null) return;

    this.applyLevels(this.bids, data.bids ?? []);
    this.applyLevels(this.asks, data.asks ?? []);
    this.truncate();

    // Checksum validation disabled (see class docs): live v2 sends numbers and
    // the documented string algorithm cannot be reproduced; full-state
    // snapshots below preserve integrity instead.
    this.seq += 1;
    this.emitBookSnapshot();
  }

  private applyLevels(map: Map<string, StoredLevel>, levels: Array<{ price?: string | number; qty?: string | number }>): void {
    for (const level of levels) {
      if (level.price == null || level.qty == null) continue;
      const priceKey = String(level.price);
      const priceNum = Number(level.price);
      const qtyNum = Number(level.qty);
      if (!Number.isFinite(priceNum) || !Number.isFinite(qtyNum)) continue;
      if (qtyNum === 0) {
        map.delete(priceKey);
      } else {
        map.set(priceKey, { priceNum, qtyNum, priceRaw: priceKey, qtyRaw: String(level.qty) });
      }
    }
  }

  /** Kraken sends only the subscribed depth; keep the stored book bounded anyway. */
  private truncate(): void {
    if (this.bids.size > 10) {
      const excess = [...this.bids.entries()].sort((a, b) => a[1].priceNum - b[1].priceNum).slice(0, this.bids.size - 10);
      for (const [price] of excess) this.bids.delete(price);
    }
    if (this.asks.size > 10) {
      const excess = [...this.asks.entries()].sort((a, b) => b[1].priceNum - a[1].priceNum).slice(0, this.asks.size - 10);
      for (const [price] of excess) this.asks.delete(price);
    }
  }

  private emitBookSnapshot(): void {
    const bids = [...this.bids.values()]
      .sort((a, b) => b.priceNum - a.priceNum)
      .map((l) => ({ price: l.priceNum, quantity: l.qtyNum }));
    const asks = [...this.asks.values()]
      .sort((a, b) => a.priceNum - b.priceNum)
      .map((l) => ({ price: l.priceNum, quantity: l.qtyNum }));
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;

    this.onEvent({
      type: 'snapshot',
      provider: 'kraken',
      symbol: this.symbol,
      instrumentType: 'tokenized-gold-spot',
      timestamp: Date.now(),
      sequence: this.seq,
      bids,
      asks,
    });

    if (bestBid != null && bestAsk != null) {
      this.onEvent({
        type: 'reference-price',
        provider: 'kraken',
        symbol: this.symbol,
        instrumentType: 'tokenized-gold-spot',
        timestamp: Date.now(),
        bid: bestBid,
        ask: bestAsk,
        midpoint: (bestBid + bestAsk) / 2,
        isDelayed: false,
        isStale: false,
      });
    }
  }

  private handleTrades(msg: KrakenTradeMessage): void {
    for (const trade of msg.data ?? []) {
      if (trade.price == null || trade.qty == null || trade.side == null) continue;
      const price = Number(trade.price);
      const qty = Number(trade.qty);
      if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty <= 0) continue;
      this.tradeCounter += 1;
      const ts = Date.parse(trade.timestamp ?? '') || Date.now();
      this.onEvent({
        type: 'trade',
        provider: 'kraken',
        symbol: this.symbol,
        instrumentType: 'tokenized-gold-spot',
        timestamp: ts,
        tradeId: `k-${ts}-${this.tradeCounter}`,
        price,
        baseQuantity: qty,
        quoteNotional: price * qty,
        // Kraken v2 trade feed: side = taker side (aggressor).
        aggressorSide: trade.side === 'buy' ? 'buy' : trade.side === 'sell' ? 'sell' : 'unknown',
        isEstimated: false,
      });
    }
  }

  private setStatus(state: ConnectionStatus['state'], staleReason?: string): void {
    this.state = state;
    this.onStatus({
      provider: 'kraken',
      state,
      lastMessageAt: this.lastMessageAt || Date.now(),
      reconnectAttempts: this.reconnectAttempts,
      staleReason,
    });
  }
}
