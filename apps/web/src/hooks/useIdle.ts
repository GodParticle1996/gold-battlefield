import { useEffect, useState } from 'react';

/**
 * True once the pointer/keyboard has been quiet for `delayMs`. Used to fade the
 * HUD down so the battlefield can be watched without chrome in the way, while
 * any input brings the panels straight back.
 */
export function useIdle(delayMs: number): boolean {
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    let timer = window.setTimeout(() => setIdle(true), delayMs);

    const wake = (): void => {
      setIdle((current) => (current ? false : current));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), delayMs);
    };

    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const;
    for (const event of events) window.addEventListener(event, wake, { passive: true });

    return () => {
      window.clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, wake);
    };
  }, [delayMs]);

  return idle;
}
