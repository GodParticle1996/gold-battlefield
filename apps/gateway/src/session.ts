import WebSocket from 'ws';
import type { ConnectionStatus, MarketEvent } from '@gb/market-types';
import { parseMarketEvent } from '@gb/market-types';
import type { MarketDataAdapter } from '@gb/provider-adapters';
import { createAdapter, fallbackSequence, nextInChain } from '@gb/provider-adapters';
import type { DataMode } from '@gb/shared-config';
import { isDataMode, MODE_INFO } from '@gb/shared-config';
import { defaultFixturePath, env } from './env';
import { log } from './log';

interface ClientMessage {
  type: string;
  mode?: unknown;
  action?: unknown;
  speed?: unknown;
  positionMs?: unknown;
}

interface ReplayControls {
  pause(): void;
  resume(): void;
  setSpeed(speed: number): void;
  seek(positionMs: number): void;
  restart(): void;
  getElapsedMs(): number;
  getDurationMs(): number;
}

/**
 * One adapter session per WebSocket connection. Handles mode selection,
 * normalized-event fan-out, replay controls, and the visible fallback chain.
 */
export class Session {
  private adapter: MarketDataAdapter | null = null;
  private mode: DataMode = 'simulation';
  private rejectedEvents = 0;
  private progressTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly socket: WebSocket) {}

  handle(raw: string): void {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send({ type: 'error', text: 'malformed JSON' });
      return;
    }
    if (message.type === 'select') {
      if (typeof message.mode === 'string' && isDataMode(message.mode)) {
        void this.select(message.mode);
      } else {
        this.send({ type: 'error', text: 'unknown mode' });
      }
    } else if (message.type === 'replay') {
      this.replayControl(message);
    } else if (message.type === 'resync' && this.mode != null) {
      // Order-book resync request: re-create the adapter for a fresh snapshot.
      void this.switchAdapter(this.mode, 'resync requested');
    }
  }

  async select(mode: DataMode): Promise<void> {
    await this.switchAdapter(mode, `user selected ${mode}`);
  }

  dispose(): void {
    this.stopProgress();
    this.adapter?.disconnect();
    this.adapter = null;
  }

  private async switchAdapter(mode: DataMode, reason: string): Promise<void> {
    this.stopProgress();
    this.adapter?.disconnect();
    this.adapter = null;

    let adapter: MarketDataAdapter;
    try {
      adapter = createAdapter({
        mode,
        onEvent: (event) => this.handleEvent(event),
        onStatus: (status) => this.send({ type: 'status', status }),
        onFeed: (entry) => this.send({ type: 'feed', entry }),
        fixturePath: env.REPLAY_FIXTURE ?? defaultFixturePath(),
        wsUrl: env.BINANCE_WS_URL,
        restUrl: env.BINANCE_REST_URL,
        krakenWsUrl: env.KRAKEN_WS_URL,
        coinbaseWsUrl: env.COINBASE_WS_URL,
        geminiWsUrl: env.GEMINI_WS_URL,
        bitstampWsUrl: env.BITSTAMP_WS_URL,
        bitstampRestUrl: env.BITSTAMP_REST_URL,
        swissquoteUrl: env.SWISSQUOTE_URL,
        swissquotePollMs: env.SWISSQUOTE_POLL_MS,
        forceReconnectMs: env.BINANCE_FORCE_RECONNECT_MS,
      });
    } catch (error) {
      log.warn(`adapter ${mode} unavailable: ${error instanceof Error ? error.message : error}`);
      this.fallbackFrom(mode, 'adapter unavailable');
      return;
    }

    this.mode = mode;
    this.adapter = adapter;
    this.send({
      type: 'hello',
      mode,
      provider: adapter.provider,
      symbol: adapter.symbol,
      label: MODE_INFO[mode].label,
      live: MODE_INFO[mode].live,
      reason,
    });
    this.send({
      type: 'feed',
      entry: { kind: 'provider-change', text: `Switched to ${MODE_INFO[mode].label}`, ts: Date.now() },
    });

    try {
      await adapter.connect();
      if (adapter.provider === 'replay') this.startProgress(adapter as MarketDataAdapter & ReplayControls);
    } catch (error) {
      log.warn(`adapter ${mode} connect failed: ${error instanceof Error ? error.message : error}`);
      this.fallbackFrom(mode, 'connect failed');
    }
  }

  private startProgress(replay: MarketDataAdapter & ReplayControls): void {
    this.stopProgress();
    this.progressTimer = setInterval(() => {
      this.send({
        type: 'replay-progress',
        elapsedMs: Math.round(replay.getElapsedMs()),
        durationMs: Math.round(replay.getDurationMs()),
        speed: 1,
      });
    }, 500);
  }

  private stopProgress(): void {
    if (this.progressTimer != null) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private fallbackFrom(mode: DataMode, reason: string): void {
    const next = nextInChain(mode);
    if (next == null) {
      this.send({
        type: 'status',
        status: {
          provider: 'system',
          state: 'failed',
          lastMessageAt: Date.now(),
          reconnectAttempts: 0,
          staleReason: `no fallback available (${reason})`,
        } satisfies ConnectionStatus,
      });
      return;
    }
    this.send({
      type: 'feed',
      entry: {
        kind: 'provider-change',
        text: `Falling back: ${MODE_INFO[mode].label} → ${MODE_INFO[next].label} (${reason})`,
        ts: Date.now(),
      },
    });
    void this.switchAdapter(next, `fallback from ${mode}: ${reason}`);
  }

  /** Expose the ordered fallback chain for tests/diagnostics. */
  static chainFrom(mode: DataMode): DataMode[] {
    return [mode, ...fallbackSequence(mode)];
  }

  private replayControl(message: ClientMessage): void {
    if (this.adapter?.provider !== 'replay') return;
    const replay = this.adapter as MarketDataAdapter & ReplayControls;
    const action = message.action;
    if (action === 'pause') replay.pause();
    else if (action === 'resume') replay.resume();
    else if (action === 'restart') replay.restart();
    else if (action === 'seek' && typeof message.positionMs === 'number') replay.seek(message.positionMs);
    if (typeof message.speed === 'number') replay.setSpeed(message.speed);
  }

  private handleEvent(event: MarketEvent): void {
    const parsed = parseMarketEvent(event);
    if (parsed == null) {
      this.rejectedEvents += 1;
      log.warn(`rejected malformed event (#${this.rejectedEvents})`);
      return;
    }
    this.send({ type: 'event', event: parsed });
  }

  private send(payload: unknown): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
