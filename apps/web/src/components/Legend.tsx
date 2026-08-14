import { useState } from 'react';
import { useStore } from '../store';

interface Entry {
  swatch: 'bull' | 'bear' | 'front' | 'neutral';
  what: string;
  means: string;
}

/**
 * Key to the metaphor. Every line states what a shape *is* in market terms —
 * no narration, no interpretation of what it might lead to.
 */
const ENTRIES: Entry[] = [
  {
    swatch: 'bull',
    what: 'Green army (left)',
    means: 'Resting buy orders — bids, sitting below the current price.',
  },
  {
    swatch: 'bear',
    what: 'Red army (right)',
    means: 'Resting sell orders — asks, sitting above the current price.',
  },
  {
    swatch: 'front',
    what: 'Glowing front line',
    means:
      'The last traded price. It moves only when trades print — and falls back to the book midpoint, tagged "mid", once the last print goes stale.',
  },
  {
    swatch: 'neutral',
    what: 'Gap around the line',
    means: 'The spread: the space between best bid and best ask, where nothing trades.',
  },
  {
    swatch: 'neutral',
    what: 'Army size',
    means: 'Displayed depth on that side. More units = more resting orders in the book.',
  },
  {
    swatch: 'neutral',
    what: 'Fortifications',
    means: 'A single price level holding unusually large size — a "wall".',
  },
  {
    swatch: 'front',
    what: 'Wall topples over',
    means: 'The level vanished while trades printed through it — most likely consumed.',
  },
  {
    swatch: 'neutral',
    what: 'Wall sinks and fades',
    means: 'The level vanished with no trade near it — the orders were most likely cancelled.',
  },
  {
    swatch: 'neutral',
    what: 'Charge + shockwave',
    means: 'A large executed trade (a "pressure event"). Never a liquidation — spot gold venues do not report those.',
  },
  {
    swatch: 'neutral',
    what: 'Ground scar',
    means: 'Where the price has been over the last couple of minutes.',
  },
  {
    swatch: 'neutral',
    what: 'Units stand down',
    means: 'No trades have printed for a while. The market is quiet — the scene does not invent activity.',
  },
];

export function Legend() {
  const [open, setOpen] = useState(false);
  const colorBlind = useStore((state) => state.colorBlind);

  return (
    <section className={`panel legend${open ? ' open' : ''}`} aria-label="Battlefield legend">
      <h2>
        <button
          className="legend-toggle"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title="What am I looking at?"
        >
          {open ? '▾' : '▸'} What am I looking at?
        </button>
      </h2>
      {open && (
        <dl className={`legend-list${colorBlind ? ' cb' : ''}`}>
          {ENTRIES.map((entry) => (
            <div key={entry.what} className="legend-item">
              <dt>
                <span className={`swatch swatch-${entry.swatch}`} aria-hidden="true" />
                {entry.what}
              </dt>
              <dd>{entry.means}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
