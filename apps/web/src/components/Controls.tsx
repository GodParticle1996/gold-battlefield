import { useState } from 'react';
import type { CameraMode, EffectIntensity, QualityLevel } from '@gb/shared-config';
import { CAMERA_MODES, EFFECT_INTENSITIES, QUALITY_LEVELS, VOLUME_WINDOWS_MS } from '@gb/shared-config';
import { sendWorker } from '../bridge';
import { useStore } from '../store';

const MODES: Array<{ value: string; label: string }> = [
  { value: 'aggregated', label: 'Aggregated live — 5 gold-token venues' },
  { value: 'binance', label: 'Binance PAXG/USDC (live)' },
  { value: 'kraken', label: 'Kraken XAUT/USD (live)' },
  { value: 'coinbase', label: 'Coinbase PAXG-USD (live)' },
  { value: 'gemini', label: 'Gemini PAXG/USD (live)' },
  { value: 'bitstamp', label: 'Bitstamp PAXG/USD (live)' },
  { value: 'reference', label: 'XAU/USD reference price (live, no order flow)' },
  { value: 'replay', label: 'Historical replay (fixture)' },
  { value: 'simulation', label: 'Synthetic simulation (not live)' },
];

const windowLabel = (ms: number): string => (ms >= 60_000 ? `${ms / 60_000}m` : `${ms / 1000}s`);

export function Controls() {
  const [open, setOpen] = useState(false);

  // Individual selectors: an object literal here returns a new reference on
  // every store tick and re-renders the whole bar 12 times a second.
  const mode = useStore((state) => state.mode);
  const replaySpeed = useStore((state) => state.replaySpeed);
  const effectsIntensity = useStore((state) => state.effectsIntensity);
  const reducedMotion = useStore((state) => state.reducedMotion);
  const colorBlind = useStore((state) => state.colorBlind);
  const pauseRender = useStore((state) => state.pauseRender);
  const pauseData = useStore((state) => state.pauseData);
  const cameraMode = useStore((state) => state.cameraMode);
  const showLabels = useStore((state) => state.showLabels);
  const audioEnabled = useStore((state) => state.audioEnabled);
  const cvdWindowMs = useStore((state) => state.cvdWindowMs);
  const volumeWindowMs = useStore((state) => state.volumeWindowMs);
  const wallThresholdUsd = useStore((state) => state.wallThresholdUsd);
  const quality = useStore((state) => state.quality);
  const autoQuality = useStore((state) => state.autoQuality);
  const replayProgress = useStore((state) => state.replayProgress);

  const setSettings = useStore((state) => state.setSettings);
  const setQuality = useStore((state) => state.setQuality);
  const setAutoQuality = useStore((state) => state.setAutoQuality);
  const resetCamera = useStore((state) => state.resetCamera);

  return (
    <div className={`controls${open ? ' open' : ''}`}>
      <div className="controls-row">
        <label>
          <span className="control-label">Source</span>
          {/* Mode is applied by the App effect that watches it, so the worker
              receives exactly one select per change. */}
          <select value={mode} onChange={(event) => setSettings({ mode: event.target.value })}>
            {MODES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="control-label">Camera</span>
          <select
            value={cameraMode}
            onChange={(event) => setSettings({ cameraMode: event.target.value as CameraMode })}
          >
            {CAMERA_MODES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <button onClick={resetCamera} title="Reset camera (R)">
          Reset view
        </button>
        <button
          className={pauseRender ? 'active' : ''}
          onClick={() => setSettings({ pauseRender: !pauseRender })}
          title="Freeze the 3D view; data keeps flowing (Space)"
        >
          {pauseRender ? 'Resume view' : 'Freeze view'}
        </button>
        <button
          className={showLabels ? 'active' : ''}
          onClick={() => setSettings({ showLabels: !showLabels })}
          title="In-scene labels (L)"
        >
          Labels
        </button>
        <button onClick={() => setSettings({ tvMode: true })} title="Hide all chrome (T)">
          TV mode
        </button>
        <button
          className={audioEnabled ? 'active' : ''}
          onClick={() => setSettings({ audioEnabled: !audioEnabled })}
          title="Impact sounds on large trades and wall breaks"
        >
          {audioEnabled ? 'Sound on' : 'Sound off'}
        </button>

        <span className="controls-spacer" />

        <button className="settings-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Close settings ▾' : 'Settings ▸'}
        </button>
      </div>

      {open && (
        <div className="controls-row secondary">
          <label>
            <span className="control-label">Effects</span>
            <select
              value={effectsIntensity}
              onChange={(event) =>
                setSettings({ effectsIntensity: event.target.value as EffectIntensity })
              }
            >
              {EFFECT_INTENSITIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="control-label">Quality</span>
            <select
              value={autoQuality ? 'auto' : quality}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'auto') {
                  setAutoQuality(true);
                } else {
                  setAutoQuality(false);
                  setQuality(value as QualityLevel);
                }
              }}
            >
              <option value="auto">auto (FPS-based)</option>
              {QUALITY_LEVELS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="control-label">CVD window</span>
            <select
              value={cvdWindowMs}
              onChange={(event) => setSettings({ cvdWindowMs: Number(event.target.value) })}
            >
              {VOLUME_WINDOWS_MS.map((value) => (
                <option key={value} value={value}>
                  {windowLabel(value)}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="control-label">Volume window</span>
            <select
              value={volumeWindowMs}
              onChange={(event) => setSettings({ volumeWindowMs: Number(event.target.value) })}
            >
              {VOLUME_WINDOWS_MS.map((value) => (
                <option key={value} value={value}>
                  {windowLabel(value)}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="control-label">Wall threshold</span>
            <select
              value={wallThresholdUsd}
              onChange={(event) => setSettings({ wallThresholdUsd: Number(event.target.value) })}
            >
              {[50_000, 100_000, 250_000, 500_000, 1_000_000].map((value) => (
                <option key={value} value={value}>
                  ${value >= 1_000_000 ? `${value / 1_000_000}M` : `${value / 1_000}k`}
                </option>
              ))}
            </select>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={reducedMotion}
              onChange={(event) => setSettings({ reducedMotion: event.target.checked })}
            />
            Reduced motion
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={colorBlind}
              onChange={(event) => setSettings({ colorBlind: event.target.checked })}
            />
            Colour-blind palette
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={pauseData}
              onChange={(event) => {
                setSettings({ pauseData: event.target.checked });
                sendWorker({ type: 'pause-data', paused: event.target.checked });
              }}
            />
            Pause data processing
          </label>

          {mode === 'replay' && (
            <>
              <label>
                <span className="control-label">Speed</span>
                <select
                  value={replaySpeed}
                  onChange={(event) => {
                    const speed = Number(event.target.value);
                    setSettings({ replaySpeed: speed });
                    sendWorker({ type: 'replay', action: 'speed', speed });
                  }}
                >
                  {[0.5, 1, 2, 4, 8].map((value) => (
                    <option key={value} value={value}>
                      {value}×
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={() => sendWorker({ type: 'replay', action: 'pause' })}>Pause</button>
              <button onClick={() => sendWorker({ type: 'replay', action: 'resume' })}>Resume</button>
              <button onClick={() => sendWorker({ type: 'replay', action: 'restart' })}>Restart</button>
              {replayProgress != null && replayProgress.durationMs > 0 && (
                <label>
                  <span className="control-label">Seek</span>
                  <input
                    type="range"
                    min={0}
                    max={replayProgress.durationMs}
                    value={Math.min(replayProgress.elapsedMs, replayProgress.durationMs)}
                    onChange={(event) =>
                      sendWorker({
                        type: 'replay',
                        action: 'seek',
                        positionMs: Number(event.target.value),
                      })
                    }
                    aria-label="Replay position"
                  />
                  <span className="seek-time">
                    {(Math.min(replayProgress.elapsedMs, replayProgress.durationMs) / 1000).toFixed(1)}s
                  </span>
                </label>
              )}
            </>
          )}

          <span className="hotkeys">H hud · T tv · L labels · R reset · Space freeze · WASD pan</span>
        </div>
      )}
    </div>
  );
}
