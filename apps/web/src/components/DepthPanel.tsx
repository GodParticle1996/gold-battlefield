import { useStore } from '../store';

export function DepthPanel() {
  const depth = useStore((state) => state.depth);
  const depthUnit = useStore((state) => state.depthUnit);
  const wallThresholdUsd = useStore((state) => state.wallThresholdUsd);
  const setSettings = useStore((state) => state.setSettings);

  if (depth == null || (depth.bids.length === 0 && depth.asks.length === 0)) {
    return (
      <section className="panel" aria-label="Order book depth">
        <h2>Depth</h2>
        <p className="empty">
          No order book in this mode — the reference-price feed publishes quotes only.
        </p>
      </section>
    );
  }

  const rows = [
    ...depth.asks.slice(0, 10).reverse().map((level) => ({ ...level, side: 'ask' as const })),
    ...depth.bids.slice(0, 10).map((level) => ({ ...level, side: 'bid' as const })),
  ];

  const valueOf = (price: number, quantity: number): number =>
    depthUnit === 'notional' ? price * quantity : quantity;
  const max = Math.max(1, ...rows.map((row) => valueOf(row.price, row.quantity)));

  return (
    <section className="panel" aria-label="Order book depth">
      <h2>
        Depth
        <button
          className="unit-toggle"
          onClick={() => setSettings({ depthUnit: depthUnit === 'notional' ? 'base' : 'notional' })}
          title="Toggle between quote notional (USD) and base quantity (oz)"
        >
          {depthUnit === 'notional' ? 'USD' : 'oz'}
        </button>
      </h2>
      <div className="depth">
        {rows.map((row) => {
          const notional = row.price * row.quantity;
          const value = valueOf(row.price, row.quantity);
          const pct = Math.max(2, (value / max) * 100);
          const isWall = notional >= wallThresholdUsd;
          return (
            <div key={`${row.side}-${row.price}`} className={`depth-row ${row.side}`}>
              <span className="depth-price">{row.price.toFixed(2)}</span>
              <div className="depth-track">
                <div
                  className={`depth-bar ${row.side}${isWall ? ' wall' : ''}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="depth-qty">
                {depthUnit === 'notional' ? formatCompact(notional) : row.quantity.toFixed(3)}
              </span>
            </div>
          );
        })}
      </div>
      <p className="panel-note">
        Displayed liquidity only — resting orders can be cancelled before they ever trade.
      </p>
    </section>
  );
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return value.toFixed(0);
}
