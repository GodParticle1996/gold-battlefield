/**
 * Scene palette. The colour-blind variant swaps the green/red pair for the
 * blue/orange pair, which stays distinguishable under deuteranopia and
 * protanopia — the two most common forms (spec §11/§12).
 */
export interface Palette {
  bull: string;
  bullDark: string;
  bear: string;
  bearDark: string;
  front: string;
  ground: string;
  groundBand: string;
  groundBandMajor: string;
  trail: string;
  label: string;
  sky: string;
  fog: string;
}

const BASE: Omit<Palette, 'bull' | 'bullDark' | 'bear' | 'bearDark' | 'front'> = {
  ground: '#12161d',
  groundBand: '#1d2632',
  groundBandMajor: '#2b384a',
  trail: '#6b5a2a',
  label: '#e8eef6',
  sky: '#080b10',
  fog: '#0a0e14',
};

export const PALETTE_DEFAULT: Palette = {
  ...BASE,
  bull: '#43c95a',
  bullDark: '#1e6b2c',
  bear: '#e8514f',
  bearDark: '#7a2422',
  front: '#f5c542',
};

export const PALETTE_COLORBLIND: Palette = {
  ...BASE,
  bull: '#4a9eff',
  bullDark: '#1e4f85',
  bear: '#ff9b21',
  bearDark: '#8a5209',
  front: '#e8eef6',
};

export const paletteFor = (colorBlind: boolean): Palette =>
  colorBlind ? PALETTE_COLORBLIND : PALETTE_DEFAULT;
