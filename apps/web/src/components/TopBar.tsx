import { useStore } from '../store';

/** Compact status strip: what you are watching, and how trustworthy it is. */
export function TopBar() {
  const hello = useStore((state) => state.hello);
  const status = useStore((state) => state.status);
  const metrics = useStore((state) => state.metrics);
  const perf = useStore((state) => state.perf);
  const quality = useStore((state) => state.quality);
  const autoQuality = useStore((state) => state.autoQuality);
  const pauseRender = useStore((state) => state.pauseRender);
  const pauseData = useStore((state) => state.pauseData);

  const state = status?.state ?? 'connecting';
  const label = hello?.label ?? 'Connecting to the market-data gateway…';
  const lastUpdate =
    metrics?.lastEventAt != null && metrics.lastEventAt > 0
      ? new Date(metrics.lastEventAt).toLocaleTimeString()
      : '—';

  return (
    <header className="topbar">
      <span className="logo" aria-hidden="true">
        ⚔
      </span>
      <h1>GOLD BATTLEFIELD</h1>

      <span className={`badge badge-${state}`} role="status">
        {state}
      </span>
      {hello != null && <span className="symbol">{hello.symbol}</span>}
      <span className="mode-label">{label}</span>

      {pauseData && <span className="badge badge-paused">data paused</span>}
      {pauseRender && <span className="badge badge-paused">render paused</span>}

      <span className="topbar-spacer" />

      <span className="fresh" title="Timestamp of the last accepted market event">
        updated {lastUpdate}
      </span>
      <span className="perf" title="FPS · frame time · draw calls · active units">
        {perf.fps > 0
          ? `${perf.fps} fps · ${perf.frameMs} ms · ${perf.drawCalls} draws · ${perf.activeUnits} units`
          : 'measuring…'}
        {` · ${autoQuality ? `auto (${quality})` : quality}`}
      </span>
    </header>
  );
}
