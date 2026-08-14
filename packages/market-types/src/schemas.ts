import { z } from 'zod';

// ---------------------------------------------------------------------------
// Normalized event model (spec §6). Every external message is validated with
// these Zod schemas at the trust boundary; malformed events are rejected
// without crashing the pipeline.
// ---------------------------------------------------------------------------

export const instrumentTypeSchema = z.enum([
  'tokenized-gold-spot',
  'spot-reference',
  'replay',
  'simulation',
]);

export const aggressorSideSchema = z.enum(['buy', 'sell', 'unknown']);

export const providerStateSchema = z.enum([
  'idle',
  'connecting',
  'connected',
  'stale',
  'reconnecting',
  'failed',
]);

export interface BookLevel {
  price: number;
  quantity: number;
}

export const bookLevelSchema = z.object({
  price: z.number().finite(),
  quantity: z.number().finite().nonnegative(),
});

const base = {
  provider: z.string().min(1),
  symbol: z.string().min(1),
  instrumentType: instrumentTypeSchema,
  timestamp: z.number().int().nonnegative(),
};

export const orderBookSnapshotSchema = z.object({
  ...base,
  sequence: z.number().int().nonnegative().optional(),
  bids: z.array(bookLevelSchema),
  asks: z.array(bookLevelSchema),
});

export const orderBookDeltaSchema = z.object({
  ...base,
  firstSequence: z.number().int().nonnegative().optional(),
  finalSequence: z.number().int().nonnegative().optional(),
  bidUpdates: z.array(bookLevelSchema),
  askUpdates: z.array(bookLevelSchema),
  checksum: z.number().int().nonnegative().optional(),
});

export const tradeSchema = z.object({
  ...base,
  tradeId: z.string().min(1),
  price: z.number().positive().finite(),
  baseQuantity: z.number().nonnegative().finite(),
  quoteNotional: z.number().nonnegative().finite(),
  aggressorSide: aggressorSideSchema,
  isEstimated: z.boolean(),
});

export const liquidationSchema = z.object({
  ...base,
  side: z.enum(['buy', 'sell']),
  price: z.number().positive().finite(),
  quantity: z.number().nonnegative().finite(),
  quoteNotional: z.number().nonnegative().finite(),
  eventId: z.string().min(1),
  isProviderReported: z.boolean(),
});

export const referencePriceSchema = z.object({
  ...base,
  bid: z.number().positive().finite().optional(),
  ask: z.number().positive().finite().optional(),
  midpoint: z.number().positive().finite().optional(),
  last: z.number().positive().finite().optional(),
  isDelayed: z.boolean(),
  isStale: z.boolean(),
});

export const connectionStatusSchema = z.object({
  provider: z.string().min(1),
  state: providerStateSchema,
  lastMessageAt: z.number().int().nonnegative(),
  reconnectAttempts: z.number().int().nonnegative(),
  latencyEstimate: z.number().nonnegative().optional(),
  staleReason: z.string().optional(),
});

// Typed envelopes carried over the wire.
export const orderBookSnapshotEventSchema = orderBookSnapshotSchema.extend({
  type: z.literal('snapshot'),
});
export const orderBookDeltaEventSchema = orderBookDeltaSchema.extend({
  type: z.literal('delta'),
});
export const tradeEventSchema = tradeSchema.extend({
  type: z.literal('trade'),
});
export const liquidationEventSchema = liquidationSchema.extend({
  type: z.literal('liquidation'),
});
export const referencePriceEventSchema = referencePriceSchema.extend({
  type: z.literal('reference-price'),
});

export const marketEventSchema = z.discriminatedUnion('type', [
  orderBookSnapshotEventSchema,
  orderBookDeltaEventSchema,
  tradeEventSchema,
  liquidationEventSchema,
  referencePriceEventSchema,
]);

// UI feed entries (provider changes, stale warnings, large-trade events…).
export const feedKindSchema = z.enum([
  'provider-change',
  'stale',
  'reconnect',
  'warning',
  'large-trade',
  'wall-add',
  'wall-remove',
]);

export const feedEntrySchema = z.object({
  kind: feedKindSchema,
  text: z.string().min(1),
  ts: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type InstrumentType = z.infer<typeof instrumentTypeSchema>;
export type AggressorSide = z.infer<typeof aggressorSideSchema>;
export type ProviderState = z.infer<typeof providerStateSchema>;

export type OrderBookSnapshotEvent = z.infer<typeof orderBookSnapshotEventSchema>;
export type OrderBookDeltaEvent = z.infer<typeof orderBookDeltaEventSchema>;
export type TradeEvent = z.infer<typeof tradeEventSchema>;
export type LiquidationEvent = z.infer<typeof liquidationEventSchema>;
export type ReferencePriceEvent = z.infer<typeof referencePriceEventSchema>;
export type MarketEvent = z.infer<typeof marketEventSchema>;

export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export type FeedKind = z.infer<typeof feedKindSchema>;
export type FeedEntry = z.infer<typeof feedEntrySchema>;

/** Runtime validation entry point: returns a discriminated MarketEvent or null. */
export function parseMarketEvent(raw: unknown): MarketEvent | null {
  const result = marketEventSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function parseFeedEntry(raw: unknown): FeedEntry | null {
  const result = feedEntrySchema.safeParse(raw);
  return result.success ? result.data : null;
}
