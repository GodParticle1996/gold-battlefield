/**
 * CRC32 (IEEE 802.3) and the Kraken book checksum algorithm, verified against
 * the official guide "Book checksum (WebSocket v2)" (docs.kraken.com,
 * verified 2026-08-13).
 *
 * The algorithm operates on the RAW string fields from the exchange:
 *  1. asks top-10 sorted low → high, then bids top-10 sorted high → low;
 *  2. per level: strip "." from price and qty, strip leading zeros,
 *     concatenate price + qty;
 *  3. concatenate asks-string + bids-string;
 *  4. CRC32 of the result, cast to unsigned 32-bit int.
 *
 * NOTE: checksum validation therefore needs the raw strings captured from the
 * feed (the numeric book representation loses trailing zeros, which changes
 * the hash). The Kraken adapter keeps raw top-of-book strings for validation.
 */

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(input: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < input.length; i++) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ input.charCodeAt(i)) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ChecksumLevel {
  /** Raw string as received from the exchange, e.g. "45285.2". */
  price: string;
  /** Raw string as received from the exchange, e.g. "0.00100000". */
  quantity: string;
}

function strip(level: ChecksumLevel): string {
  const price = level.price.replace('.', '').replace(/^0+/, '');
  const quantity = level.quantity.replace('.', '').replace(/^0+/, '');
  return `${price}${quantity}`;
}

/** Builds the Kraken checksum input string from top-10 asks and bids (raw strings). */
export function buildKrakenChecksumString(asks: ChecksumLevel[], bids: ChecksumLevel[]): string {
  const sortedAsks = [...asks].sort((a, b) => parseFloat(a.price) - parseFloat(b.price)).slice(0, 10);
  const sortedBids = [...bids].sort((a, b) => parseFloat(b.price) - parseFloat(a.price)).slice(0, 10);
  return `${sortedAsks.map(strip).join('')}${sortedBids.map(strip).join('')}`;
}

/** Computes the Kraken book checksum (CRC32 of the checksum string). */
export function krakenChecksum(asks: ChecksumLevel[], bids: ChecksumLevel[]): number {
  return crc32(buildKrakenChecksumString(asks, bids));
}
