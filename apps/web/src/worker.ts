import { AnalyticsEngine } from '@gb/analytics';
import type { ConnectionStatus, FeedEntry } from '@gb/market-types';
import { parseMarketEvent } from '@gb/market-types';
import { LocalOrderBook } from '@gb/order-book';
import { DEPTH_TOP_N, RENDER_CADENCE_MS } from '@gb/shared-config';
import { VisualMapper } from '@gb/visual-mapping';
import type { HelloInfo, ReplayProgressMessage, WorkerInMessage } from './types';

/**
 * Pipeline worker (spec §13): owns the WebSocket connection, runtime
 * validation, order-book reconstruction, analytics, and the 12 Hz visual-state
 * aggregation. The 3D render loop consumes stable visual states — never raw
 * provider messages.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;

const book = new LocalOrderBook();
const analytics = new AnalyticsEngine();
const mapper = new VisualMapper();

let socket: WebSocket | null = null;
let mode = 'aggregated';
let hello: HelloInfo | null = null;
let status: ConnectionStatus | null = null;
let pendingFeed: FeedEntry[] = [];
let pauseData = false;
let resyncRequested = false;
let disconnectedNotified = false;
let reconnectDelayMs = 1_000;
/** Set by any book mutation; the frame tick re-derives BBO/depth at most once per frame. */
let bookDirty = false;

book.onResync = () => {
  if (!resyncRequested) {
    resyncRequested = true;
    send({ type: 'resync' });
  }
};

function gatewayUrl(): string {
  const configured = (import.meta.env.VITE_GATEWAY_URL as string | undefined)?.trim();
  return configured != null && configured.length > 0 ? configured : 'ws://localhost:8081';
}

/** Sends only on an OPEN socket — a CONNECTING socket throws InvalidStateError. */
function send(payload: unknown): void {
  if (socket != null && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function connect(): void {
  const ws = new WebSocket(gatewayUrl());
  socket = ws;

  ws.onopen = () => {
    resyncRequested = false;
    disconnectedNotified = false;
    reconnectDelayMs = 1_000;
    ws.send(JSON.stringify({ type: 'select', mode }));
  };

  ws.onmessage = (event) => {
    handleServerMessage(event.data);
  };

  ws.onclose = () => {
    socket = null;
    if (!disconnectedNotified) {
      disconnectedNotified = true;
      pendingFeed.push({
        kind: 'stale',
        text: 'Gateway connection lost — reconnecting…',
        ts: Date.now(),
      });
    }
    // Exponential backoff with jitter (spec §14).
    const jitter = Math.random() * 400;
    setTimeout(connect, reconnectDelayMs + jitter);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
  };

  ws.onerror = () => {
    // onclose handles reconnection.
  };
}

function handleServerMessage(raw: unknown): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return;
  }
  switch (message.type) {
    case 'hello':
      hello = message as unknown as HelloInfo;
      break;
    case 'status':
      status = message.status as ConnectionStatus;
      if (status?.state === 'failed' || status?.state === 'stale') {
        pendingFeed.push({
          kind: status.state === 'failed' ? 'warning' : 'stale',
          text: status.staleReason ?? `provider ${status.state}`,
          ts: Date.now(),
        });
      }
      break;
    case 'feed':
      pendingFeed.push(message.entry as FeedEntry);
      break;
    case 'event':
      routeEvent(message.event);
      break;
    case 'replay-progress':
      ctx.postMessage(message as unknown as ReplayProgressMessage);
      break;
  }
}

function routeEvent(raw: unknown): void {
  const event = parseMarketEvent(raw);
  if (event == null) return; // malformed — rejected safely, loop keeps running
  switch (event.type) {
    case 'snapshot':
      resyncRequested = false;
      book.applySnapshot(event);
      bookDirty = true;
      break;
    case 'delta':
      book.enqueueDelta(event);
      // Re-sorting the whole book per delta was O(n log n) per message; the
      // frame tick below does it once per rendered frame instead.
      if (book.isApplied) bookDirty = true;
      break;
    case 'trade': {
      const now = Date.now();
      const classification = analytics.onTrade(event);
      mapper.noteTrade(event.price, now);
      if (classification !== 'normal') {
        const side =
          event.aggressorSide === 'buy'
            ? 'aggressive buy'
            : event.aggressorSide === 'sell'
              ? 'aggressive sell'
              : 'trade (side unknown)';
        pendingFeed.push({
          kind: 'large-trade',
          text: `${classification === 'exceptional' ? 'Exceptional' : 'Large'} ${side}: ${event.baseQuantity.toFixed(3)} oz @ $${event.price.toFixed(2)}`,
          ts: event.timestamp,
        });
        mapper.addLargeTradeEffect(
          event.aggressorSide,
          event.price,
          now,
          classification === 'exceptional' ? 1 : 0.6,
        );
      }
      break;
    }
    case 'reference-price':
      analytics.onReference(event);
      break;
    case 'liquidation':
      // Reserved: never emitted for spot gold (no provider-reported feed).
      break;
  }
}

setInterval(() => {
  if (pauseData) return;
  if (bookDirty) {
    analytics.onBook(book.snapshot());
    bookDirty = false;
  }
  const metrics = analytics.snapshot();
  const bookSnap = book.snapshot();
  const depth = {
    bids: bookSnap.bids.slice(0, DEPTH_TOP_N),
    asks: bookSnap.asks.slice(0, DEPTH_TOP_N),
  };
  const visual = mapper.update(metrics, depth, RENDER_CADENCE_MS, Date.now());
  const feed = [...pendingFeed, ...mapper.drainFeed()];
  pendingFeed = [];
  ctx.postMessage({
    type: 'frame',
    visual,
    metrics,
    status,
    hello,
    feed,
    depth: { bids: depth.bids.slice(0, 14), asks: depth.asks.slice(0, 14) },
  });
}, RENDER_CADENCE_MS);

ctx.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'select':
      mode = message.mode;
      // A fresh provider must never inherit the previous venue's book (spec §14).
      book.reset();
      bookDirty = true;
      send({ type: 'select', mode });
      break;
    case 'replay':
      send({
        type: 'replay',
        action: message.action,
        speed: message.speed,
        positionMs: message.positionMs,
      });
      break;
    case 'pause-data':
      pauseData = message.paused;
      break;
    case 'config':
      mapper.setWallThreshold(message.wallThresholdUsd);
      break;
  }
};

connect();
