// ---------------------------------------------------------------------------
// Data modes and fallback hierarchy (spec §4, §5).
// ---------------------------------------------------------------------------

export const DATA_MODES = [
  'binance',
  'kraken',
  'coinbase',
  'gemini',
  'bitstamp',
  'aggregated',
  'reference',
  'delayed',
  'replay',
  'simulation',
] as const;

export type DataMode = (typeof DATA_MODES)[number];

/** Fallback hierarchy — transitions always visible in the UI badge. */
export const FALLBACK_CHAIN: readonly DataMode[] = [
  'binance',
  'kraken',
  'coinbase',
  'gemini',
  'bitstamp',
  'aggregated',
  'reference',
  'delayed',
  'replay',
  'simulation',
];

export function isDataMode(value: string): value is DataMode {
  return (DATA_MODES as readonly string[]).includes(value);
}
