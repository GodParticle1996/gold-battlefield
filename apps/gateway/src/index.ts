import http from 'node:http';
import { WebSocketServer } from 'ws';
import { allowedOrigins, env } from './env';
import { log } from './log';
import { Session } from './session';

// --- HTTP server (health + WebSocket upgrade) --------------------------------

const securityHeaders = {
  'content-type': 'application/json',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, securityHeaders);
    res.end(JSON.stringify({ ok: true, service: 'gold-battlefield-gateway', ts: Date.now() }));
    return;
  }
  res.writeHead(404, securityHeaders).end();
});

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (socket) => {
  const session = new Session(socket);
  log.info('client connected');
  socket.on('message', (data) => {
    session.handle(String(data));
  });
  socket.on('close', () => {
    session.dispose();
    log.info('client disconnected');
  });
  socket.on('error', () => {
    session.dispose();
  });
});

// --- Origin control + per-IP rate limiting (spec §15) --------------------------

const ipCounters = new Map<string, { count: number; windowStart: number }>();
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 60;

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin ?? '';
  const allowed = allowedOrigins.includes('*') || allowedOrigins.includes(origin);
  if (!allowed) {
    log.warn(`websocket upgrade rejected: origin ${origin}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const ip = req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const counter = ipCounters.get(ip) ?? { count: 0, windowStart: now };
  if (now - counter.windowStart > RATE_WINDOW_MS) {
    counter.count = 0;
    counter.windowStart = now;
  }
  counter.count += 1;
  ipCounters.set(ip, counter);
  if (counter.count > RATE_MAX_MESSAGES) {
    log.warn(`rate limit exceeded for ${ip}`);
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

server.listen(env.PORT, () => {
  log.info(`gateway listening on :${env.PORT}`);
});
