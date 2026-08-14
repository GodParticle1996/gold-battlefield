import type { ConnectionStatus, FeedEntry, MarketEvent } from '@gb/market-types';
import type { AdapterCapabilities, AdapterHandlers, MarketDataAdapter } from './index';

export interface SwissquoteAdapterOptions extends AdapterHandlers {
  url?: string;
  pollMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SwissquoteBbo {
  bid: number;
  ask: number;
  ts: number;
}

/**
 * Parse the Swissquote public-quotes payload (verified live 2026-08-13):
 * a JSON array of platforms, each with `spreadProfilePrices` entries; the
 * first platform's first profile is used. Quote-only, no SLA — MODE D.
 */
export function parseSwissquoteBbo(raw: unknown): SwissquoteBbo | null {
  if (!Array.isArray(raw)) return null;
  const platform = raw[0] as
    | { spreadProfilePrices?: unknown; ts?: unknown }
    | undefined;
  if (platform == null || typeof platform !== 'object') return null;
  const profiles = platform.spreadProfilePrices;
  if (!Array.isArray(profiles) || profiles.length === 0) return null;
  const profile = profiles[0] as { bid?: unknown; ask?: unknown } | undefined;
  if (profile == null) return null;
  const bid = Number(profile.bid);
  const ask = Number(profile.ask);
  const ts = typeof platform.ts === 'number' ? platform.ts : Date.now();
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  return { bid, ask, ts };
}

/**
 * MODE D — Swissquote XAU/USD reference price (keyless public BBO endpoint).
 * Polled within conservative limits (≤ 1 req/5 s) with exponential backoff +
 * jitter and stale detection. Quote-only: order-flow features stay disabled;
 * the UI labels this mode "Reference-price visualization. Order flow unavailable."
 */
export class SwissquoteAdapter implements MarketDataAdapter {
  readonly provider = 'swissquote';
  readonly symbol = 'XAU/USD';
  readonly capabilities: AdapterCapabilities = {
    orderBook: false,
    trades: false,
    aggressorSide: false,
    liquidations: false,
    live: true,
  };

  private readonly url: string;
  private readonly pollMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onEvent: (event: MarketEvent) => void;
  private readonly onStatus: (status: ConnectionStatus) => void;
  private readonly onFeed?: (entry: FeedEntry) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private failures = 0;
  private lastMessageAt = 0;
  private state: ConnectionStatus['state'] = 'idle';
  private inFlight = false;

  constructor(options: SwissquoteAdapterOptions) {
    this.url = options.url ?? 'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD';
    this.pollMs = options.pollMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onEvent = options.onEvent;
    this.onStatus = options.onStatus;
    this.onFeed = options.onFeed;
  }

  async connect(): Promise<void> {
    this.closed = false;
    this.setStatus('connecting');
    await this.poll();
    if (this.closed) return;
    this.schedule(this.pollMs);
  }

  disconnect(): void {
    this.closed = true;
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
    this.setStatus('idle');
  }

  getHealth(): ConnectionStatus {
    return {
      provider: this.provider,
      state: this.state,
      lastMessageAt: this.lastMessageAt,
      reconnectAttempts: this.failures,
    };
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      void this.poll().then(() => {
        if (this.closed) return;
        const delay =
          this.failures > 0
            ? Math.min(60_000, this.pollMs * 2 ** Math.min(this.failures, 4)) * (0.8 + Math.random() * 0.4)
            : this.pollMs;
        this.schedule(delay);
      });
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (this.inFlight || this.closed) return;
    this.inFlight = true;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await this.fetchImpl(this.url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bbo = parseSwissquoteBbo(await response.json());
      if (bbo == null) throw new Error('unparseable payload');
      this.failures = 0;
      this.lastMessageAt = Date.now();
      this.setStatus('connected');
      this.onEvent({
        type: 'reference-price',
        provider: this.provider,
        symbol: this.symbol,
        instrumentType: 'spot-reference',
        timestamp: bbo.ts,
        bid: bbo.bid,
        ask: bbo.ask,
        midpoint: (bbo.bid + bbo.ask) / 2,
        // Polled quotes: delayed by nature — never called "real-time" (spec §4/§8).
        isDelayed: true,
        isStale: false,
      });
    } catch (error) {
      this.failures += 1;
      if (this.failures >= 3) {
        this.setStatus('stale', `poll failed ${this.failures}× (${error instanceof Error ? error.message : 'network error'})`);
        this.onFeed?.({
          kind: 'stale',
          text: 'Swissquote reference price stale — last successful update shown',
          ts: Date.now(),
        });
      }
    } finally {
      this.inFlight = false;
    }
  }

  private setStatus(state: ConnectionStatus['state'], staleReason?: string): void {
    this.state = state;
    this.onStatus({
      provider: this.provider,
      state,
      lastMessageAt: this.lastMessageAt || Date.now(),
      reconnectAttempts: this.failures,
      staleReason,
    });
  }
}
