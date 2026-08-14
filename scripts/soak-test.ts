/**
 * Soak test (operational tool): runs the REAL reconstruction pipeline against
 * a gateway mode for a fixed duration and continuously checks stability:
 * sequence gaps, resyncs, book sanity (bestBid < bestAsk), staleness,
 * reconnect cycles, bounded depth, CVD honesty. Prints heartbeats and a final
 * pass/fail report.
 *
 * Usage:
 *   npx tsx scripts/soak-test.ts binance ws://localhost:8081 180000
 *
 * Pair with the gateway testing hook to exercise reconnects:
 *   BINANCE_FORCE_RECONNECT_MS=30000 npm run start --workspace @gb/gateway
 */
import WebSocket from 'ws';
import { AnalyticsEngine } from '@gb/analytics';
import type { MarketEvent } from '@gb/market-types';
import { LocalOrderBook } from '@gb/order-book';

const mode = process.argv[2] ?? 'binance';
const url = process.argv[3] ?? 'ws://localhost:8081';
const DURATION_MS = Number(process.argv[4] ?? 300_000);
const HEARTBEAT_MS = 30_000;

const ws = new WebSocket(url);
const book = new LocalOrderBook();
const analytics = new AnalyticsEngine();

const startedAt = Date.now();
let lastMessageAt = Date.now();
let eventsByType: Record<string, number> = {};
let gaps = 0;
let staleDiscarded = 0;
let resyncs = 0;
let negativeSpreads = 0;
let maxSpread = 0;
let maxDepthLevels = 0;
let connectedTransitions = 0;
let lastState = '';
let feeds: string[] = [];
let trades = 0;

book.onResync = () => {
  resyncs += 1;
};

function checkBookSanity(): void {
  const snap = book.snapshot();
  if (snap.bestBid != null && snap.bestAsk != null) {
    if (snap.bestBid >= snap.bestAsk) negativeSpreads += 1;
    if (snap.spread != null && snap.spread > maxSpread) maxSpread = snap.spread;
  }
  const depth = snap.bids.length + snap.asks.length;
  if (depth > maxDepthLevels) maxDepthLevels = depth;
}

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'select', mode }));
});

ws.on('message', (raw) => {
  lastMessageAt = Date.now();
  let msg: { type?: string; status?: { state: string; staleReason?: string }; entry?: { text: string }; event?: unknown };
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (msg.type === 'status') {
    const state = msg.status?.state ?? '';
    if (state !== lastState && lastState !== '') connectedTransitions += 1;
    lastState = state;
  }
  if (msg.type === 'feed' && msg.entry?.text) {
    feeds.push(msg.entry.text);
    if (feeds.length > 100) feeds.shift();
  }
  if (msg.type !== 'event' || msg.event == null) return;
  const event = msg.event as MarketEvent;
  eventsByType[event.type] = (eventsByType[event.type] ?? 0) + 1;

  switch (event.type) {
    case 'snapshot':
      book.applySnapshot(event);
      analytics.onBook(book.snapshot());
      checkBookSanity();
      break;
    case 'delta': {
      const first = event.firstSequence ?? null;
      const last = event.finalSequence ?? null;
      if (book.isApplied && last != null && first != null) {
        if (last <= book.lastUpdateId) staleDiscarded += 1;
        else if (first > book.lastUpdateId + 1) gaps += 1;
      }
      book.enqueueDelta(event);
      if (book.isApplied) {
        analytics.onBook(book.snapshot());
        checkBookSanity();
      }
      break;
    }
    case 'trade':
      trades += 1;
      analytics.onTrade(event);
      break;
    case 'reference-price':
      analytics.onReference(event);
      break;
    case 'liquidation':
      break;
  }
});

const heartbeat = setInterval(() => {
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);
  const staleSec = ((Date.now() - lastMessageAt) / 1000).toFixed(1);
  const snap = book.snapshot();
  console.log(
    `[${elapsedSec}s] applied=${book.isApplied} bid=${snap.bestBid ?? '-'} ask=${snap.bestAsk ?? '-'} ` +
      `events=${Object.values(eventsByType).reduce((a, b) => a + b, 0)} gaps=${gaps} staleDiscarded=${staleDiscarded} ` +
      `resyncs=${resyncs} negSpreads=${negativeSpreads} reconnects=${connectedTransitions} staleSec=${staleSec}`,
  );
}, HEARTBEAT_MS);

setTimeout(() => {
  clearInterval(heartbeat);
  const snap = book.snapshot();
  const metrics = analytics.snapshot();
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const staleSec = ((Date.now() - lastMessageAt) / 1000).toFixed(1);
  const totalEvents = Object.values(eventsByType).reduce((a, b) => a + b, 0);

  const checks = {
    noSequenceGaps: gaps === 0,
    noNegativeSpreads: negativeSpreads === 0,
    bookEventuallyApplied: book.isApplied,
    freshness: Number(staleSec) < 10,
    boundedDepth: maxDepthLevels <= 400,
    cvdHonest: metrics.cvd.available ? metrics.cvd.value !== 0 : true,
    reconnectsObserved: connectedTransitions >= 1,
  };
  const pass = Object.values(checks).every(Boolean);

  console.log(
    JSON.stringify(
      {
        mode,
        durationSec: Number(elapsedSec),
        status: pass ? 'PASS' : 'FAIL',
        checks,
        stats: {
          totalEvents,
          eventsByType,
          trades,
          gaps,
          staleDiscarded,
          resyncs,
          negativeSpreads,
          maxSpread,
          maxDepthLevels,
          connectedTransitions,
          stateSequence: [lastState],
          staleSec: Number(staleSec),
          bestBid: snap.bestBid,
          bestAsk: snap.bestAsk,
          spread: snap.spread,
          imbalance: metrics.imbalance,
          cvd: metrics.cvd,
          feeds: feeds.slice(0, 10),
        },
      },
      null,
      2,
    ),
  );
  ws.close();
  process.exit(pass ? 0 : 1);
}, DURATION_MS);
