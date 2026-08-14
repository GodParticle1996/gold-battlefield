/**
 * Live pipeline verification (operational tool):
 * connects to the gateway, selects a mode, and runs the REAL reconstruction
 * pipeline (LocalOrderBook + AnalyticsEngine) against the live stream for a
 * fixed window, then prints a JSON report: book consistency, sequence gaps,
 * resync count, BBO/spread, imbalance, CVD, freshness.
 *
 * Usage:
 *   npx tsx scripts/verify-live.ts binance   [ws://localhost:8081]
 *   npx tsx scripts/verify-live.ts simulation
 *   npx tsx scripts/verify-live.ts replay
 */
import WebSocket from 'ws';
import { AnalyticsEngine } from '@gb/analytics';
import type { MarketEvent } from '@gb/market-types';
import { LocalOrderBook } from '@gb/order-book';

const mode = process.argv[2] ?? 'binance';
const url = process.argv[3] ?? 'ws://localhost:8081';
const WINDOW_MS = Number(process.argv[4] ?? 12_000);

const ws = new WebSocket(url);
const book = new LocalOrderBook();
const analytics = new AnalyticsEngine();

let resyncs = 0;
let statuses: string[] = [];
let feeds: string[] = [];
let snapshotAt = 0;
let eventsByType: Record<string, number> = {};
let beforeSnapshotDeltas = 0;

book.onResync = () => {
  resyncs += 1;
};

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'select', mode }));
});

ws.on('message', (raw) => {
  let msg: { type?: string; status?: { state: string; staleReason?: string }; entry?: { text: string }; event?: unknown };
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (msg.type === 'status') {
    statuses.push(`${msg.status?.state}${msg.status?.staleReason ? `:${msg.status.staleReason}` : ''}`);
  }
  if (msg.type === 'feed') {
    feeds.push(msg.entry?.text ?? '');
  }
  if (msg.type !== 'event' || msg.event == null) return;
  const event = msg.event as MarketEvent;
  eventsByType[event.type] = (eventsByType[event.type] ?? 0) + 1;

  switch (event.type) {
    case 'snapshot':
      book.applySnapshot(event);
      analytics.onBook(book.snapshot());
      snapshotAt = Date.now();
      break;
    case 'delta':
      if (!book.isApplied) beforeSnapshotDeltas += 1;
      book.enqueueDelta(event);
      if (book.isApplied) analytics.onBook(book.snapshot());
      break;
    case 'trade':
      analytics.onTrade(event);
      break;
    case 'reference-price':
      analytics.onReference(event);
      break;
    case 'liquidation':
      break;
  }
});

setTimeout(() => {
  const snap = book.snapshot();
  const metrics = analytics.snapshot();
  console.log(
    JSON.stringify(
      {
        mode,
        statuses,
        feeds: feeds.slice(0, 5),
        eventsByType,
        book: {
          applied: book.isApplied,
          updateId: book.lastUpdateId,
          bestBid: snap.bestBid,
          bestAsk: snap.bestAsk,
          midpoint: snap.midpoint,
          spread: snap.spread,
          depthLevels: { bids: snap.bids.length, asks: snap.asks.length },
          resyncs,
          beforeSnapshotDeltasBuffered: beforeSnapshotDeltas,
        },
        analytics: {
          imbalance: metrics.imbalance,
          cvd: metrics.cvd,
          lastPrice: metrics.lastPrice,
          volume1mOz: metrics.volumesMs[60_000] ?? null,
        },
        freshnessMs: snapshotAt > 0 ? Date.now() - snapshotAt : null,
      },
      null,
      2,
    ),
  );
  ws.close();
  process.exit(0);
}, WINDOW_MS);
