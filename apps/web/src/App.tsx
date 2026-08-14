import { useEffect, useRef } from 'react';
import { Battlefield } from './components/Battlefield';
import { Controls } from './components/Controls';
import { DepthPanel } from './components/DepthPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { EventFeed } from './components/EventFeed';
import { Legend } from './components/Legend';
import { MarketPanel } from './components/MarketPanel';
import { TopBar } from './components/TopBar';
import { AudioBridge } from './components/AudioBridge';
import { setWorker } from './bridge';
import { useIdle } from './hooks/useIdle';
import { useStore } from './store';
import type { ServerMessage } from './types';
import { DISCLAIMER } from '@gb/shared-config';

/** Hotkeys for the cinematic layout. Ignored while a form control has focus. */
function useHotkeys(): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const state = useStore.getState();
      switch (event.key.toLowerCase()) {
        case 'h':
          state.setSettings({ hudVisible: !state.hudVisible });
          break;
        case 't':
          state.setSettings({ tvMode: !state.tvMode });
          break;
        case 'l':
          state.setSettings({ showLabels: !state.showLabels });
          break;
        case 'r':
          state.resetCamera();
          break;
        case ' ':
          event.preventDefault();
          state.setSettings({ pauseRender: !state.pauseRender });
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}

export function App() {
  const workerRef = useRef<Worker | null>(null);
  const applyFrame = useStore((state) => state.applyFrame);
  const setReplayProgress = useStore((state) => state.setReplayProgress);
  const mode = useStore((state) => state.mode);
  const hudVisible = useStore((state) => state.hudVisible);
  const tvMode = useStore((state) => state.tvMode);
  const wallThresholdUsd = useStore((state) => state.wallThresholdUsd);
  const idle = useIdle(7_000);

  useHotkeys();

  useEffect(() => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    setWorker(worker);
    worker.onmessage = (event: MessageEvent<ServerMessage>) => {
      const message = event.data;
      if (message.type === 'frame') applyFrame(message);
      else if (message.type === 'replay-progress') {
        setReplayProgress({
          elapsedMs: message.elapsedMs,
          durationMs: message.durationMs,
          speed: message.speed,
        });
      }
    };
    worker.onerror = (event) => {
      useStore.getState().pushFeed({
        kind: 'warning',
        text: `Data worker error: ${event.message}`,
        ts: Date.now(),
      });
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
      setWorker(null);
    };
  }, [applyFrame, setReplayProgress]);

  useEffect(() => {
    workerRef.current?.postMessage({ type: 'select', mode });
  }, [mode]);

  // Push the persisted wall threshold into the pipeline so the 3D
  // fortifications and the depth panel always agree on what a wall is.
  useEffect(() => {
    workerRef.current?.postMessage({ type: 'config', wallThresholdUsd });
  }, [wallThresholdUsd]);

  const showHud = hudVisible && !tvMode;

  return (
    <div className={`app${tvMode ? ' tv' : ''}`}>
      <div className="stage">
        <ErrorBoundary>
          <Battlefield />
        </ErrorBoundary>
      </div>

      <AudioBridge />

      <div className={`hud${showHud ? '' : ' hud-hidden'}${idle ? ' hud-idle' : ''}`}>
        <TopBar />
        <div className="hud-middle">
          <div className="hud-column hud-left">
            <MarketPanel />
            <DepthPanel />
          </div>
          <div className="hud-column hud-right">
            <EventFeed />
            <Legend />
          </div>
        </div>
        <Controls />
      </div>

      {/* Persistent educational statement (spec §12/§20) — visible in every
          layout state, including TV mode with the rest of the HUD hidden. */}
      <p className="disclaimer-fixed">{DISCLAIMER}</p>

      {tvMode && <TvOverlay />}
    </div>
  );
}

/** Minimal readout for TV mode: instrument, mode honesty label, and price. */
function TvOverlay() {
  const hello = useStore((state) => state.hello);
  const price = useStore((state) => state.metrics?.lastPrice ?? null);
  const status = useStore((state) => state.status);

  return (
    <div className="tv-overlay">
      <div className="tv-symbol">{hello?.symbol ?? '—'}</div>
      <div className="tv-price">{price == null ? '—' : `$${price.toFixed(2)}`}</div>
      <div className="tv-mode">
        <span className={`badge badge-${status?.state ?? 'connecting'}`}>{status?.state ?? 'connecting'}</span>
        {hello?.label ?? ''}
      </div>
      <div className="tv-hint">press T to exit TV mode</div>
    </div>
  );
}
