// ---------------------------------------------------------------------------
// Budgets, performance targets, and default thresholds (spec §9, §16).
// ---------------------------------------------------------------------------

/** Visual render cadence: 12 updates per second (within the spec's 10–20 Hz band). */
export const RENDER_CADENCE_MS = 1000 / 12;

/** Networking cadence for live adapters (not the render cadence). */
export const NETWORK_HEARTBEAT_MS = 15_000;

/** Bounded memory: max events kept in analytics ring. */
export const EVENT_RING_MAX = 5_000;

/** Depth top-N retained for visualization and imbalance. */
export const DEPTH_TOP_N = 40;

/** Renderer caps (instanced units, particles). */
export const UNIT_CAP = 4_000;
export const PARTICLE_CAP = 2_000;

/** Order-book delta buffer cap before a snapshot arrives. */
export const DELTA_BUFFER_MAX = 10_000;

/** Rolling volume / CVD windows (spec §9). */
export const VOLUME_WINDOWS_MS: readonly number[] = [10_000, 30_000, 60_000, 300_000];

/** Default window used by the HUD's CVD readout. Must be one of VOLUME_WINDOWS_MS. */
export const DEFAULT_CVD_WINDOW_MS = 60_000;

/** Percentile-threshold sample size before adaptive thresholds kick in. */
export const THRESHOLD_SAMPLE_SIZE = 200;
export const THRESHOLD_MIN_SAMPLES = 30;

/** Absolute large-trade thresholds used before enough samples exist (USD notional). */
export const LARGE_TRADE_DEFAULT_USD = 2_000_000;
export const EXCEPTIONAL_TRADE_DEFAULT_USD = 10_000_000;

/** Visual mapping constants (spec §9). */
export const REF_NOTIONAL = 1_000_000; // reference notional for log1p scaling (USD)
export const CAP_NOTIONAL = 50_000_000; // notional at which strength saturates
export const VISIBLE_PRICE_RANGE = 2.0; // half-map in USD/oz — the floor for the adaptive range
export const RECENTER_EDGE_FRACTION = 0.6; // recenter when price crosses this fraction of range

/**
 * The half-map widens when the book or recent price action does not fit inside
 * VISIBLE_PRICE_RANGE, so top-of-book never sits clamped against the edge.
 * It widens quickly (to reveal what arrived) and narrows slowly (so the field
 * does not breathe on every tick).
 */
export const MAX_PRICE_RANGE = 25;
export const RANGE_PADDING = 1.18;
export const RANGE_GROW_RATE = 0.25;
export const RANGE_SHRINK_RATE = 0.01;

/** A price level whose notional exceeds this becomes a wall fortification. */
export const WALL_THRESHOLD_USD = 250_000;

// ---------------------------------------------------------------------------
// Battlefield pacing (how "alive" the scene is allowed to look).
// ---------------------------------------------------------------------------

/**
 * Trade rate (trades/second, measured over ACTIVITY_WINDOW_MS) at which the
 * activity level saturates at 1. Tokenized-gold venues are thin, so this is
 * deliberately low — but the scene never invents activity that did not happen.
 */
export const ACTIVITY_SATURATION_TPS = 1.5;
export const ACTIVITY_WINDOW_MS = 30_000;

/**
 * With no executed trade for this long the battlefield enters its honest
 * "quiet front" state: units stand down instead of faking a battle.
 */
export const QUIET_AFTER_MS = 25_000;

/** Price-trail sample cap (the scar the front line leaves behind it). */
export const TRAIL_MAX = 120;

/** How long a wall keeps rendering after it leaves the book, while it dismantles. */
export const WALL_DISMANTLE_MS = 900;

/** Effect lifetimes (ms) by kind. */
export const EFFECT_LIFE_MS = {
  charge: 1_400,
  impact: 900,
  'wall-break': 1_600,
} as const;

/** Connection resilience (spec §14). */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
export const STALE_AFTER_MS = 20_000;
export const HEARTBEAT_TIMEOUT_MS = 60_000;

/** Quality levels (spec §16). */
export const QUALITY_LEVELS = ['high', 'medium', 'low', 'battery-saver'] as const;
export type QualityLevel = (typeof QUALITY_LEVELS)[number];

export const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, value));
