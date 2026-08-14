import type { ConnectionStatus, FeedEntry, MarketEvent } from '@gb/market-types';
import type { AdapterCapabilities, AdapterHandlers, MarketDataAdapter } from './index';
import { BinanceAdapter } from './binance';
import { BitstampAdapter } from './bitstamp';
import { CoinbaseAdapter } from './coinbase';
import { GeminiAdapter } from './gemini';
import { KrakenAdapter } from './kraken';

export interface AggregatedAdapterOptions extends AdapterHandlers {
  binance?: { wsUrl?: string; restUrl?: string };
  kraken?: { wsUrl?: string };
  coinbase?: { wsUrl?: string };
  gemini?: { wsUrl?: string };
  bitstamp?: { wsUrl?: string; restUrl?: string };
  symbol?: string;
  /** Testing hook passed through to live venues (forced reconnects). */
  forceReconnectMs?: number;
}

/** Preferred order for the primary order book (most liquid first). */
export const VENUE_ORDER = ['binance', 'kraken', 'coinbase', 'gemini', 'bitstamp'] as const;

/** Average of available venue midpoints (USD/oz, directly comparable for gold tokens). */
export function compositeMidpoint(midpoints: number[]): number | null {
  const available = midpoints.filter((m) => Number.isFinite(m) && m > 0);
  if (available.length === 0) return null;
  return available.reduce((a, b) => a + b, 0) / available.length;
}

/**
 * Fraction by which a venue's midpoint may differ from the composite before its
 * prints stop being treated as comparable measurements. Healthy PAXG/XAUT
 * venues track each other well inside 0.1%; 0.2% leaves room for ordinary
 * venue-to-venue basis without admitting a lagging or depegged book.
 */
export const VENUE_TOLERANCE = 0.002;

/**
 * Spec §4 MODE C: "Only aggregate compatible measurements."
 *
 * These venues quote gold tokens against different units (USDC on Binance, USD
 * elsewhere) and a thin or lagging venue can drift dollars away from the rest.
 * Mixing such prints with another venue's order book puts trades at prices that
 * do not exist in the book being displayed, so they are excluded — visibly —
 * rather than silently blended.
 */
export function isVenueComparable(
  own: number | undefined,
  composite: number | null,
  tolerance = VENUE_TOLERANCE,
): boolean {
  // With no basis for comparison there is nothing to exclude on.
  if (own == null || composite == null || composite <= 0) return true;
  return Math.abs(own - composite) / composite <= tolerance;
}

/**
 * Pick the primary book venue: the first venue in preferred order whose health
 * is 'connected'. Returns null while nothing is connected. Called on every
 * venue status change, so recovery to a higher-ranked venue is automatic.
 */
export function pickPrimaryVenue(
  order: readonly string[],
  health: ReadonlyMap<string, ConnectionStatus>,
): string | null {
  for (const venue of order) {
    if (health.get(venue)?.state === 'connected') return venue;
  }
  return null;
}

const WARN_INTERVAL_MS = 30_000;

const LABELS: Record<string, string> = {
  binance: 'Binance',
  kraken: 'Kraken',
  coinbase: 'Coinbase',
  gemini: 'Gemini',
  bitstamp: 'Bitstamp',
};

/**
 * MODE C — aggregated proxy view (spec §4). Combines all verified USD-quoted
 * gold-token venues (Binance PAXG/USDC, Kraken XAUT/USD, Coinbase PAXG-USD,
 * Gemini PAXGUSD, Bitstamp PAXG/USD). This is NOT a consolidated regulated
 * order book:
 *  - the order book shown on the battlefield comes from a single venue
 *    (preferred order: Binance → Kraken → Coinbase → Gemini → Bitstamp;
 *    switches automatically on failure AND back on recovery);
 *  - a composite reference price averages the venues' midpoints;
 *  - trades from every venue are labelled per provider;
 *  - the UI displays "Aggregated proxy view, not a consolidated regulated order book".
 */
export class AggregatedAdapter implements MarketDataAdapter {
  readonly provider = 'aggregated';
  readonly symbol: string;
  readonly capabilities: AdapterCapabilities = {
    orderBook: true,
    trades: true,
    aggressorSide: true,
    liquidations: false,
    live: true,
  };

  private readonly venues: { name: string; adapter: MarketDataAdapter }[];
  private readonly onEvent: (event: MarketEvent) => void;
  private readonly onStatus: (status: ConnectionStatus) => void;
  private readonly onFeed?: (entry: FeedEntry) => void;

  private midpoints = new Map<string, number>();
  private health = new Map<string, ConnectionStatus>();
  private primaryProvider: string | null = 'binance';
  private state: ConnectionStatus['state'] = 'idle';
  private incomparableWarnedAt = new Map<string, number>();

  constructor(options: AggregatedAdapterOptions) {
    this.symbol = options.symbol ?? 'COMPOSITE-XAU';
    this.onEvent = options.onEvent;
    this.onStatus = options.onStatus;
    this.onFeed = options.onFeed;
    const forceReconnectMs = options.forceReconnectMs;
    const venues: { name: string; adapter: MarketDataAdapter }[] = [
      {
        name: 'binance',
        adapter: new BinanceAdapter({
          onEvent: (e) => this.handleVenueEvent('binance', e),
          onStatus: (s) => this.handleVenueStatus('binance', s),
          onFeed: (entry) => this.onFeed?.({ ...entry, text: `[Binance] ${entry.text}` }),
          wsUrl: options.binance?.wsUrl,
          restUrl: options.binance?.restUrl,
          forceReconnectMs,
        }),
      },
      {
        name: 'kraken',
        adapter: new KrakenAdapter({
          onEvent: (e) => this.handleVenueEvent('kraken', e),
          onStatus: (s) => this.handleVenueStatus('kraken', s),
          onFeed: (entry) => this.onFeed?.({ ...entry, text: `[Kraken] ${entry.text}` }),
          wsUrl: options.kraken?.wsUrl,
          forceReconnectMs,
        }),
      },
      {
        name: 'coinbase',
        adapter: new CoinbaseAdapter({
          onEvent: (e) => this.handleVenueEvent('coinbase', e),
          onStatus: (s) => this.handleVenueStatus('coinbase', s),
          onFeed: (entry) => this.onFeed?.({ ...entry, text: `[Coinbase] ${entry.text}` }),
          wsUrl: options.coinbase?.wsUrl,
          forceReconnectMs,
        }),
      },
      {
        name: 'gemini',
        adapter: new GeminiAdapter({
          onEvent: (e) => this.handleVenueEvent('gemini', e),
          onStatus: (s) => this.handleVenueStatus('gemini', s),
          onFeed: (entry) => this.onFeed?.({ ...entry, text: `[Gemini] ${entry.text}` }),
          wsUrl: options.gemini?.wsUrl,
          forceReconnectMs,
        }),
      },
      {
        name: 'bitstamp',
        adapter: new BitstampAdapter({
          onEvent: (e) => this.handleVenueEvent('bitstamp', e),
          onStatus: (s) => this.handleVenueStatus('bitstamp', s),
          onFeed: (entry) => this.onFeed?.({ ...entry, text: `[Bitstamp] ${entry.text}` }),
          wsUrl: options.bitstamp?.wsUrl,
          restUrl: options.bitstamp?.restUrl,
          forceReconnectMs,
        }),
      },
    ];
    this.venues = venues;
  }

  async connect(): Promise<void> {
    this.setStatus('connecting');
    this.onFeed?.({
      kind: 'provider-change',
      text: 'Aggregated proxy view, not a consolidated regulated order book',
      ts: Date.now(),
    });
    await Promise.allSettled(this.venues.map((v) => v.adapter.connect()));
    this.emitAggregateStatus();
  }

  disconnect(): void {
    for (const venue of this.venues) venue.adapter.disconnect();
    this.setStatus('idle');
  }

  getHealth(): ConnectionStatus {
    return {
      provider: this.provider,
      state: this.state,
      lastMessageAt: Math.max(0, ...this.venues.map((v) => v.adapter.getHealth().lastMessageAt)),
      reconnectAttempts: this.venues.reduce((sum, v) => sum + v.adapter.getHealth().reconnectAttempts, 0),
      staleReason: this.state === 'failed' ? 'all venues failed' : undefined,
    };
  }

  private handleVenueEvent(venue: string, event: MarketEvent): void {
    switch (event.type) {
      case 'reference-price':
        if (event.midpoint != null) this.midpoints.set(venue, event.midpoint);
        this.emitCompositeReference(venue, event);
        return;
      case 'snapshot':
      case 'delta':
        // Order book: forward only from the active primary venue.
        if (venue === this.primaryProvider) this.onEvent(event);
        return;
      case 'trade':
        // Trades from every venue pass through, labelled per provider — except
        // from a venue that has drifted out of line with the rest, whose prints
        // cannot be placed against the primary venue's book.
        if (!this.isComparable(venue)) {
          this.warnIncomparable(venue);
          return;
        }
        this.onEvent(event);
        return;
      default:
        this.onEvent(event);
    }
  }

  private isComparable(venue: string): boolean {
    return isVenueComparable(
      this.midpoints.get(venue),
      compositeMidpoint([...this.midpoints.values()]),
    );
  }

  /** At most one warning per venue per WARN_INTERVAL_MS, so the feed stays readable. */
  private warnIncomparable(venue: string): void {
    const now = Date.now();
    const last = this.incomparableWarnedAt.get(venue) ?? 0;
    if (now - last < WARN_INTERVAL_MS) return;
    this.incomparableWarnedAt.set(venue, now);
    this.onFeed?.({
      kind: 'warning',
      text: `[${LABELS[venue] ?? venue}] quotes are out of line with the other venues — its trades are excluded from the aggregate`,
      ts: now,
    });
  }

  private emitCompositeReference(venue: string, event: MarketEvent): void {
    if (event.type !== 'reference-price' || event.midpoint == null) return;
    const composite = compositeMidpoint([...this.midpoints.values()]);
    if (composite == null) return;
    this.onEvent({
      type: 'reference-price',
      provider: 'aggregated',
      symbol: this.symbol,
      instrumentType: 'tokenized-gold-spot',
      timestamp: event.timestamp,
      // Deliberately no bid/ask: there is no such thing as a composite quote
      // across venues, and forwarding the triggering venue's quote would put
      // one venue's ticker on top of another venue's order book. Only the
      // composite midpoint is a defensible aggregate.
      midpoint: composite,
      isDelayed: event.isDelayed,
      isStale: event.isStale,
    });
  }

  private handleVenueStatus(venue: string, status: ConnectionStatus): void {
    this.health.set(venue, status);
    const next = pickPrimaryVenue(VENUE_ORDER, this.health);
    if (next != null && next !== this.primaryProvider) {
      const previous = this.primaryProvider;
      this.primaryProvider = next;
      this.onFeed?.({
        kind: 'provider-change',
        text: `Aggregated mode: primary book switched ${previous != null ? `from ${LABELS[previous] ?? previous} ` : ''}to ${LABELS[next] ?? next}`,
        ts: Date.now(),
      });
    }
    this.emitAggregateStatus();
  }

  private emitAggregateStatus(): void {
    const states = [...this.health.values()].map((h) => h.state);
    const next: ConnectionStatus['state'] = states.some((s) => s === 'connected')
      ? 'connected'
      : states.some((s) => s === 'connecting' || s === 'reconnecting')
        ? 'reconnecting'
        : states.length > 0 && states.every((s) => s === 'failed')
          ? 'failed'
          : this.state === 'idle'
            ? 'connecting'
            : 'stale';
    const wasIdle = this.state === 'idle';
    if (next !== this.state || wasIdle) {
      this.state = next;
      this.onStatus({
        provider: 'aggregated',
        state: next,
        lastMessageAt: Date.now(),
        reconnectAttempts: this.venues.reduce(
          (sum, v) => sum + v.adapter.getHealth().reconnectAttempts,
          0,
        ),
        staleReason: next === 'failed' ? 'all venues failed' : undefined,
      });
    }
  }

  private setStatus(state: ConnectionStatus['state']): void {
    this.state = state;
    this.onStatus({
      provider: 'aggregated',
      state,
      lastMessageAt: Date.now(),
      reconnectAttempts: 0,
    });
  }
}
