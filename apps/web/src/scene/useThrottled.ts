import { useEffect, useRef, useState } from 'react';

/**
 * Rate-limits a value used as label text.
 *
 * Every distinct label string rasterizes a canvas and uploads a GPU texture, so
 * a value that changes on every 12 Hz frame would churn the label cache. This
 * keeps in-scene text legible and the texture cache stable.
 */
export function useThrottled<T>(value: T, intervalMs: number): T {
  const [visible, setVisible] = useState(value);
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    const timer = setInterval(() => {
      setVisible((current) => (Object.is(current, latest.current) ? current : latest.current));
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return visible;
}
