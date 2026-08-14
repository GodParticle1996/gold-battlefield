import { useEffect, useRef } from 'react';
import { disableAudio, enableAudio, playImpact, playWallBreak } from '../audio';
import { useStore } from '../store';

/**
 * Turns newly-arrived visual effects into one-shot SFX. Runs off the store
 * subscription rather than the render loop so it fires exactly once per event,
 * and only for effects that are actually new (ids increase monotonically).
 */
export function AudioBridge() {
  const audioEnabled = useStore((state) => state.audioEnabled);
  const lastEffectId = useRef(0);

  useEffect(() => {
    if (audioEnabled) void enableAudio();
    else disableAudio();
  }, [audioEnabled]);

  useEffect(() => {
    if (!audioEnabled) return;

    return useStore.subscribe((state) => {
      const effects = state.visual?.effects;
      if (effects == null || effects.length === 0) return;

      let highest = lastEffectId.current;
      const now = Date.now();
      for (const effect of effects) {
        if (effect.id <= lastEffectId.current) continue;
        if (effect.id > highest) highest = effect.id;
        // Charges are the wind-up; the impact carries the sound.
        if (effect.kind === 'charge') continue;
        if (now - effect.t0 > 500) continue; // stale on arrival — don't fire late
        if (effect.kind === 'wall-break') playWallBreak(effect.magnitude);
        else playImpact({ magnitude: effect.magnitude, side: effect.side });
      }
      lastEffectId.current = highest;
    });
  }, [audioEnabled]);

  return null;
}
