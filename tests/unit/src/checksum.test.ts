import { describe, expect, it } from 'vitest';
import { buildKrakenChecksumString, crc32, krakenChecksum } from '@gb/order-book';

// Example values from the official Kraken guide "Book checksum (WebSocket v2)".
const docAsks = [
  { price: '45285.2', quantity: '0.00100000' },
  { price: '45286.4', quantity: '1.54571953' },
  { price: '45286.6', quantity: '1.54571109' },
  { price: '45289.6', quantity: '1.54560911' },
  { price: '45290.2', quantity: '0.15890660' },
  { price: '45291.8', quantity: '1.54553491' },
  { price: '45294.7', quantity: '0.04454749' },
  { price: '45296.1', quantity: '0.35380000' },
  { price: '45297.5', quantity: '0.09945542' },
  { price: '45299.5', quantity: '0.18772827' },
];

const docBids = [
  { price: '45283.5', quantity: '0.10000000' },
  { price: '45283.4', quantity: '1.54582015' },
  { price: '45282.1', quantity: '0.10000000' },
  { price: '45281.0', quantity: '0.10000000' },
  { price: '45280.3', quantity: '1.54592586' },
  { price: '45279.0', quantity: '0.07990000' },
  { price: '45277.6', quantity: '0.03310103' },
  { price: '45277.5', quantity: '0.30000000' },
  { price: '45277.3', quantity: '1.54602737' },
  { price: '45276.6', quantity: '0.15445238' },
];

describe('Kraken book checksum (verified algorithm)', () => {
  it('reproduces the documented example checksum 3310070434', () => {
    expect(krakenChecksum(docAsks, docBids)).toBe(3_310_070_434);
  });

  it('sorts asks low→high and bids high→low before hashing', () => {
    const shuffledAsks = [...docAsks].reverse();
    const shuffledBids = [...docBids].reverse();
    expect(krakenChecksum(shuffledAsks, shuffledBids)).toBe(3_310_070_434);
  });

  it('strips dots and leading zeros per the documented format', () => {
    const string = buildKrakenChecksumString(
      [{ price: '45285.2', quantity: '0.00100000' }],
      [],
    );
    expect(string).toBe('452852100000');
  });

  it('crc32 is deterministic and matches known vectors', () => {
    expect(crc32('')).toBe(0);
    expect(crc32('abc')).toBe(0x352441c2);
  });
});
