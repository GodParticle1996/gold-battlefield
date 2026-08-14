import { readFile } from 'node:fs/promises';
import type { ConnectionStatus, FeedEntry, MarketEvent } from '@gb/market-types';
import { instrumentTypeSchema } from '@gb/market-types';
import type { AdapterCapabilities, AdapterHandlers, MarketDataAdapter } from './index';

export interface ReplayFixture {
  meta: {
    provider: string;
    symbol: string;
    instrumentType: string;
    description?: string;
  };
  /** Events sorted by timestamp; deterministic replay. */
  events: MarketEvent[];
}

export interface ReplayAdapterOptions extends AdapterHandlers {
  fixturePath?: string;
  fixture?: ReplayFixture;
}

/**
 * MODE F — historical replay (spec §4/§18). Deterministic: same fixture +
 * same speed ⇒ same sequence. Supports pause / resume / speed / seek / restart.
 */
export class ReplayAdapter implements MarketDataAdapter {
  readonly provider = 'replay';
  symbol: string;
  readonly capabilities: AdapterCapabilities = {
    orderBook: true,
    trades: true,
    aggressorSide: true,
    liquidations: false,
    live: false,
  };

  private readonly fixturePath?: string;
  private fixture: ReplayFixture | null = null;
  private readonly onEvent: (event: MarketEvent) => void;
  private readonly onStatus: (status: ConnectionStatus) => void;
  private readonly onFeed?: (entry: FeedEntry) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private index = 0;
  private paused = false;
  private speed = 1;
  private startedAt = 0;
  private baseTimestamp = 0;
  private lastEventAt = 0;
  private state: ConnectionStatus['state'] = 'idle';

  constructor(options: ReplayAdapterOptions) {
    this.fixturePath = options.fixturePath;
    this.fixture = options.fixture ?? null;
    this.onEvent = options.onEvent;
    this.onStatus = options.onStatus;
    this.onFeed = options.onFeed;
    this.symbol = options.fixture?.meta.symbol ?? 'replay-fixture';
  }

  async connect(): Promise<void> {
    if (this.fixture == null && this.fixturePath != null) {
      const raw = await readFile(this.fixturePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      this.fixture = validateFixture(parsed);
    }
    if (this.fixture == null) {
      throw new Error('ReplayAdapter requires a fixture or fixturePath');
    }
    this.symbol = this.fixture.meta.symbol;
    this.index = 0;
    this.paused = false;
    this.speed = 1;
    this.baseTimestamp = this.fixture.events[0]?.timestamp ?? Date.now();
    this.startedAt = Date.now();
    this.setStatus('connected');
    this.schedule();
  }

  disconnect(): void {
    this.stopTimer();
    this.setStatus('idle');
  }

  getHealth(): ConnectionStatus {
    return {
      provider: this.provider,
      state: this.state,
      lastMessageAt: this.lastEventAt,
      reconnectAttempts: 0,
    };
  }

  pause(): void {
    this.paused = true;
    this.stopTimer();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.startedAt = Date.now() - this.elapsedMs();
    this.schedule();
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0.1, Math.min(32, speed));
  }

  /** Seek to a position in milliseconds relative to the first event. */
  seek(positionMs: number): void {
    if (this.fixture == null) return;
    const target = this.baseTimestamp + positionMs;
    let next = 0;
    for (let i = 0; i < this.fixture.events.length; i++) {
      const ev = this.fixture.events[i]!;
      if (ev.timestamp >= target) break;
      next = i + 1;
    }
    this.index = next;
    this.startedAt = Date.now() - positionMs / this.speed;
  }

  restart(): void {
    this.seek(0);
  }

  getElapsedMs(): number {
    return this.elapsedMs();
  }

  /** Total fixture duration in milliseconds (last event − first event). */
  getDurationMs(): number {
    if (this.fixture == null || this.fixture.events.length < 2) return 0;
    const first = this.fixture.events[0]?.timestamp ?? 0;
    const last = this.fixture.events[this.fixture.events.length - 1]?.timestamp ?? 0;
    return Math.max(0, last - first);
  }

  private elapsedMs(): number {
    return (Date.now() - this.startedAt) * this.speed;
  }

  private schedule(): void {
    this.stopTimer();
    if (this.fixture == null || this.paused) return;
    const events = this.fixture.events;
    if (this.index >= events.length) {
      this.onFeed?.({ kind: 'warning', text: 'Replay finished — restart to replay', ts: Date.now() });
      return;
    }
    const current = events[this.index]!;
    const next = events[this.index + 1];
    const delay = next != null ? (next.timestamp - current.timestamp) / this.speed : 0;
    this.timer = setTimeout(() => {
      this.emitCurrent();
      this.schedule();
    }, Math.max(0, Math.min(delay, 60_000)));
  }

  private emitCurrent(): void {
    if (this.fixture == null) return;
    const event = this.fixture.events[this.index];
    if (event == null) return;
    this.lastEventAt = Date.now();
    this.onEvent(event);
    this.index += 1;
  }

  private stopTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setStatus(state: ConnectionStatus['state']): void {
    this.state = state;
    this.onStatus({
      provider: this.provider,
      state,
      lastMessageAt: Date.now(),
      reconnectAttempts: 0,
    });
  }
}

function validateFixture(raw: unknown): ReplayFixture {
  if (typeof raw !== 'object' || raw == null) throw new Error('Invalid replay fixture');
  const meta = (raw as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta == null) throw new Error('Invalid fixture meta');
  const m = meta as { provider?: unknown; symbol?: unknown; instrumentType?: unknown };
  const events = (raw as { events?: unknown }).events;
  if (!Array.isArray(events)) throw new Error('Invalid fixture events');
  if (typeof m.provider !== 'string' || typeof m.symbol !== 'string') {
    throw new Error('Invalid fixture meta provider/symbol');
  }
  const instrumentType = instrumentTypeSchema.safeParse(m.instrumentType);
  const description = (m as { description?: unknown }).description;
  return {
    meta: {
      provider: m.provider,
      symbol: m.symbol,
      instrumentType: instrumentType.success ? instrumentType.data : 'replay',
      description: typeof description === 'string' ? description : undefined,
    },
    events: events as MarketEvent[],
  };
}
