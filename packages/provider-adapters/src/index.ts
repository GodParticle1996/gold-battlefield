import type { ConnectionStatus, FeedEntry, MarketEvent } from '@gb/market-types';

export interface AdapterCapabilities {
  orderBook: boolean;
  trades: boolean;
  aggressorSide: boolean;
  /** Provider-reported liquidations. Spot-gold feeds do not provide these. */
  liquidations: boolean;
  live: boolean;
}

export interface AdapterHandlers {
  onEvent: (event: MarketEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
  onFeed?: (entry: FeedEntry) => void;
}

/**
 * Provider-independent adapter interface (spec §5). Every provider — live
 * exchange, reference price, replay, or simulation — implements this shape.
 * No exchange-specific parsing ever leaks into React components.
 */
export interface MarketDataAdapter {
  readonly provider: string;
  readonly symbol: string;
  readonly capabilities: AdapterCapabilities;
  connect(): Promise<void>;
  disconnect(): void;
  getHealth(): ConnectionStatus;
}

export * from './fallback';
export * from './replay';
export * from './simulation';
export * from './binance';
export * from './kraken';
export * from './coinbase';
export * from './gemini';
export * from './bitstamp';
export * from './swissquote';
export * from './aggregated';
export * from './factory';
