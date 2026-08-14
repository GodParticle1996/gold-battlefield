import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8081),
  BINANCE_WS_URL: z.string().url().default('wss://stream.binance.com:9443'),
  BINANCE_REST_URL: z.string().url().default('https://api.binance.com'),
  KRAKEN_WS_URL: z.string().url().default('wss://ws.kraken.com/v2'),
  COINBASE_WS_URL: z.string().url().default('wss://ws-feed.exchange.coinbase.com'),
  GEMINI_WS_URL: z.string().url().default('wss://api.gemini.com/v1/marketdata/PAXGUSD'),
  BITSTAMP_WS_URL: z.string().url().default('wss://ws.bitstamp.net'),
  BITSTAMP_REST_URL: z.string().url().default('https://www.bitstamp.net'),
  SWISSQUOTE_URL: z
    .string()
    .url()
    .default('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD'),
  SWISSQUOTE_POLL_MS: z.coerce.number().int().positive().default(5_000),
  ALLOWED_ORIGINS: z.string().default('*'),
  REPLAY_FIXTURE: z.string().optional(),
  /** Testing hook: force a Binance socket close every N ms (soak tests). */
  BINANCE_FORCE_RECONNECT_MS: z.coerce.number().int().positive().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

/** Validated at startup (spec §15); fails loudly on invalid configuration. */
export const env = envSchema.parse(process.env);

export const allowedOrigins: string[] =
  env.ALLOWED_ORIGINS === '*' ? ['*'] : env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());

/**
 * Default replay fixture. Resolution is cwd-independent so the gateway works
 * whether launched from the repo root, the package dir, or a test harness.
 */
export function defaultFixturePath(): string {
  const candidates = [
    env.REPLAY_FIXTURE,
    path.resolve(process.cwd(), 'tests/fixtures/replay-xaut-1.json'),
    path.resolve(process.cwd(), '../../tests/fixtures/replay-xaut-1.json'),
    path.resolve(process.cwd(), '../fixtures/replay-xaut-1.json'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0] ?? '';
}
