import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import type { Snapshot } from '../src/history.ts';
import { COLORS, HEIGHT, WIDTH, renderPanel, type PanelInput } from '../src/render.ts';

const NOW = Date.parse('2026-10-16T13:00:00.000Z');

// Explicitly synthetic unit-test data. Runtime rendering never creates fallback bars.
function snapshot(symbol = 'AAPL'): Snapshot {
  return {
    version: 1, source: 'YAHOO', unofficial: true, interval: '1d', symbol,
    currency: 'USD', timezone: 'America/New_York', fetchedAt: '2026-10-16T12:50:00.000Z',
    bars: Array.from({ length: 12 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 9, 4 + i, 16));
      return {
        timestamp: date.getTime() / 1_000, date: date.toISOString().slice(0, 10),
        open: 200 + i, high: 204 + i, low: 197 + i, close: 200 + i + (i % 2 ? -1 : 2),
      };
    }),
  };
}

function panel(): PanelInput {
  return {
    symbol: 'AAPL',
    quote: {
      price: 236.70, changePercent: 1.25, asOf: '2026-10-16T12:59:00.000Z',
      source: 'FINNHUB', currency: 'USD', stale: false, status: 'OK', delayed: false, unofficial: false,
    },
    history: { symbol: 'AAPL', snapshot: snapshot(), stale: false },
  };
}

function crop(rgba: Buffer, top: number, bottom: number): Buffer {
  return rgba.subarray(top * WIDTH * 4, (bottom + 1) * WIDTH * 4);
}

function hasColor(rgba: Buffer, color: string, top = 44, bottom = 76): boolean {
  const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  const pixels = crop(rgba, top, bottom);
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] === rgb[0] && pixels[i + 1] === rgb[1] && pixels[i + 2] === rgb[2]) return true;
  }
  return false;
}

test('renders a deterministic 128 x 128 opaque PNG and JPEG with independent quote and candle dates', () => {
  const input = panel();
  const output = renderPanel(input, NOW);
  assert.equal(output.rgba.length, 128 * 128 * 4);
  for (let i = 3; i < output.rgba.length; i += 4) assert.equal(output.rgba[i], 255);
  assert.deepEqual(output.png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(output.png.readUInt32BE(16), WIDTH);
  assert.equal(output.png.readUInt32BE(20), HEIGHT);
  const decodedJPEG = jpeg.decode(output.jpeg);
  assert.equal(decodedJPEG.width, WIDTH);
  assert.equal(decodedJPEG.height, HEIGHT);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < output.png.length;) {
    const length = output.png.readUInt32BE(offset);
    if (output.png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      chunks.push(output.png.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const pixels = inflateSync(Buffer.concat(chunks));
  for (let y = 0; y < HEIGHT; y++) {
    assert.equal(pixels[y * (WIDTH * 4 + 1)], 0);
    assert.deepEqual(pixels.subarray(y * (WIDTH * 4 + 1) + 1, (y + 1) * (WIDTH * 4 + 1)),
      output.rgba.subarray(y * WIDTH * 4, (y + 1) * WIDTH * 4));
  }
  assert.deepEqual(output.rgba, renderPanel(input, NOW).rgba);
  assert.ok(output.labels.includes('236.70'));
  assert.ok(!output.labels.includes('210.00')); // Last completed close is not the quote.
  assert.ok(output.labels.includes('C1D THRU 2026-10-15'));
  assert.ok(output.labels.includes('Q UTC 2026-10-16'));
  assert.ok(output.labels.includes('12:59 FINNHUB'));
  assert.ok(output.labels.includes('C YAHOO UNOFFICIAL'));
  assert.ok(output.labels.includes('QUOTE SOURCE: FINNHUB'));
  assert.ok(output.labels.every(label => !/\bLIVE\b/.test(label)));
  assert.ok(hasColor(output.rgba, COLORS.green));
  assert.ok(hasColor(output.rgba, COLORS.red));
});

test('quote changes cannot alter genuine daily candles', () => {
  const original = panel();
  const changed = panel();
  changed.quote.price = 999.99;
  changed.quote.changePercent = -12.34;
  changed.quote.asOf = '2026-10-16T12:58:00.000Z';
  const a = renderPanel(original, NOW);
  const b = renderPanel(changed, NOW);
  assert.notDeepEqual(a.rgba, b.rgba);
  assert.deepEqual(crop(a.rgba, 44, 76), crop(b.rgba, 44, 76));
});

test('a missing quote remains explicitly missing even when daily history exists', () => {
  const input = panel();
  input.quote.price = null;
  input.quote.changePercent = null;
  input.quote.asOf = null;
  input.quote.currency = null;
  input.quote.status = 'NO_DATA';
  const output = renderPanel(input, NOW);
  assert.ok(output.labels.includes('NO QUOTE'));
  assert.ok(output.labels.includes('CURRENCY UNKNOWN'));
  assert.ok(output.labels.includes('CHG N/A'));
  assert.ok(output.labels.includes('Q NO DATA'));
  assert.ok(output.labels.includes('Q UTC UNKNOWN'));
  assert.ok(output.labels.includes('C1D THRU 2026-10-15'));
  assert.ok(hasColor(output.rgba, COLORS.green));
});

test('absent, wrong-symbol, non-USD, malformed, and current-session history never produce candles', () => {
  const candidates: Array<Snapshot | undefined> = [undefined, snapshot('MSFT')];
  const nonUSD = snapshot(); nonUSD.currency = 'GBP'; candidates.push(nonUSD);
  const invalid = snapshot(); invalid.bars[0].high = 1; candidates.push(invalid);
  const current = snapshot();
  current.bars.at(-1)!.date = '2026-10-16';
  current.bars.at(-1)!.timestamp = Date.parse('2026-10-16T12:00:00.000Z') / 1_000;
  candidates.push(current);
  const short = snapshot(); short.bars = short.bars.slice(0, 2); candidates.push(short);
  for (const history of candidates) {
    const input = panel();
    input.history = history ? { snapshot: history, stale: false } : undefined;
    const output = renderPanel(input, NOW);
    assert.ok(output.labels.includes('CHART NO DATA'));
    assert.ok(!output.labels.some(label => label.startsWith('C1D THRU')));
    assert.ok(!hasColor(output.rgba, COLORS.green));
    assert.ok(!hasColor(output.rgba, COLORS.red));
  }
});

test('VWRA stays price-only even if a complete matching daily-history snapshot is supplied', () => {
  for (const symbol of ['VWRA.L', 'VWRA']) {
    const input = panel(); input.symbol = symbol;
    input.history = { snapshot: snapshot(symbol), stale: false };
    input.quote = { ...input.quote, source: 'YAHOO', delayed: true, unofficial: true, price: 161.25 };
    const output = renderPanel(input, NOW);
    assert.ok(output.labels.includes('C1D NOT REQUESTED'));
    assert.ok(output.labels.includes('DELAY'));
    assert.ok(output.labels.includes('QUOTE SOURCE: YAHOO DELAYED UNOFFICIAL'));
    assert.ok(output.labels.includes('Q YAHOO UNOFFICIAL'));
    assert.ok(!output.labels.some(label => label.startsWith('C1D THRU')));
    assert.ok(!hasColor(output.rgba, COLORS.green));
    assert.ok(!hasColor(output.rgba, COLORS.red));
  }
});

test('stale quote and history remain physically visible, including with Yahoo delay', () => {
  const input = panel();
  input.quote.stale = true;
  input.quote.source = 'YAHOO';
  input.quote.delayed = true;
  input.history!.stale = true;
  const output = renderPanel(input, NOW);
  assert.ok(output.labels.includes('Q+C STALE DELAY'));
  assert.ok(output.labels.includes('QUOTE STALE'));
  assert.ok(output.labels.includes('CHART STALE'));
  assert.ok(hasColor(output.rgba, COLORS.amber, 120, 126));
});

test('a quote-only stale flag is not hidden by fresh chart history', () => {
  const input = panel(); input.quote.stale = true;
  const output = renderPanel(input, NOW);
  assert.ok(output.labels.includes('Q STALE'));
  assert.ok(output.labels.includes('QUOTE STALE'));
  assert.ok(!output.labels.includes('CHART STALE'));
  assert.ok(hasColor(output.rgba, COLORS.amber, 120, 126));
});

test('history cache age and fetch errors trigger a visible stale history warning', () => {
  const old = panel();
  old.history!.snapshot!.fetchedAt = '2026-10-16T12:50:00.000Z';
  const oldOutput = renderPanel(old, Date.parse('2026-10-17T13:00:00.000Z'));
  assert.ok(oldOutput.labels.includes('CHART STALE'));
  assert.ok(oldOutput.labels.includes('C STALE'));
  const failed = panel(); failed.history!.error = 'Refresh failed';
  const failedOutput = renderPanel(failed, NOW);
  assert.ok(failedOutput.labels.includes('CHART STALE'));
  assert.ok(failedOutput.labels.includes('HISTORY ERROR: Refresh failed'));
});

test('missing or future quote time is unknown and visibly stale, while configured age policy stays upstream', () => {
  for (const asOf of [null, 'bad date', '2026-10-16T14:00:00.000Z']) {
    const input = panel(); input.quote.asOf = asOf;
    const output = renderPanel(input, NOW);
    assert.ok(output.labels.includes('Q UTC UNKNOWN'));
    assert.ok(output.labels.includes('Q STALE'));
  }
  const input = panel(); input.quote.asOf = '2026-10-15T20:00:00.000Z';
  const output = renderPanel(input, NOW);
  assert.ok(!output.labels.includes('QUOTE STALE'));
  input.quote.stale = true;
  assert.ok(renderPanel(input, NOW).labels.includes('QUOTE STALE'));
});

test('invalid prices never leak NaN/Infinity or a daily-close replacement into the quote', () => {
  for (const price of [NaN, Infinity, -1, 0]) {
    const input = panel(); input.quote.price = price;
    const output = renderPanel(input, NOW);
    assert.ok(output.labels.includes('NO QUOTE'));
    assert.ok(output.labels.includes('Q NO DATA'));
  }
});

test('VALL and SPCX are price-only, and USD/JPY is denominated in yen per dollar', () => {
  for (const symbol of ['VALL', 'SPCX', 'USD/JPY']) {
    const input = panel(); input.symbol = symbol;
    input.quote.source = 'YAHOO'; input.quote.delayed = true;
    input.quote.currency = symbol === 'USD/JPY' ? 'JPY' : 'USD';
    input.quote.price = symbol === 'USD/JPY' ? 149.23 : 161.25;
    input.history = undefined;
    const output = renderPanel(input, NOW);
    assert.ok(output.labels.includes(`${symbol} PRICE ONLY`));
    assert.ok(output.labels.includes('C1D NOT REQUESTED'));
    assert.ok(output.labels.includes('DELAY'));
    assert.ok(output.labels.includes('QUOTE SOURCE: YAHOO DELAYED UNOFFICIAL'));
    if (symbol === 'USD/JPY') {
      assert.ok(output.labels.includes('JPY PER USD'));
      assert.ok(output.labels.includes('149.230'));
      assert.ok(!output.labels.includes('USD'));
    }
  }
});

test('unsupported currency-pair quotes and long ticker labels still produce a complete panel', () => {
  for (const symbol of ['USD/JPY', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456']) {
    const input = panel(); input.symbol = symbol; input.history = undefined;
    input.quote.price = null; input.quote.currency = null; input.quote.changePercent = null;
    const output = renderPanel(input, NOW);
    assert.ok(output.labels.includes(symbol));
    assert.ok(output.labels.includes('NO QUOTE'));
    assert.ok(output.labels.includes(symbol === 'USD/JPY' ? 'C1D NOT REQUESTED' : 'CHART NO DATA'));
    assert.equal(output.rgba.length, WIDTH * HEIGHT * 4);
  }
});

test('flat candles and large finite OHLC values render without unsafe coordinate arithmetic', () => {
  for (const value of [0.001, 200, Number.MAX_VALUE / 2]) {
    const input = panel();
    for (const bar of input.history!.snapshot!.bars) {
      bar.open = value; bar.high = value; bar.low = value; bar.close = value;
    }
    const output = renderPanel(input, NOW);
    assert.ok(output.labels.includes('C1D THRU 2026-10-15'));
    assert.ok(hasColor(output.rgba, COLORS.muted));
  }
});

test('input quote and history objects are never mutated', () => {
  const input = panel();
  const copy = structuredClone(input);
  renderPanel(input, NOW);
  assert.deepEqual(input, copy);
});
