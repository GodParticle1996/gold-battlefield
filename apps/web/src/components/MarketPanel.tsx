import { useStore } from '../store';

function Row({ k, v, muted = false, title }: { k: string; v: string; muted?: boolean; title?: string }) {
  return (
    <div className="row" title={title}>
      <span className="k">{k}</span>
      <span className={`v${muted ? ' muted' : ''}`}>{v}</span>
    </div>
  );
}

const windowLabel = (ms: number): string => (ms >= 60_000 ? `${ms / 60_000}m` : `${ms / 1000}s`);

/** Tug-of-war bar for resting depth: which side has more displayed liquidity. */
function ImbalanceBar({ imbalance }: { imbalance: number }) {
  const bullPct = Math.round(((imbalance + 1) / 2) * 100);
  return (
    <div
      className="imbalance"
      title="Share of displayed resting depth. Descriptive of the current book only — not a forecast."
    >
      <div className="imbalance-track">
        <div className="imbalance-bull" style={{ width: `${bullPct}%` }} />
        <div className="imbalance-mid" />
      </div>
      <div className="imbalance-legend">
        <span className="bull">bids {bullPct}%</span>
        <span className="bear">{100 - bullPct}% asks</span>
      </div>
    </div>
  );
}

export function MarketPanel() {
  const metrics = useStore((state) => state.metrics);
  const status = useStore((state) => state.status);
  const cvdWindowMs = useStore((state) => state.cvdWindowMs);
  const volumeWindowMs = useStore((state) => state.volumeWindowMs);

  const fmt = (value: number | null | undefined, digits = 2): string =>
    value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);

  const freshnessMs =
    metrics?.lastEventAt != null && metrics.lastEventAt > 0 ? Date.now() - metrics.lastEventAt : null;
  const freshness =
    freshnessMs == null
      ? '—'
      : freshnessMs < 1000
        ? `${freshnessMs} ms`
        : `${(freshnessMs / 1000).toFixed(1)} s`;

  // The label always names the window the number was actually computed over.
  const cvd = metrics?.cvdByWindow?.[cvdWindowMs];
  const volume = metrics?.volumesMs?.[volumeWindowMs];

  return (
    <section className="panel" aria-label="Market data">
      <h2>Market</h2>
      <div className="rows">
        <Row k="Last price" v={`$${fmt(metrics?.lastPrice)}`} />
        <Row k="Best bid" v={`$${fmt(metrics?.bestBid)}`} title="Highest displayed buy order" />
        <Row k="Best ask" v={`$${fmt(metrics?.bestAsk)}`} title="Lowest displayed sell order" />
        <Row k="Spread" v={fmt(metrics?.spread)} title="Best ask minus best bid" />
        <Row k="Midpoint" v={`$${fmt(metrics?.midpoint)}`} />
        <Row
          k={`CVD (${windowLabel(cvdWindowMs)})`}
          v={cvd?.available === true ? `$${fmt(cvd.value, 0)}` : 'unavailable'}
          muted={cvd?.available !== true}
          title="Cumulative volume delta: aggressive buy notional minus aggressive sell notional. Hidden when the aggressor side cannot be determined."
        />
        <Row k={`Volume (${windowLabel(volumeWindowMs)})`} v={`${fmt(volume ?? null, 2)} oz`} />
        <Row
          k="Trade rate"
          v={metrics == null ? '—' : `${metrics.tradesPerSecond.toFixed(2)} /s`}
          title="Executed trades per second over the last 30 seconds"
        />
        <Row k="Large trades" v={metrics == null ? '—' : String(metrics.largeTradeCount)} />
        <Row k="Data freshness" v={freshness} muted={freshnessMs != null && freshnessMs > 20_000} />
        <Row
          k="Latency"
          v={status?.latencyEstimate != null ? `${status.latencyEstimate} ms` : '—'}
          muted
        />
      </div>
      <ImbalanceBar imbalance={metrics?.imbalance ?? 0} />
    </section>
  );
}
