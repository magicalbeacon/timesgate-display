import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchHistory, isSnapshotStale, validateSnapshot } from '../src/history.ts';
import type { Snapshot } from '../src/history.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const DAY = 86_400;
const START = Date.parse('2026-09-01T08:00:00.000Z') / 1_000;

// These prices exist only inside simulated HTTP tests. Runtime code has no
// generated, sample, fallback, or adjusted-close data path.
function responseBody(length = 30) {
  return {
    chart: {
      error: null,
      result: [{
        meta: { symbol: 'VWRA.L', currency: 'USD', exchangeTimezoneName: 'Europe/London', dataGranularity: '1d' },
        timestamp: Array.from({ length }, (_, index) => START + index * DAY),
        indicators: {
          quote: [{
            open: Array.from({ length }, (_, index) => 100 + index),
            high: Array.from({ length }, (_, index) => 103 + index),
            low: Array.from({ length }, (_, index) => 99 + index),
            close: Array.from({ length }, (_, index) => 102 + index),
          }],
          adjclose: [{ adjclose: Array.from({ length }, () => 1) }],
        },
      }],
    },
  };
}

function fetcherFor(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
}

async function snapshot(): Promise<Snapshot> {
  return fetchHistory('VWRA.L', 20, fetcherFor(responseBody()), NOW);
}

test('fetches the requested public daily URL once and returns the latest 20 raw OHLC sessions', async () => {
  let calls = 0;
  const source = responseBody();
  const result = await fetchHistory('  vwra.l  ', undefined, (async (input, init) => {
    calls += 1;
    assert.equal(String(input), 'https://query1.finance.yahoo.com/v8/finance/chart/VWRA.L?range=3mo&interval=1d');
    assert.equal(new Headers(init?.headers).get('accept'), 'application/json');
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(JSON.stringify(source));
  }) as typeof fetch, NOW);
  assert.equal(calls, 1);
  assert.equal(result.version, 1);
  assert.equal(result.source, 'YAHOO');
  assert.equal(result.unofficial, true);
  assert.equal(result.interval, '1d');
  assert.equal(result.symbol, 'VWRA.L');
  assert.equal(result.currency, 'USD');
  assert.equal(result.timezone, 'Europe/London');
  assert.equal(result.fetchedAt, '2026-10-16T12:00:00.000Z');
  assert.equal(result.bars.length, 20);
  assert.deepEqual(result.bars[0], { timestamp: START + 10 * DAY, date: '2026-09-11', open: 110, high: 113, low: 109, close: 112 });
  assert.equal(result.bars.at(-1)?.close, 131);
});

test('allows every requested count from 12 through 20', async () => {
  for (let count = 12; count <= 20; count += 1) {
    const result = await fetchHistory('VWRA.L', count, fetcherFor(responseBody()), NOW);
    assert.equal(result.bars.length, count);
    assert.equal(result.bars.at(-1)?.date, '2026-09-30');
  }
});

test('rejects invalid counts and symbols before making an HTTP request', async () => {
  let calls = 0;
  const fetcher = (async () => { calls += 1; return new Response('{}'); }) as typeof fetch;
  for (const count of [0, 11, 21, 12.5, NaN, Infinity]) {
    await assert.rejects(fetchHistory('VWRA.L', count, fetcher, NOW), /integer from 12 to 20/);
  }
  for (const symbol of ['', ' ', 'ABC?token=secret', '../ABC', 'A/B', 'X'.repeat(33)]) {
    await assert.rejects(fetchHistory(symbol, 12, fetcher, NOW), /ticker characters/);
  }
  assert.equal(calls, 0);
});

test('sorts and deduplicates valid session dates, keeping the latest timestamp', async () => {
  const body = responseBody(13);
  const result = body.chart.result[0];
  result.timestamp.reverse();
  for (const values of Object.values(result.indicators.quote[0])) values.reverse();
  result.timestamp.push(START + 12 * DAY + 3_600);
  result.indicators.quote[0].open.push(150);
  result.indicators.quote[0].high.push(155);
  result.indicators.quote[0].low.push(149);
  result.indicators.quote[0].close.push(153);
  const history = await fetchHistory('VWRA.L', 12, fetcherFor(body), NOW);
  assert.equal(history.bars.length, 12);
  assert.equal(history.bars[0].date, '2026-09-02');
  assert.equal(history.bars.at(-1)?.date, '2026-09-13');
  assert.equal(history.bars.at(-1)?.close, 153);
});

test('filters null, missing, nonpositive, nonnumeric, nonfinite and inconsistent raw prices', async () => {
  const body = responseBody(26);
  const result = body.chart.result[0];
  const quote = result.indicators.quote[0] as Record<string, unknown[]>;
  quote.open[0] = null;
  quote.open[1] = undefined;
  quote.low[2] = 0;
  quote.high[3] = -1;
  quote.close[4] = '106';
  quote.open[5] = NaN;
  quote.close[6] = Infinity;
  quote.open[7] = 1_000;
  quote.close[8] = 1;
  const history = await fetchHistory('VWRA.L', 12, fetcherFor(body), NOW);
  assert.equal(history.bars.length, 12);
  assert.equal(history.bars[0].date, '2026-09-15');
  assert.ok(history.bars.every((bar) => bar.open > 0 && Number.isFinite(bar.close)));
});

test('filters invalid, future and current-session timestamps without inventing missing bars', async () => {
  const body = responseBody(21);
  const result = body.chart.result[0];
  const timestamps = result.timestamp as unknown[];
  timestamps[0] = null;
  timestamps[1] = '123';
  timestamps[2] = 0;
  timestamps[3] = -10;
  timestamps[4] = START + 0.5;
  timestamps[5] = NOW + DAY; // Milliseconds are not accepted as Unix seconds.
  timestamps[6] = NOW / 1_000 + DAY;
  timestamps[7] = Date.parse('2026-10-16T08:00:00Z') / 1_000;
  timestamps[8] = Date.parse('2026-10-15T23:30:00Z') / 1_000; // Already Oct 16 in London.
  const history = await fetchHistory('VWRA.L', 12, fetcherFor(body), NOW);
  assert.equal(history.bars.length, 12);
  assert.equal(history.bars[0].date, '2026-09-10');
  await assert.rejects(fetchHistory('VWRA.L', 13, fetcherFor(body), NOW), /12 valid completed daily sessions; 13 are required/);
});

test('uses exchange date rather than UTC to exclude an unfinished session across midnight', async () => {
  const body = responseBody(13);
  const source = body.chart.result[0];
  source.meta.exchangeTimezoneName = 'America/New_York';
  const now = Date.parse('2026-10-17T00:30:00Z'); // Oct 16, 20:30 New York.
  source.timestamp[12] = Date.parse('2026-10-16T13:30:00Z') / 1_000;
  const history = await fetchHistory('VWRA.L', 12, fetcherFor(body), now);
  assert.equal(history.bars.at(-1)?.date, '2026-09-12');
});

test('accepts DST-aware London timezone and preserves GBp minor-unit metadata', async () => {
  const body = responseBody(12);
  body.chart.result[0].meta.currency = 'GBp';
  const history = await fetchHistory('VWRA.L', 12, fetcherFor(body), NOW);
  assert.equal(history.currency, 'GBp');
  assert.equal(history.bars[0].open, 100);
});

test('requires supported typed currency, valid timezone, matching symbol and daily granularity', async () => {
  for (const currency of [undefined, null, '', 'usd', 'XYZ', 123, 'GBX']) {
    const body = responseBody();
    (body.chart.result[0].meta as Record<string, unknown>).currency = currency;
    await assert.rejects(fetchHistory('VWRA.L', 20, fetcherFor(body), NOW), /currency/);
  }
  for (const timezone of [undefined, null, '', 'invalid/zone', 123]) {
    const body = responseBody();
    (body.chart.result[0].meta as Record<string, unknown>).exchangeTimezoneName = timezone;
    await assert.rejects(fetchHistory('VWRA.L', 20, fetcherFor(body), NOW), /timezone/);
  }
  const otherSymbol = responseBody();
  otherSymbol.chart.result[0].meta.symbol = 'VWRL.L';
  await assert.rejects(fetchHistory('VWRA.L', 20, fetcherFor(otherSymbol), NOW), /different symbol/);
  const minuteBars = responseBody();
  minuteBars.chart.result[0].meta.dataGranularity = '1m';
  await assert.rejects(fetchHistory('VWRA.L', 20, fetcherFor(minuteBars), NOW), /non-daily/);
});

test('does not substitute adjusted close or silently return fewer than requested sessions', async () => {
  const body = responseBody(12);
  (body.chart.result[0].indicators.quote[0] as Record<string, unknown>).close = undefined;
  await assert.rejects(fetchHistory('VWRA.L', 12, fetcherFor(body), NOW), /raw open, high, low, and close arrays/);
  await assert.rejects(fetchHistory('VWRA.L', 12, fetcherFor(responseBody(11)), NOW), /11 valid completed daily sessions; 12 are required/);
  await assert.rejects(fetchHistory('VWRA.L', 20, fetcherFor(responseBody(19)), NOW), /19 valid completed daily sessions; 20 are required/);
});

test('HTTP, network, invalid JSON and provider errors are sanitized and never retried', async () => {
  const secret = 'DO_NOT_LEAK_CREDENTIAL_OR_RESPONSE_BODY';
  const scenarios: [typeof fetch, RegExp][] = [
    [(async () => new Response(secret, { status: 429, statusText: secret })) as typeof fetch, /HTTP 429/],
    [(async () => { throw new Error(secret); }) as typeof fetch, /request failed or timed out/],
    [(async () => new Response(secret)) as typeof fetch, /invalid JSON/],
    [fetcherFor({ chart: { error: { description: secret }, result: null } }), /no usable/],
    [fetcherFor({ chart: { error: null, result: [] } }), /no usable/],
  ];
  for (const [fetcher, message] of scenarios) {
    let calls = 0;
    const wrapped = (async (...args: Parameters<typeof fetch>) => { calls += 1; return fetcher(...args); }) as typeof fetch;
    await assert.rejects(fetchHistory('VWRA.L', 20, wrapped, NOW), (error: Error) => {
      assert.match(error.message, message);
      assert.ok(!error.message.includes(secret));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('validates a stored JSON round-trip and returns independent bars', async () => {
  const input = JSON.parse(JSON.stringify(await snapshot())) as Snapshot;
  const validated = validateSnapshot(input, NOW);
  assert.deepEqual(validated, input);
  assert.notEqual(validated, input);
  assert.notEqual(validated.bars, input.bars);
  assert.notEqual(validated.bars[0], input.bars[0]);
});

test('stored snapshots require the exact version, source, marker, interval and full schema', async () => {
  const original = await snapshot();
  for (const [key, value] of Object.entries({ version: 2, source: 'OTHER', unofficial: false, interval: '1m', symbol: 'vwra.l', currency: 'usd', timezone: 'invalid/zone' })) {
    assert.throws(() => validateSnapshot({ ...original, [key]: value }, NOW));
  }
  for (const key of Object.keys(original)) {
    const invalid = { ...original } as Record<string, unknown>;
    delete invalid[key];
    assert.throws(() => validateSnapshot(invalid, NOW));
  }
  assert.throws(() => validateSnapshot({ ...original, extra: 'not part of version 1' }, NOW), /exactly/);
  for (const bad of [null, [], 'string', 12]) assert.throws(() => validateSnapshot(bad, NOW));
});

test('stored snapshots reject missing, extra, invalid, misdated and duplicate bars', async () => {
  const original = await snapshot();
  const badBars: unknown[] = [null, { ...original.bars[0], high: 1 }, { ...original.bars[0], open: NaN },
    { ...original.bars[0], close: '12' }, { ...original.bars[0], timestamp: START * 1_000 },
    { ...original.bars[0], timestamp: 0 }, { ...original.bars[0], timestamp: START + 0.5 },
    { ...original.bars[0], date: '2026-02-30' }, { ...original.bars[0], date: '2026-09-12' },
    { ...original.bars[0], extra: true }, { timestamp: original.bars[0].timestamp }];
  for (const bar of badBars) {
    assert.throws(() => validateSnapshot({ ...original, bars: [bar, ...original.bars.slice(1)] }, NOW));
  }
  assert.throws(() => validateSnapshot({ ...original, bars: [original.bars[1], ...original.bars.slice(1)] }, NOW), /chronological/);
  assert.throws(() => validateSnapshot({ ...original, bars: [...original.bars].reverse() }, NOW), /chronological/);
  assert.throws(() => validateSnapshot({ ...original, bars: original.bars.slice(0, 11) }, NOW), /12–20/);
  assert.throws(() => validateSnapshot({ ...original, bars: [...original.bars, original.bars[19]] }, NOW), /12–20/);
});

test('stored snapshots reject current/future sessions and sessions incomplete at fetch time', async () => {
  const original = await snapshot();
  for (const [timestamp, date] of [
    [Date.parse('2026-10-16T08:00:00Z') / 1_000, '2026-10-16'],
    [Date.parse('2026-10-17T08:00:00Z') / 1_000, '2026-10-17'],
  ] as const) {
    assert.throws(() => validateSnapshot({ ...original, bars: [...original.bars.slice(0, -1), { ...original.bars[19], timestamp, date }] }, NOW));
  }
  assert.throws(() => validateSnapshot({ ...original, fetchedAt: '2026-09-30T20:00:00.000Z' }, NOW), /precede both/);
  assert.throws(() => validateSnapshot({ ...original, fetchedAt: '2026-09-29T20:00:00.000Z' }, NOW));
});

test('stored snapshots require canonical, nonfuture fetchedAt and a valid reference time', async () => {
  const original = await snapshot();
  for (const fetchedAt of ['not-a-date', '2026-10-16', '2026-10-16T12:00:00Z', '2026-10-16T13:00:00.000+01:00', '2026-10-17T12:00:00.000Z', null, 123]) {
    assert.throws(() => validateSnapshot({ ...original, fetchedAt }, NOW), /fetchedAt/);
  }
  for (const now of [NaN, Infinity, -1, 1.5]) {
    assert.throws(() => validateSnapshot(original, now), /reference time/);
    await assert.rejects(fetchHistory('VWRA.L', 20, fetcherFor(responseBody()), now), /reference time/);
  }
});

test('staleness uses fetchedAt age only, with strictly more than 24 hours as the boundary', async () => {
  const history = await snapshot();
  assert.equal(isSnapshotStale(history, NOW), false); // Last source session can be older.
  assert.equal(isSnapshotStale(history, NOW + DAY * 1_000), false);
  assert.equal(isSnapshotStale(history, NOW + DAY * 1_000 + 1), true);
  assert.throws(() => isSnapshotStale(history, NOW - 1), /future/);
});
