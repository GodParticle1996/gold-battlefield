import type { DataMode } from '@gb/shared-config';
import type { AdapterHandlers, MarketDataAdapter } from './index';
import { AggregatedAdapter } from './aggregated';
import { BinanceAdapter } from './binance';
import { BitstampAdapter } from './bitstamp';
import { CoinbaseAdapter } from './coinbase';
import { GeminiAdapter } from './gemini';
import { KrakenAdapter } from './kraken';
import { ReplayAdapter } from './replay';
import { SimulationAdapter } from './simulation';
import { SwissquoteAdapter } from './swissquote';

export interface CreateAdapterOptions extends AdapterHandlers {
  mode: DataMode;
  fixturePath?: string;
  wsUrl?: string;
  restUrl?: string;
  krakenWsUrl?: string;
  coinbaseWsUrl?: string;
  geminiWsUrl?: string;
  bitstampWsUrl?: string;
  bitstampRestUrl?: string;
  swissquoteUrl?: string;
  swissquotePollMs?: number;
  seed?: number;
  /** Testing hook passed through to live adapters (forced reconnects). */
  forceReconnectMs?: number;
}

/**
 * Factory: maps a data mode to its adapter implementation. Modes not yet
 * implemented (kraken, aggregated, reference, delayed) throw a clear error so
 * the gateway can fall through the chain rather than hang.
 */
export function createAdapter(options: CreateAdapterOptions): MarketDataAdapter {
  switch (options.mode) {
    case 'binance':
      return new BinanceAdapter({
        onEvent: options.onEvent,
        onStatus: options.onStatus,
        onFeed: options.onFeed,
        wsUrl: options.wsUrl,
        restUrl: options.restUrl,
        forceReconnectMs: options.forceReconnectMs,
      });
    case 'replay':
      return new ReplayAdapter({
        onEvent: options.onEvent,
        onStatus: options.onStatus,
        onFeed: options.onFeed,
        fixturePath: options.fixturePath,
      });
    case 'simulation':
      return new SimulationAdapter({
        onEvent: options.onEvent,
        onStatus: options.onStatus,
        onFeed: options.onFeed,
        seed: options.seed,
      });
    case 'kraken':
      return new KrakenAdapter({
        onEvent: options.onEvent,
        onStatus: options.onStatus,
        onFeed: options.onFeed,
        wsUrl: options.krakenWsUrl,
      });
    case 'coinbase':
      return new CoinbaseAdapter({
        onEvent: options.onEvent,
        onStatus: options.onStatus,
        onFeed: options.onFeed,
        wsUrl: options.coinbaseWsUrl,
        forceReconnectMs: options.forceReconnectMs,
      });
    case 'gemini':
      return new GeminiAdapter({
        onEvent: options.onEvent,
        onStatus: options.onStatus,
        onFeed: options.onFeed,
        wsUrl: options.geminiWsUrl,
        forceReconnectMs: options.forceReconnectMs,
      });
    case 'bitstamp':
      return new BitstampAdapter({
        onEvent: options.onEvent,
        onStatus: options.onStatus,
        onFeed: options.onFeed,
        wsUrl: options.bitstampWsUrl,
        restUrl: options.bitstampRestUrl,
        forceReconnectMs: options.forceReconnectMs,
      });
    case 'aggregated':
      return new AggregatedAdapter({
        onEvent: options.onEvent,
        onStatus: options.onStatus,
        onFeed: options.onFeed,
        binance: { wsUrl: options.wsUrl, restUrl: options.restUrl },
        kraken: { wsUrl: options.krakenWsUrl },
        coinbase: { wsUrl: options.coinbaseWsUrl },
        gemini: { wsUrl: options.geminiWsUrl },
        bitstamp: { wsUrl: options.bitstampWsUrl, restUrl: options.bitstampRestUrl },
        forceReconnectMs: options.forceReconnectMs,
      });
    case 'reference':
      return new SwissquoteAdapter({
        onEvent: options.onEvent,
        onStatus: options.onStatus,
        onFeed: options.onFeed,
        url: options.swissquoteUrl,
        pollMs: options.swissquotePollMs,
      });
    case 'delayed':
      throw new Error(
        'delayed polling mode is served by the reference adapter (MODE D) — select \'reference\'',
      );
  }
}
