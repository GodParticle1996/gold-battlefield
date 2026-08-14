import { useStore } from '../store';

export function EventFeed() {
  const feed = useStore((state) => state.feed);

  return (
    <section className="panel feed" aria-label="Event feed" aria-live="polite">
      <h2>Events</h2>
      {feed.length === 0 ? (
        <p className="empty">
          Large trades, wall changes, provider switches, and stale-data warnings appear here.
        </p>
      ) : (
        <ul>
          {feed.map((entry, index) => (
            <li key={`${entry.ts}-${index}`}>
              <span className="t">{new Date(entry.ts).toLocaleTimeString()}</span>
              <span className={`kind-${entry.kind}`}>{entry.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
