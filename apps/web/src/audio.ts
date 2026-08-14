/**
 * Event SFX, synthesized with Web Audio.
 *
 * The repository ships no audio assets, so every sound is generated. Audio is
 * opt-in and off by default; the AudioContext is created lazily on the user's
 * first toggle, which also satisfies the browser autoplay gesture requirement.
 * Sounds are non-graphic impacts only (spec §11) and never signal anything.
 */

let context: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;

/** Rate limiter: a burst of large trades must not turn into a wall of noise. */
const MAX_PER_SECOND = 6;
let recentPlays: number[] = [];

function ensureContext(): AudioContext | null {
  if (context != null) return context;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor == null) return null;

  context = new Ctor();
  master = context.createGain();
  master.gain.value = 0.35;
  master.connect(context.destination);

  const frames = Math.floor(context.sampleRate * 0.4);
  noiseBuffer = context.createBuffer(1, frames, context.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    // Decaying white noise — the "grit" layer under each impact.
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }
  return context;
}

/** Called from the audio toggle so the context is created inside a user gesture. */
export async function enableAudio(): Promise<void> {
  const ctx = ensureContext();
  if (ctx == null) return;
  if (ctx.state === 'suspended') await ctx.resume();
}

export function disableAudio(): void {
  void context?.suspend();
}

function allowed(now: number): boolean {
  recentPlays = recentPlays.filter((ts) => now - ts < 1000);
  if (recentPlays.length >= MAX_PER_SECOND) return false;
  recentPlays.push(now);
  return true;
}

interface ImpactOptions {
  /** 0..1 — scales gain, pitch drop, and length. */
  magnitude: number;
  /** Buy pressure sits a little higher in pitch than sell pressure. */
  side: 'buy' | 'sell' | 'unknown';
}

/** Short low thud for a large executed trade. */
export function playImpact({ magnitude, side }: ImpactOptions): void {
  const ctx = context;
  if (ctx == null || master == null || ctx.state !== 'running') return;
  if (!allowed(performance.now())) return;

  const now = ctx.currentTime;
  const strength = Math.min(1, Math.max(0.15, magnitude));
  const duration = 0.16 + strength * 0.18;
  const baseHz = side === 'buy' ? 128 : side === 'sell' ? 96 : 112;

  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(baseHz, now);
  osc.frequency.exponentialRampToValueAtTime(baseHz * 0.42, now + duration);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.35 * strength, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(gain).connect(master);
  osc.start(now);
  osc.stop(now + duration + 0.02);

  playNoise(strength * 0.5, 900 + strength * 700, duration * 0.6);
}

/** Heavier, grittier crunch for a fortification leaving the book. */
export function playWallBreak(magnitude: number): void {
  const ctx = context;
  if (ctx == null || master == null || ctx.state !== 'running') return;
  if (!allowed(performance.now())) return;

  const strength = Math.min(1, Math.max(0.2, magnitude));
  playNoise(strength * 0.75, 420, 0.42);

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(70, now);
  osc.frequency.exponentialRampToValueAtTime(32, now + 0.4);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.3 * strength, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);

  osc.connect(gain).connect(master);
  osc.start(now);
  osc.stop(now + 0.44);
}

function playNoise(gainValue: number, cutoffHz: number, duration: number): void {
  const ctx = context;
  if (ctx == null || master == null || noiseBuffer == null) return;
  const now = ctx.currentTime;

  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoffHz;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(gainValue, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  source.connect(filter).connect(gain).connect(master);
  source.start(now);
  source.stop(now + duration + 0.02);
}
