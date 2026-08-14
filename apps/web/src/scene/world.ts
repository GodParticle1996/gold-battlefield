import type { QualityLevel } from '@gb/shared-config';

/**
 * Battlefield world layout.
 *
 *   +X  = higher price  →  Bear (ask) territory
 *   -X  = lower price   →  Bull (bid) territory
 *   +Z  = toward the camera along the width of the front
 *    Y  = up
 *
 * The front line sits at the current price, so the armies always form up
 * *behind* it and the whole field reads left-to-right as a price ladder.
 */
export const HALF_WIDTH = 16;
export const FIELD_DEPTH = 18;
export const HALF_DEPTH = FIELD_DEPTH / 2;

/**
 * Default camera. Tilted well over the field rather than low behind it: at a
 * shallow angle the two formations foreshorten into thin receding lines
 * instead of reading as armies facing each other across the price.
 */
export const CAMERA_HOME: [number, number, number] = [0, 31, 21];
export const CAMERA_ISO: [number, number, number] = [0, 37, 15];

/** Distance between infantry ranks, and the gap between a rank and the front line. */
export const RANK_GAP = 0.85;
export const FRONT_STANDOFF = 1.3;
export const UNITS_PER_RANK = 24;

/** Instanced unit budget per army, per quality level (spec §16). */
export const QUALITY_UNITS: Record<QualityLevel, number> = {
  high: 480,
  medium: 336,
  low: 216,
  'battery-saver': 120,
};

/** Debris/dust particle pool size per quality level. */
export const QUALITY_PARTICLES: Record<QualityLevel, number> = {
  high: 260,
  medium: 180,
  low: 90,
  'battery-saver': 0,
};

export const QUALITY_DPR: Record<QualityLevel, [number, number]> = {
  high: [1, 2],
  medium: [1, 1.5],
  low: [1, 1.25],
  'battery-saver': [0.75, 1],
};

/** Battlefield x for a normalized [-1,1] visual coordinate. */
export const worldX = (vx: number): number => vx * HALF_WIDTH;

export function formatUsd(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}
