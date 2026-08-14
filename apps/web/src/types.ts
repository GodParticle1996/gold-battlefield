import type { MarketMetrics } from '@gb/analytics';
import type { BookLevel, ConnectionStatus, FeedEntry } from '@gb/market-types';
import type { VisualState } from '@gb/visual-mapping';

/** Mode metadata sent by the gateway on selection/fallback. */
export interface HelloInfo {
  mode: string;
  provider: string;
  symbol: string;
  label: string;
  live: boolean;
  reason?: string;
}

/** Message posted from the pipeline worker to the main thread at render cadence. */
export interface FrameMessage {
  type: 'frame';
  visual: VisualState | null;
  metrics: MarketMetrics | null;
  status: ConnectionStatus | null;
  hello: HelloInfo | null;
  feed: FeedEntry[];
  depth: { bids: BookLevel[]; asks: BookLevel[] } | null;
}

/** Replay timeline progress pushed by the gateway while in replay mode. */
export interface ReplayProgressMessage {
  type: 'replay-progress';
  elapsedMs: number;
  durationMs: number;
  speed: number;
}

export type ServerMessage = FrameMessage | ReplayProgressMessage;

/** Messages posted from the UI to the pipeline worker. */
export type WorkerInMessage =
  | { type: 'select'; mode: string }
  | {
      type: 'replay';
      action: 'pause' | 'resume' | 'restart' | 'speed' | 'seek';
      speed?: number;
      positionMs?: number;
    }
  | { type: 'pause-data'; paused: boolean }
  | { type: 'config'; wallThresholdUsd: number };
