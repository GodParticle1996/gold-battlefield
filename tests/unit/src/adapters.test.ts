import { describe, expect, it } from 'vitest';
import type { ConnectionStatus } from '@gb/market-types';
import {
  compositeMidpoint,
  isVenueComparable,
  pickPrimaryVenue,
  VENUE_ORDER,
  VENUE_TOLERANCE,
  parseBitstampBookSnapshot,
  parseBitstampDiff,
  parseBitstampTrade,
  parseCoinbaseL2Update,
  parseCoinbaseMatch,
  parseCoinbaseSnapshot,
  parseCoinbaseTicker,
  parseGeminiDelta,
  parseGeminiInitialSnapshot,
  parseGeminiTicker,
  parseGeminiTrade,
  parseSwissquoteBbo,
} from '@gb/provider-adapters';

// Real payload captured from the Swissquote public endpoint (2026-08-13).
const realPayload = [
  {
    topo: { platform: 'SwissquoteCapitalMarkets', server: 'Live7' },
    spreadProfilePrices: [
      { spreadProfile: 'premium', bidSpread: 25.4, askSpread: 25.4, bid: 4365.526, ask: 4366.184 },
      { spreadProfile: 'prime', bidSpread: 24.4, askSpread: 24.4, bid: 4365.536, ask: 4366.174 },
    ],
    ts: 1786639488787,
  },
  { topo: { platform: 'AT', server: 'AT' }, spreadProfilePrices: [{ spreadProfile: 'standard', bid: 4365.51, ask: 4366.2 }] },
];

describe('parseSwissquoteBbo (MODE D)', () => {
  it('parses the real endpoint payload using the first profile', () => {
    const bbo = parseSwissquoteBbo(realPayload);
    expect(bbo).not.toBeNull();
    expect(bbo!.bid).toBeCloseTo(4365.526);
    expect(bbo!.ask).toBeCloseTo(4366.184);
    expect(bbo!.ts).toBe(1786639488787);
  });

  it('returns null for malformed payloads', () => {
    expect(parseSwissquoteBbo(null)).toBeNull();
    expect(parseSwissquoteBbo('not an array')).toBeNull();
    expect(parseSwissquoteBbo([])).toBeNull();
    expect(parseSwissquoteBbo([{}])).toBeNull();
    expect(parseSwissquoteBbo([{ spreadProfilePrices: [{ bid: -1, ask: 1 }] }])).toBeNull();
    expect(parseSwissquoteBbo([{ spreadProfilePrices: [{ bid: 1, ask: Number.NaN }] }])).toBeNull();
  });
});

describe('compositeMidpoint (MODE C)', () => {
  it('averages available venue midpoints', () => {
    expect(compositeMidpoint([4365, 4367])).toBeCloseTo(4366);
    expect(compositeMidpoint([4365, 4367, 4366])).toBeCloseTo(4366);
  });

  it('ignores invalid values and returns null when none are available', () => {
    expect(compositeMidpoint([0, -5, Number.NaN])).toBeNull();
    expect(compositeMidpoint([])).toBeNull();
    expect(compositeMidpoint([4365, 0])).toBeCloseTo(4365);
  });

  it('never fabricates a consolidated book — single venue degrades to its midpoint', () => {
    expect(compositeMidpoint([4365])).toBeCloseTo(4365);
  });
});

describe('isVenueComparable (MODE C compatibility guard)', () => {
  it('accepts venues quoting in line with the composite', () => {
    expect(isVenueComparable(4365, 4366)).toBe(true); // ~0.02% apart
    expect(isVenueComparable(4366, 4366)).toBe(true);
  });

  it('rejects a venue that has drifted away from the rest', () => {
    // A book at 4333 cannot place trades against a composite at 4349.
    expect(isVenueComparable(4333.8, 4349)).toBe(false);
  });

  it('treats the tolerance boundary as comparable', () => {
    const composite = 4000;
    expect(isVenueComparable(composite * (1 + VENUE_TOLERANCE), composite)).toBe(true);
    expect(isVenueComparable(composite * (1 + VENUE_TOLERANCE * 1.5), composite)).toBe(false);
  });

  it('never excludes when there is no basis for comparison', () => {
    expect(isVenueComparable(undefined, 4365)).toBe(true);
    expect(isVenueComparable(4365, null)).toBe(true);
    expect(isVenueComparable(4365, 0)).toBe(true);
  });
});

describe('pickPrimaryVenue (MODE C five-venue)', () => {
  const health = (...entries: [string, ConnectionStatus['state']][]) =>
    new Map<string, ConnectionStatus>(
      entries.map(([venue, state]) => [
        venue,
        { provider: venue, state, lastMessageAt: Date.now(), reconnectAttempts: 0 },
      ]),
    );

  it('prefers the highest-ranked connected venue', () => {
    expect(pickPrimaryVenue(VENUE_ORDER, health(['kraken', 'connected'], ['binance', 'connecting']))).toBe('kraken');
    expect(pickPrimaryVenue(VENUE_ORDER, health(['coinbase', 'connected'], ['binance', 'failed'], ['gemini', 'connected']))).toBe('coinbase');
    expect(pickPrimaryVenue(VENUE_ORDER, health(['binance', 'connected'], ['gemini', 'connected']))).toBe('binance');
  });

  it('ignores reconnecting/connecting/failed venues', () => {
    expect(
      pickPrimaryVenue(VENUE_ORDER, health(['binance', 'reconnecting'], ['kraken', 'connecting'], ['bitstamp', 'failed'])),
    ).toBeNull();
    expect(pickPrimaryVenue(VENUE_ORDER, health(['kraken', 'connected'], ['gemini', 'connected']))).toBe('kraken');
  });

  it('recovers to a higher-ranked venue when it reconnects', () => {
    const map = health(['kraken', 'connected'], ['binance', 'failed']);
    expect(pickPrimaryVenue(VENUE_ORDER, map)).toBe('kraken');
    map.set('binance', { provider: 'binance', state: 'connected', lastMessageAt: Date.now(), reconnectAttempts: 1 });
    expect(pickPrimaryVenue(VENUE_ORDER, map)).toBe('binance');
  });
});

// Shapes captured live from the Coinbase exchange WS feed (2026-08-13).
describe('parseCoinbaseSnapshot (MODE A)', () => {
  it('maps bids/asks and keeps the sequence', () => {
    const snap = parseCoinbaseSnapshot(
      {
        type: 'snapshot',
        product_id: 'PAXG-USD',
        sequence: 4_398_710_239,
        bids: [['4358.23', '0.33905', 2], ['4357.38', '0.1096', 1]],
        asks: [['4358.65', '1.253542', 3]],
      },
      'PAXG-USD',
    );
    expect(snap).not.toBeNull();
    expect(snap!.provider).toBe('coinbase');
    expect(snap!.sequence).toBe(4_398_710_239);
    expect(snap!.bids[0]).toEqual({ price: 4358.23, quantity: 0.33905 });
    expect(snap!.asks[0]).toEqual({ price: 4358.65, quantity: 1.253542 });
  });

  it('rejects malformed levels', () => {
    expect(parseCoinbaseSnapshot({ type: 'snapshot', bids: [['nan', '1', 1]] }, 'PAXG-USD')).toBeNull();
    expect(parseCoinbaseSnapshot({ type: 'snapshot' }, 'PAXG-USD')).not.toBeNull();
  });
});

describe('parseCoinbaseL2Update (MODE A)', () => {
  it('routes buy→bids, sell→asks and keeps zero-size deletes', () => {
    const delta = parseCoinbaseL2Update(
      {
        type: 'l2update',
        product_id: 'PAXG-USD',
        changes: [
          ['buy', '4356.13', '0.00000'],
          ['buy', '4356.47', '2.71298'],
          ['sell', '4358.24', '2.47050'],
        ],
        time: '2026-08-13T18:14:13.960945Z',
      },
      'PAXG-USD',
    );
    expect(delta).not.toBeNull();
    expect(delta!.bidUpdates).toEqual([
      { price: 4356.13, quantity: 0 }, // zero-size = level removal
      { price: 4356.47, quantity: 2.71298 },
    ]);
    expect(delta!.askUpdates).toEqual([{ price: 4358.24, quantity: 2.4705 }]);
    // Coinbase deltas carry no sequence numbers — gap detection unavailable.
    expect(delta!.firstSequence).toBeUndefined();
    expect(delta!.finalSequence).toBeUndefined();
  });

  it('returns null when a level is malformed or nothing changed', () => {
    expect(
      parseCoinbaseL2Update({ type: 'l2update', changes: [['buy', 'x', '1']] }, 'PAXG-USD'),
    ).toBeNull();
    expect(parseCoinbaseL2Update({ type: 'l2update', changes: [] }, 'PAXG-USD')).toBeNull();
  });
});

describe('parseCoinbaseMatch (MODE A)', () => {
  it('derives the aggressor side from the taker side field', () => {
    const trade = parseCoinbaseMatch(
      {
        type: 'match',
        product_id: 'PAXG-USD',
        trade_id: 3_178_048,
        price: '4356.95',
        size: '0.02507',
        side: 'sell',
        time: '2026-08-13T18:12:40.443877784Z',
      },
      'PAXG-USD',
    );
    expect(trade).not.toBeNull();
    expect(trade!.aggressorSide).toBe('sell');
    expect(trade!.quoteNotional).toBeCloseTo(109.23, 2);
    expect(trade!.isEstimated).toBe(false);
  });

  it('marks unknown sides instead of guessing', () => {
    const trade = parseCoinbaseMatch(
      { type: 'match', price: '4360', size: '1', side: 'sideways' },
      'PAXG-USD',
    );
    expect(trade!.aggressorSide).toBe('unknown');
  });

  it('rejects malformed trades', () => {
    expect(parseCoinbaseMatch({ type: 'match', price: '0', size: '1' }, 'PAXG-USD')).toBeNull();
    expect(parseCoinbaseMatch({ type: 'match', price: 'nan', size: '1' }, 'PAXG-USD')).toBeNull();
  });
});

describe('parseCoinbaseTicker (MODE A)', () => {
  it('computes the midpoint from best bid/ask', () => {
    const ref = parseCoinbaseTicker(
      { type: 'ticker', best_bid: '4358.12', best_ask: '4358.65', time: '2026-08-13T18:12:40Z' },
      'PAXG-USD',
    );
    expect(ref).not.toBeNull();
    expect(ref!.midpoint).toBeCloseTo(4358.385);
    expect(ref!.isDelayed).toBe(false);
  });

  it('returns null when the book is empty', () => {
    expect(parseCoinbaseTicker({ type: 'ticker', best_bid: '0', best_ask: '0' }, 'PAXG-USD')).toBeNull();
  });
});

// Shapes captured live from the Gemini marketdata WS feed (2026-08-13).
describe('parseGeminiInitialSnapshot (MODE A/B)', () => {
  it('builds the full book from the first update (reason: initial)', () => {
    const snap = parseGeminiInitialSnapshot(
      {
        type: 'update',
        eventId: 1764551985976068,
        socket_sequence: 0, // fresh socket: initial book carries sequence 0
        events: [
          { delta: '4.5413', price: '4332.19', reason: 'initial', remaining: '4.5413', side: 'bid', type: 'change' },
          { delta: '0.00173355', price: '4332.13', reason: 'initial', remaining: '0.00173355', side: 'bid', type: 'change' },
          { delta: '0.5', price: '4361.94', reason: 'initial', remaining: '0.5', side: 'ask', type: 'change' },
          { delta: '0.0', price: '4399.0', reason: 'initial', remaining: '0.0', side: 'ask', type: 'change' },
        ],
      },
      'PAXGUSD',
    );
    expect(snap).not.toBeNull();
    expect(snap!.sequence).toBe(0); // first delta (socket_sequence 1) applies cleanly after it
    expect(snap!.bids).toEqual([
      { price: 4332.19, quantity: 4.5413 },
      { price: 4332.13, quantity: 0.00173355 },
    ]);
    expect(snap!.asks).toEqual([{ price: 4361.94, quantity: 0.5 }]); // zero-size level filtered
  });

  it('returns null for an empty initial book', () => {
    expect(parseGeminiInitialSnapshot({ type: 'update', events: [] }, 'PAXGUSD')).toBeNull();
  });

  it('falls back to sequence 1 when the initial update carries no sequence', () => {
    const snap = parseGeminiInitialSnapshot(
      { type: 'update', events: [{ price: '4332.0', remaining: '1.0', side: 'bid', type: 'change' }] },
      'PAXGUSD',
    );
    expect(snap!.sequence).toBe(1);
  });
});

describe('parseGeminiDelta (MODE A/B)', () => {
  it('uses cumulative remaining (set semantics) and carries socket_sequence', () => {
    const delta = parseGeminiDelta(
      {
        type: 'update',
        eventId: 1764551985979139,
        events: [{ delta: '0.09586533', price: '4332.2', reason: 'place', remaining: '0.09586533', side: 'bid', type: 'change' }],
        socket_sequence: 2,
        timestampms: 1786647317230,
      },
      'PAXGUSD',
    );
    expect(delta).not.toBeNull();
    expect(delta!.bidUpdates).toEqual([{ price: 4332.2, quantity: 0.09586533 }]);
    expect(delta!.firstSequence).toBe(2);
    expect(delta!.finalSequence).toBe(2);
  });

  it('keeps cancel-to-zero as a level deletion', () => {
    const delta = parseGeminiDelta(
      {
        type: 'update',
        events: [{ delta: '-1.0', price: '4361.89', reason: 'cancel', remaining: '0.0', side: 'ask', type: 'change' }],
        socket_sequence: 9,
      },
      'PAXGUSD',
    );
    expect(delta!.askUpdates).toEqual([{ price: 4361.89, quantity: 0 }]);
  });

  it('returns null when no levels changed', () => {
    expect(
      parseGeminiDelta({ type: 'update', events: [{ type: 'auction' }], socket_sequence: 3 }, 'PAXGUSD'),
    ).toBeNull();
  });
});

describe('parseGeminiTrade (MODE A/B)', () => {
  it('derives the aggressor from takerSide', () => {
    const trade = parseGeminiTrade(
      { type: 'trade', tid: 1642121883555, price: '4360.0', amount: '0.05', makerSide: 'sell', takerSide: 'buy' },
      'PAXGUSD',
    );
    expect(trade).not.toBeNull();
    expect(trade!.aggressorSide).toBe('buy');
    expect(trade!.quoteNotional).toBeCloseTo(218.0);
  });

  it('marks unknown aggressor instead of guessing (block trades without side)', () => {
    const trade = parseGeminiTrade(
      { type: 'block_trade', tid: 1, price: '4360.0', amount: '2.0' },
      'PAXGUSD',
    );
    expect(trade!.aggressorSide).toBe('unknown');
  });

  it('rejects malformed trades', () => {
    expect(parseGeminiTrade({ type: 'trade', price: '0', amount: '1' }, 'PAXGUSD')).toBeNull();
    expect(parseGeminiTrade({ type: 'auction' }, 'PAXGUSD')).toBeNull();
  });
});

describe('parseGeminiTicker (MODE A/B)', () => {
  it('computes the midpoint from bid/ask', () => {
    const ref = parseGeminiTicker(
      { type: 'ticker', symbol: 'PAXGUSD', bid: '4336.46', ask: '4361.94', last: '4360.21' },
      'PAXGUSD',
    );
    expect(ref).not.toBeNull();
    expect(ref!.midpoint).toBeCloseTo(4349.2);
  });

  it('returns null when bid/ask are missing', () => {
    expect(parseGeminiTicker({ type: 'ticker', last: '4360' }, 'PAXGUSD')).toBeNull();
  });
});

// Shapes captured live from Bitstamp (2026-08-13): REST order book + WS diff feed.
describe('parseBitstampBookSnapshot (MODE A/B)', () => {
  it('parses the REST order book payload', () => {
    const snap = parseBitstampBookSnapshot(
      { bids: [['4357.67', '0.022948'], ['4356.27', '0.229554']], asks: [['4359.92', '1.253542']] },
      'PAXGUSD',
    );
    expect(snap).not.toBeNull();
    expect(snap!.bids[0]).toEqual({ price: 4357.67, quantity: 0.022948 });
    expect(snap!.asks[0]).toEqual({ price: 4359.92, quantity: 1.253542 });
    expect(snap!.sequence).toBe(0); // no sequence numbers on the REST book
  });

  it('rejects malformed levels', () => {
    expect(parseBitstampBookSnapshot({ bids: [['nan', '1']] }, 'PAXGUSD')).toBeNull();
    expect(parseBitstampBookSnapshot({}, 'PAXGUSD')).not.toBeNull();
  });
});

describe('parseBitstampDiff (MODE A/B)', () => {
  it('maps diff levels and keeps zero-size removals', () => {
    const delta = parseBitstampDiff(
      { bids: [], asks: [['4356.6', '1.262335'], ['4357.06', '0.000000']] },
      'PAXGUSD',
    );
    expect(delta).not.toBeNull();
    expect(delta!.askUpdates).toEqual([
      { price: 4356.6, quantity: 1.262335 },
      { price: 4357.06, quantity: 0 }, // 0.000000 = level removal
    ]);
    // Bitstamp diffs carry no sequence numbers — gap detection unavailable.
    expect(delta!.firstSequence).toBeUndefined();
  });

  it('returns null when nothing changed or a level is malformed', () => {
    expect(parseBitstampDiff({ bids: [], asks: [] }, 'PAXGUSD')).toBeNull();
    expect(parseBitstampDiff({ bids: [['x', '1']] }, 'PAXGUSD')).toBeNull();
  });
});

describe('parseBitstampTrade (MODE A/B)', () => {
  it('maps type 0/1 to buy/sell aggressor per docs', () => {
    const buy = parseBitstampTrade(
      { event: 'trade', channel: 'live_trades_paxgusd', data: { id: 123, price: '4360.00', amount: '0.1', type: 0 } },
      'PAXGUSD',
    );
    expect(buy).not.toBeNull();
    expect(buy!.aggressorSide).toBe('buy');
    expect(buy!.quoteNotional).toBeCloseTo(436.0);

    const sell = parseBitstampTrade(
      { event: 'trade', data: { id: 124, price: '4360.00', amount: '0.1', type: 1 } },
      'PAXGUSD',
    );
    expect(sell!.aggressorSide).toBe('sell');
  });

  it('marks unknown sides instead of guessing', () => {
    const trade = parseBitstampTrade(
      { event: 'trade', data: { id: 125, price: '4360.00', amount: '0.1', type: 7 } },
      'PAXGUSD',
    );
    expect(trade!.aggressorSide).toBe('unknown');
  });

  it('rejects malformed trades', () => {
    expect(parseBitstampTrade({ event: 'trade', data: { price: '0', amount: '1' } }, 'PAXGUSD')).toBeNull();
    expect(parseBitstampTrade({ event: 'trade' }, 'PAXGUSD')).toBeNull();
  });
});
