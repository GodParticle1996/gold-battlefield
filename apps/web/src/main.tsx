import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useStore } from './store';
import './styles.css';

// Stage-5 error reporting: global client errors become visible event-feed
// entries (deduped, sanitized — no third-party error service, no tracking).
let lastReported = '';
let lastReportedAt = 0;
const reportClientError = (text: string): void => {
  const now = Date.now();
  if (text === lastReported && now - lastReportedAt < 2_000) return;
  lastReported = text;
  lastReportedAt = now;
  useStore.getState().pushFeed({ kind: 'warning', text, ts: now });
};

window.addEventListener('error', (event) => {
  reportClientError(`Client error: ${event.message}`);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
  reportClientError(`Unhandled rejection: ${reason}`);
});

const rootElement = document.getElementById('root');
if (rootElement == null) throw new Error('missing #root element');

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
