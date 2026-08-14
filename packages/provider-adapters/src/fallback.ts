import type { DataMode } from '@gb/shared-config';
import { FALLBACK_CHAIN } from '@gb/shared-config';

/** Next fallback mode in the spec §4/§5 hierarchy, or null when at the end. */
export function nextInChain(mode: DataMode): DataMode | null {
  const index = FALLBACK_CHAIN.indexOf(mode);
  if (index < 0 || index >= FALLBACK_CHAIN.length - 1) return null;
  return FALLBACK_CHAIN[index + 1]!;
}

/** Ordered fallback sequence starting at `start` (exclusive), including replay/simulation. */
export function fallbackSequence(start: DataMode): DataMode[] {
  const result: DataMode[] = [];
  let current = nextInChain(start);
  while (current != null) {
    result.push(current);
    current = nextInChain(current);
  }
  return result;
}
