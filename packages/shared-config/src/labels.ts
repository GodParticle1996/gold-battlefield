import type { DataMode } from './modes';

/** Persistent educational statement (spec §12) — always visible. */
export const DISCLAIMER =
  'Educational market visualization only. Not financial advice, not a price forecast, and not a trading signal.';

/** Mode badges — every active mode must be accurately labelled (spec §4, §20). */
export const MODE_INFO: Record<DataMode, { label: string; live: boolean; orderFlow: boolean }> = {
  binance: {
    label: 'Live order flow — PAXG/USDC on Binance',
    live: true,
    orderFlow: true,
  },
  kraken: {
    label: 'Live order flow — XAUT/USD on Kraken (tokenized-gold proxy market)',
    live: true,
    orderFlow: true,
  },
  coinbase: {
    label: 'Live order flow — PAXG/USD on Coinbase',
    live: true,
    orderFlow: true,
  },
  gemini: {
    label: 'Live order flow — PAXG/USD on Gemini (tokenized-gold proxy market)',
    live: true,
    orderFlow: true,
  },
  bitstamp: {
    label: 'Live order flow — PAXG/USD on Bitstamp (tokenized-gold proxy market)',
    live: true,
    orderFlow: true,
  },
  aggregated: {
    label: 'Aggregated proxy view, not a consolidated regulated order book',
    live: true,
    orderFlow: true,
  },
  reference: {
    label: 'Reference-price visualization. Order flow unavailable.',
    live: true,
    orderFlow: false,
  },
  delayed: {
    label: 'Delayed polling mode — not tick-by-tick real-time',
    live: true,
    orderFlow: false,
  },
  replay: {
    label: 'Historical replay',
    live: false,
    orderFlow: true,
  },
  simulation: {
    label: 'Synthetic simulation. Not live market data.',
    live: false,
    orderFlow: true,
  },
};

export const EFFECT_INTENSITIES = ['minimal', 'standard', 'cinematic'] as const;
export type EffectIntensity = (typeof EFFECT_INTENSITIES)[number];

export const CAMERA_MODES = ['orbit', 'follow-price', 'fixed-iso'] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];
