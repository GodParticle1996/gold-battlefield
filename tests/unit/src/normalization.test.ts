import { describe, expect, it } from 'vitest';
import { parseMarketEvent } from '@gb/market-types';

const validSnapshot = {
  type: 'snapshot',
  provider: 'binance',
  symbol: 'PAXGUSDC',
  instrumentType: 'tokenized-gold-spot',
  timestamp: 1_752_000_000_000,
  sequence: 42,
  bids: [{ price: 4365, quantity: 10 }],
  asks: [{ price: 4365.1, quantity: 5 }],
};

describe('runtime validation (spec §6)', () => {
  it('accepts a valid snapshot', () => {
    expect(parseMarketEvent(validSnapshot)).not.toBeNull();
  });

  it('rejects events with missing required fields', () => {
    const { provider: _provider, ...missing } = validSnapshot;
    expect(parseMarketEvent(missing)).toBeNull();
  });

  it('rejects negative quantities and non-finite prices', () => {
    expect(
      parseMarketEvent({ ...validSnapshot, bids: [{ price: 4365, quantity: -1 }] }),
    ).toBeNull();
    expect(
      parseMarketEvent({ ...validSnapshot, bids: [{ price: Number.NaN, quantity: 1 }] }),
    ).toBeNull();
  });

  it('rejects unknown aggressor sides', () => {
    expect(
      parseMarketEvent({
        type: 'trade',
        provider: 'binance',
        symbol: 'PAXGUSDC',
        instrumentType: 'tokenized-gold-spot',
        timestamp: 1,
        tradeId: 'a1',
        price: 4365,
        baseQuantity: 1,
        quoteNotional: 4365,
        aggressorSide: 'sideways',
        isEstimated: false,
      }),
    ).toBeNull();
  });

  it('rejects a checksum of the wrong type (string instead of number)', () => {
    expect(
      parseMarketEvent({
        type: 'delta',
        provider: 'kraken',
        symbol: 'XAUT/USD',
        instrumentType: 'tokenized-gold-spot',
        timestamp: 1,
        bidUpdates: [],
        askUpdates: [],
        checksum: '12345',
      }),
    ).toBeNull();
  });

  it('rejects unknown event types via the discriminated union', () => {
    expect(parseMarketEvent({ ...validSnapshot, type: 'magic-event' })).toBeNull();
  });
});
