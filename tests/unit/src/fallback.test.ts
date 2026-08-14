import { describe, expect, it } from 'vitest';
import { createAdapter, fallbackSequence, nextInChain } from '@gb/provider-adapters';

describe('fallback hierarchy (spec §4/§5)', () => {
  it('walks the documented chain from binance', () => {
    expect(nextInChain('binance')).toBe('kraken');
    expect(fallbackSequence('binance')).toEqual([
      'kraken',
      'coinbase',
      'gemini',
      'bitstamp',
      'aggregated',
      'reference',
      'delayed',
      'replay',
      'simulation',
    ]);
  });

  it('terminates at simulation', () => {
    expect(nextInChain('simulation')).toBeNull();
  });
});

describe('adapter factory', () => {
  it('creates a simulation adapter (MODE G)', () => {
    const adapter = createAdapter({
      mode: 'simulation',
      onEvent: () => {},
      onStatus: () => {},
      seed: 7,
    });
    expect(adapter.provider).toBe('simulation');
    expect(adapter.capabilities.live).toBe(false);
    expect(adapter.capabilities.liquidations).toBe(false);
    adapter.disconnect();
  });

  it('creates kraken and aggregated adapters (MODE B/C)', () => {
    const kraken = createAdapter({ mode: 'kraken', onEvent: () => {}, onStatus: () => {} });
    expect(kraken.provider).toBe('kraken');
    expect(kraken.capabilities.aggressorSide).toBe(true);
    kraken.disconnect();

    const aggregated = createAdapter({ mode: 'aggregated', onEvent: () => {}, onStatus: () => {} });
    expect(aggregated.provider).toBe('aggregated');
    aggregated.disconnect();
  });

  it('throws for delayed mode (served by the reference adapter instead)', () => {
    expect(() =>
      createAdapter({ mode: 'delayed', onEvent: () => {}, onStatus: () => {} }),
    ).toThrow(/reference/);
  });

  it('simulation emits a snapshot synchronously on connect', async () => {
    const events: unknown[] = [];
    const adapter = createAdapter({
      mode: 'simulation',
      onEvent: (event) => events.push(event),
      onStatus: () => {},
      seed: 1,
    });
    await adapter.connect();
    expect(events.some((e) => (e as { type?: string }).type === 'snapshot')).toBe(true);
    adapter.disconnect();
  });
});
