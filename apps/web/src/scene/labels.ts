import * as THREE from 'three';

/**
 * In-scene text without a font dependency.
 *
 * drei's <Text> uses troika, which fetches its default font from a Google CDN —
 * that is blocked by the app's `default-src 'self'` CSP and would fail offline.
 * Labels are therefore rasterized to a canvas with the system UI font and used
 * as sprite textures, which stay crisp, always face the camera, and ship
 * nothing extra.
 */

export interface LabelStyle {
  color: string;
  background: string;
  /** Rendered pixel height of the glyphs; world size is set separately. */
  fontPx: number;
  bold: boolean;
  padPx: number;
}

export const LABEL_STYLES = {
  price: { color: '#0c0f14', background: '#f5c542', fontPx: 44, bold: true, padPx: 14 },
  tick: { color: '#7f8c9e', background: 'transparent', fontPx: 30, bold: false, padPx: 6 },
  wallBid: { color: '#eafbec', background: 'rgba(14,40,20,0.82)', fontPx: 30, bold: true, padPx: 10 },
  wallAsk: { color: '#fdeceb', background: 'rgba(48,16,15,0.82)', fontPx: 30, bold: true, padPx: 10 },
  army: { color: '#dbe6f2', background: 'rgba(10,14,20,0.72)', fontPx: 34, bold: true, padPx: 12 },
} satisfies Record<string, LabelStyle>;

export type LabelStyleName = keyof typeof LABEL_STYLES;

interface CachedLabel {
  texture: THREE.CanvasTexture;
  aspect: number;
}

const CACHE_MAX = 96;
const cache = new Map<string, CachedLabel>();

function render(text: string, style: LabelStyle): CachedLabel {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (context == null) throw new Error('2D canvas context unavailable');

  const font = `${style.bold ? '700 ' : ''}${style.fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  context.font = font;
  const metrics = context.measureText(text);
  const textWidth = Math.ceil(metrics.width);
  const width = textWidth + style.padPx * 2;
  const height = Math.ceil(style.fontPx * 1.42) + style.padPx * 2;

  canvas.width = width;
  canvas.height = height;

  // Re-apply after the resize — sizing a canvas resets its 2D state.
  context.font = font;
  context.textBaseline = 'middle';
  context.textAlign = 'center';

  if (style.background !== 'transparent') {
    const radius = Math.min(12, height / 2);
    context.fillStyle = style.background;
    context.beginPath();
    context.roundRect(0, 0, width, height, radius);
    context.fill();
  }

  context.fillStyle = style.color;
  context.fillText(text, width / 2, height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return { texture, aspect: width / height };
}

/**
 * Returns a cached label texture. The cache is a bounded LRU because label text
 * changes constantly (prices tick) and every uncached string would otherwise
 * leak a GPU texture.
 */
export function getLabel(text: string, styleName: LabelStyleName): CachedLabel {
  const key = `${styleName}|${text}`;
  const hit = cache.get(key);
  if (hit != null) {
    // Refresh recency.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const created = render(text, LABEL_STYLES[styleName]);
  cache.set(key, created);

  while (cache.size > CACHE_MAX) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey == null) break;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    oldest?.texture.dispose();
  }

  return created;
}

export function clearLabelCache(): void {
  for (const entry of cache.values()) entry.texture.dispose();
  cache.clear();
}
