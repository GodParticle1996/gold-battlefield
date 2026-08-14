import { create } from 'zustand';
import type { MarketMetrics } from '@gb/analytics';
import type { BookLevel, ConnectionStatus, FeedEntry } from '@gb/market-types';
import type { CameraMode, EffectIntensity, QualityLevel } from '@gb/shared-config';
import { DEFAULT_CVD_WINDOW_MS } from '@gb/shared-config';
import type { VisualState } from '@gb/visual-mapping';
import type { FrameMessage, HelloInfo } from './types';

const SETTINGS_KEY = 'gb.settings.v1';

export interface Settings {
  mode: string;
  replaySpeed: number;
  effectsIntensity: EffectIntensity;
  reducedMotion: boolean;
  colorBlind: boolean;
  /** Freezes the render loop; data keeps flowing (distinct from pauseData, spec §12). */
  pauseRender: boolean;
  /** Freezes the data pipeline; the last frame stays on screen. */
  pauseData: boolean;
  cameraMode: CameraMode;
  /** HUD overlay visibility — the cinematic layout's core control. */
  hudVisible: boolean;
  /** Hides every panel and auto-orbits the camera. */
  tvMode: boolean;
  audioEnabled: boolean;
  showLabels: boolean;
  cvdWindowMs: number;
  volumeWindowMs: number;
  wallThresholdUsd: number;
  /** Depth panel unit toggle: quote notional vs base quantity. */
  depthUnit: 'notional' | 'base';
}

const DEFAULT_SETTINGS: Settings = {
  mode: 'aggregated',
  replaySpeed: 1,
  effectsIntensity: 'standard',
  reducedMotion: false,
  colorBlind: false,
  pauseRender: false,
  pauseData: false,
  cameraMode: 'orbit',
  hudVisible: true,
  tvMode: false,
  audioEnabled: false,
  showLabels: true,
  cvdWindowMs: DEFAULT_CVD_WINDOW_MS,
  volumeWindowMs: 60_000,
  wallThresholdUsd: 250_000,
  depthUnit: 'notional',
};

/** Keys that survive a reload. Transient run state (pauses, mode) is not persisted. */
const PERSISTED: Array<keyof Settings> = [
  'effectsIntensity',
  'reducedMotion',
  'colorBlind',
  'cameraMode',
  'hudVisible',
  'audioEnabled',
  'showLabels',
  'cvdWindowMs',
  'volumeWindowMs',
  'wallThresholdUsd',
  'depthUnit',
];

function loadSettings(): Settings {
  const base: Settings = { ...DEFAULT_SETTINGS };
  // Respect the OS accessibility preference unless the user overrides it.
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
    base.reducedMotion = true;
  }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw == null) return base;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const target = base as unknown as Record<string, unknown>;
    for (const key of PERSISTED) {
      if (parsed[key] !== undefined) target[key] = parsed[key];
    }
  } catch {
    // Corrupt or unavailable storage must never block boot.
  }
  return base;
}

function saveSettings(settings: Settings): void {
  try {
    const subset: Record<string, unknown> = {};
    for (const key of PERSISTED) subset[key] = settings[key];
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(subset));
  } catch {
    // Ignore quota / private-mode failures.
  }
}

export interface ReplayProgress {
  elapsedMs: number;
  durationMs: number;
  speed: number;
}

export interface PerfInfo {
  fps: number;
  frameMs: number;
  drawCalls: number;
  activeUnits: number;
}

const FEED_MAX = 80;

interface Store extends Settings {
  visual: VisualState | null;
  metrics: MarketMetrics | null;
  status: ConnectionStatus | null;
  hello: HelloInfo | null;
  feed: FeedEntry[];
  depth: { bids: BookLevel[]; asks: BookLevel[] } | null;
  replayProgress: ReplayProgress | null;
  cameraReset: number;
  perf: PerfInfo;
  quality: QualityLevel;
  autoQuality: boolean;
  applyFrame: (frame: FrameMessage) => void;
  setReplayProgress: (progress: ReplayProgress) => void;
  setSettings: (patch: Partial<Settings>) => void;
  resetCamera: () => void;
  setPerf: (patch: Partial<PerfInfo>) => void;
  setQuality: (quality: QualityLevel) => void;
  setAutoQuality: (auto: boolean) => void;
  pushFeed: (entry: FeedEntry) => void;
}

export const useStore = create<Store>((set) => ({
  ...loadSettings(),

  visual: null,
  metrics: null,
  status: null,
  hello: null,
  feed: [],
  depth: null,
  replayProgress: null,
  cameraReset: 0,
  perf: { fps: 0, frameMs: 0, drawCalls: 0, activeUnits: 0 },
  quality: 'high',
  autoQuality: true,

  applyFrame: (frame) =>
    set((state) => ({
      visual: frame.visual ?? state.visual,
      metrics: frame.metrics ?? state.metrics,
      status: frame.status ?? state.status,
      hello: frame.hello ?? state.hello,
      // Newest first: the feed reads top-down and never needs scroll-to-bottom.
      feed: frame.feed.length === 0 ? state.feed : [...frame.feed.reverse(), ...state.feed].slice(0, FEED_MAX),
      depth: frame.depth ?? state.depth,
    })),

  setReplayProgress: (progress) => set({ replayProgress: progress }),

  setSettings: (patch) =>
    set((state) => {
      const next = { ...state, ...patch };
      saveSettings(next);
      return next;
    }),

  resetCamera: () => set((state) => ({ cameraReset: state.cameraReset + 1 })),

  setPerf: (patch) => set((state) => ({ perf: { ...state.perf, ...patch } })),

  setQuality: (quality) => set({ quality }),

  setAutoQuality: (autoQuality) => set({ autoQuality }),

  pushFeed: (entry) => set((state) => ({ feed: [entry, ...state.feed].slice(0, FEED_MAX) })),
}));
