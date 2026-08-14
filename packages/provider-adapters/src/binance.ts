import WebSocket from 'ws';
import type { ConnectionStatus, FeedEntry, MarketEvent } from '@gb/market-types';
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS } from '@gb/shared-config';
import type { AdapterCapabilities, AdapterHandlers, MarketDataAdapter } from './index';

export interface BinanceAdapterOptions extends AdapterHandlers {
  wsUrl?: string;
  restUrl?: string;
  symbol?: string;
  /**
   * Testing hook: force a socket close every N ms to exercise the documented
   * reconnect + snapshot-resync path (default: 0 = disabled).
   */
  forceReconnectMs?: number;
}

interface BinanceDepthPayload {
  lastUpdateId?: number;
  U?: number;
  u?: number;
  bids?: [string, string][];
  asks?: [string, string][];
}

/**
 * MODE A — Binance spot `PAXG/USDC` public order flow.
 * Verified 2026-08-13 against official docs:
 *  - `aggTrade` `m` flag (buyer is maker) ⇒ aggressor is SELL when true;
 *  - depth stream correctness via `U`/`u`/`lastUpdateId` sequence protocol
 *    (spot streams have NO checksums);
 *  - REST snapshot + buffered deltas per the documented local-book procedure.
 */
export class BinanceAdapter implements MarketDataAdapter {
  readonly provider = 'binance';
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
  /** Lowercase symbol used in stream names (Binance streams are lowercase). */
  private readonly streamSymbol: string;
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
  private bufferedDeltas: MarketEvent[] = [];
  private snapshotEmitted = false;

  constructor(options: BinanceAdapterOptions) {
    this.wsUrl = options.wsUrl ?? 'wss://stream.binance.com:9443';
    this.restUrl = options.restUrl ?? 'https://api.binance.com';
    this.symbol = (options.symbol ?? 'PAXGUSDC').toUpperCase();
    this.streamSymbol = this.symbol.toLowerCase();
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
    const streams = [
      `${this.streamSymbol}@aggTrade`,
      `${this.streamSymbol}@bookTicker`,
      `${this.streamSymbol}@depth@100ms`,
    ].join('/');
    const url = `${this.wsUrl}/stream?streams=${streams}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.on('open', () => {
      if (this.closed) return;
      this.reconnectAttempts = 0;
      this.setStatus('connected');
      this.fetchSnapshot();
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
    const backoff = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempts, 6),
    ) * (0.8 + Math.random() * 0.4); // jitter
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 8) {
      this.setStatus('failed', 'max reconnect attempts exceeded');
      return;
    }
    this.backoffTimer = setTimeout(() => this.openSocket(), backoff);
  }

  private async fetchSnapshot(): Promise<void> {
    try {
      const response = await fetch(
        `${this.restUrl}/api/v3/depth?symbol=${this.symbol}&limit=1000`,
      );
      if (response.status === 451) {
        this.setStatus('failed', 'geo-restricted (HTTP 451) — try another mode');
        this.onFeed?.({
          kind: 'warning',
          text: 'Binance geo-restricted from this region — falling back',
          ts: Date.now(),
        });
        return;
      }
      if (!response.ok) throw new Error(`depth HTTP ${response.status}`);
      const payload = (await response.json()) as BinanceDepthPayload;
      this.onEvent({
        type: 'snapshot',
        provider: 'binance',
        symbol: this.symbol,
        instrumentType: 'tokenized-gold-spot',
        timestamp: Date.now(),
        sequence: payload.lastUpdateId ?? 0,
        bids: (payload.bids ?? []).map(([price, qty]) => ({ price: Number(price), quantity: Number(qty) })),
        asks: (payload.asks ?? []).map(([price, qty]) => ({ price: Number(price), quantity: Number(qty) })),
      });
      this.snapshotEmitted = true;
      // Flush deltas buffered while the snapshot was loading.
      const buffered = this.bufferedDeltas;
      this.bufferedDeltas = [];
      for (const delta of buffered) this.onEvent(delta);
    } catch (error) {
      this.setStatus('failed', error instanceof Error ? error.message : 'snapshot failed');
    }
  }

  private handleMessage(raw: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return; // malformed frame — drop safely
    }
    const envelope = payload as { stream?: string; data?: unknown };
    const stream = envelope.stream ?? '';
    const data = (envelope.data ?? payload) as Record<string, unknown>;

    if (stream.endsWith('@aggTrade') || data.e === 'aggTrade') {
      this.emitTrade(data);
    } else if (stream.endsWith('@bookTicker')) {
      this.emitReference(data);
    } else if (stream.endsWith('@depth@100ms') || data.e === 'depthUpdate') {
      this.bufferOrEmitDelta(data);
    }
  }

  private emitTrade(data: Record<string, unknown>): void {
    const price = Number(data.p);
    const quantity = Number(data.q);
    const m = Boolean(data.m); // buyer is maker ⇒ taker (aggressor) is SELL
    if (!Number.isFinite(price) || !Number.isFinite(quantity)) return;
    this.onEvent({
      type: 'trade',
      provider: 'binance',
      symbol: this.symbol,
      instrumentType: 'tokenized-gold-spot',
      timestamp: Number(data.T) || Date.now(),
      tradeId: String(data.a ?? ''),
      price,
      baseQuantity: quantity,
      quoteNotional: price * quantity,
      aggressorSide: m ? 'sell' : 'buy',
      isEstimated: false,
    });
  }

  private emitReference(data: Record<string, unknown>): void {
    const bid = Number(data.b);
    const ask = Number(data.a);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return;
    this.onEvent({
      type: 'reference-price',
      provider: 'binance',
      symbol: this.symbol,
      instrumentType: 'tokenized-gold-spot',
      timestamp: Number(data.E) || Date.now(),
      bid,
      ask,
      midpoint: (bid + ask) / 2,
      isDelayed: false,
      isStale: false,
    });
  }

  private bufferOrEmitDelta(data: Record<string, unknown>): void {
    const first = Number(data.U);
    const last = Number(data.u);
    const bidUpdates = (data.b as [string, string][] | undefined ?? []).map(([price, qty]) => ({
      price: Number(price),
      quantity: Number(qty),
    }));
    const askUpdates = (data.a as [string, string][] | undefined ?? []).map(([price, qty]) => ({
      price: Number(price),
      quantity: Number(qty),
    }));
    const delta: MarketEvent = {
      type: 'delta',
      provider: 'binance',
      symbol: this.symbol,
      instrumentType: 'tokenized-gold-spot',
      timestamp: Number(data.E) || Date.now(),
      firstSequence: Number.isFinite(first) ? first : undefined,
      finalSequence: Number.isFinite(last) ? last : undefined,
      bidUpdates,
      askUpdates,
    };
    // Buffer until the REST snapshot has been applied downstream.
    if (!this.snapshotEmitted) {
      if (this.bufferedDeltas.length < 10_000) this.bufferedDeltas.push(delta);
    } else {
      this.onEvent(delta);
    }
  }

  private setStatus(state: ConnectionStatus['state'], staleReason?: string): void {
    this.state = state;
    this.onStatus({
      provider: 'binance',
      state,
      lastMessageAt: this.lastMessageAt || Date.now(),
      reconnectAttempts: this.reconnectAttempts,
      staleReason,
    });
  }
}
