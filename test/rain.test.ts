import assert from 'node:assert/strict';
import test from 'node:test';
import { RainCache, RAIN_ENDPOINT, RAIN_MAX_RESPONSE_BYTES, RAIN_REFRESH_MS, RAIN_SOURCE, RAIN_STALE_AFTER_MS } from '../src/rain.ts';

const HOUR_MS = 3_600_000;
const NOW = Date.parse('2026-10-16T15:50:00.000Z'); // 23:50 Singapore.
const iso = (time: number) => new Date(time).toISOString();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function fixture(now = NOW) {
  const localDay = Math.floor((now + 8 * HOUR_MS) / (24 * HOUR_MS)) * 24 * HOUR_MS;
  return {
    latitude: 1.375, longitude: 103.875, generationtime_ms: 0.321,
    utc_offset_seconds: 28_800, timezone: 'Asia/Singapore', timezone_abbreviation: 'GMT+8', elevation: 10,
    hourly_units: { time: 'iso8601', precipitation_probability: '%' },
    hourly: {
      time: Array.from({ length: 48 }, (_, i) => iso(localDay + i * HOUR_MS).slice(0, 16)),
      precipitation_probability: Array.from({ length: 48 }, (_, i): number | null => i),
    },
  };
}
const goodFetcher = (async () => json(fixture())) as typeof fetch;
function makeCache(fetcher = goodFetcher, clock = () => NOW) {
  return new RainCache({}, { fetcher, clock });
}

test('uses exactly the public Yishun endpoint, no key, and safe request options', async () => {
  let calls = 0;
  const cache = makeCache((async (input, init) => {
    calls++;
    assert.equal(String(input), RAIN_ENDPOINT);
    assert.equal(new Headers(init?.headers).get('Accept'), 'application/json');
    assert.equal(new Headers(init?.headers).has('x-api-key'), false);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    return json(fixture());
  }) as typeof fetch);
  await cache.refresh();
  assert.equal(calls, 1);
  assert.deepEqual(cache.view(), {
    source: 'Open-Meteo.com', timezone: 'Asia/Singapore', location: 'Yishun',
    probability: 24, validFrom: '2026-10-16T15:00:00.000Z', validTo: '2026-10-16T16:00:00.000Z',
    fetchedAt: iso(NOW), stale: false, status: 'OK', error: null,
  });
  assert.equal(RAIN_SOURCE.spatialResolutionKm, 27);
  assert.match(RAIN_SOURCE.definition, /0\.1 mm/);
  assert.equal('issuedAt' in cache.view(), false);
});

test('preceding-hour source timestamp handles midnight, exact boundaries and UTC day changes', async () => {
  const cache = makeCache(); await cache.refresh();
  assert.equal(cache.view(Date.parse('2026-10-16T15:59:59.999Z')).probability, 24);
  const midnight = cache.view(Date.parse('2026-10-16T16:00:00.000Z'));
  assert.equal(midnight.probability, 25);
  assert.equal(midnight.validFrom, '2026-10-16T16:00:00.000Z');
  assert.equal(midnight.validTo, '2026-10-16T17:00:00.000Z');
  const utcMidnight = cache.view(Date.parse('2026-10-17T00:00:00.000Z'));
  assert.equal(utcMidnight.probability, 33);
  assert.equal(utcMidnight.validFrom, '2026-10-17T00:00:00.000Z');
  assert.equal(utcMidnight.validTo, '2026-10-17T01:00:00.000Z');
});

test('retained series advances locally to the actual next-hour value without fetching or relabelling an old value', async () => {
  let now = NOW; let calls = 0;
  const cache = makeCache((async () => { calls++; return json(fixture()); }) as typeof fetch, () => now);
  await cache.refresh();
  now += 10 * 60_000;
  await cache.refresh();
  assert.equal(calls, 1);
  assert.equal(cache.view().probability, 25);
  assert.equal(cache.view().status, 'OK');
  assert.equal(cache.view().fetchedAt, iso(NOW));
  assert.equal(cache.view().validFrom, iso(now));
});

test('valid zero, 100 and decimal percentages remain distinct from unavailable data', async () => {
  for (const probability of [0, 100, 42.5, null]) {
    const body = fixture(); body.hourly.precipitation_probability[24] = probability;
    const cache = makeCache((async () => json(body)) as typeof fetch); await cache.refresh();
    assert.equal(cache.view().probability, probability);
    assert.equal(cache.view().status, probability === null ? 'NO DATA' : 'OK');
    assert.equal(cache.view().stale, probability === null);
    assert.equal(cache.view().validTo, '2026-10-16T16:00:00.000Z');
  }
});

test('missing current slot is NO DATA; expired cached slots are never reused as the current hour', async () => {
  for (const removeCurrentOnly of [true, false]) {
    const body = fixture();
    body.hourly.time.splice(24, removeCurrentOnly ? 1 : 24);
    body.hourly.precipitation_probability.splice(24, removeCurrentOnly ? 1 : 24);
    const cache = makeCache((async () => json(body)) as typeof fetch); await cache.refresh();
    assert.equal(cache.view().probability, null);
    assert.equal(cache.view().status, 'NO DATA');
    assert.equal(cache.view().validFrom, null); assert.equal(cache.view().validTo, null);
    assert.equal(cache.view().fetchedAt, iso(NOW));
  }
});

test('a successful null or missing current value replaces prior data without a fake-zero or last-value fallback', async () => {
  for (const missing of [false, true]) {
    let now = NOW; let calls = 0;
    const cache = makeCache((async () => {
      const body = fixture();
      if (++calls > 1) {
        if (missing) { body.hourly.time.splice(25, 1); body.hourly.precipitation_probability.splice(25, 1); }
        else body.hourly.precipitation_probability[25] = null;
      }
      return json(body);
    }) as typeof fetch, () => now);
    await cache.refresh(); assert.equal(cache.view().probability, 24);
    now += RAIN_REFRESH_MS; await cache.refresh();
    assert.equal(cache.view().probability, null); assert.equal(cache.view().status, 'NO DATA');
    assert.equal(cache.view().fetchedAt, iso(now));
  }
});

test('all required units, timezone, offset and array schemas fail closed', async () => {
  const changes: Array<(body: any) => void> = [
    body => { body.hourly_units.precipitation_probability = 'fraction'; },
    body => { body.hourly_units.time = 'unixtime'; },
    body => { delete body.hourly_units; },
    body => { body.timezone = 'GMT'; },
    body => { body.utc_offset_seconds = 0; },
    body => { body.utc_offset_seconds = '28800'; },
    body => { body.hourly.time = []; body.hourly.precipitation_probability = []; },
    body => { body.hourly.time = Array(73).fill('2026-10-16T00:00'); body.hourly.precipitation_probability = Array(73).fill(10); },
    body => { body.hourly.precipitation_probability.pop(); },
    body => { body.hourly.precipitation_probability = {}; },
    body => { delete body.hourly.time; },
    body => { body.error = true; },
  ];
  for (const change of changes) {
    const body = fixture(); change(body);
    const cache = makeCache((async () => json(body)) as typeof fetch); await cache.refresh();
    assert.equal(cache.view().status, 'NO DATA'); assert.equal(cache.view().probability, null);
    assert.equal(cache.view().fetchedAt, null); assert.ok(cache.view().error);
  }
});

test('out-of-range, string, Boolean and absent probabilities invalidate the entire series', async () => {
  for (const value of [-0.1, 100.1, '42', false, {}, undefined]) {
    const body: any = fixture(); body.hourly.precipitation_probability[24] = value;
    // JSON converts undefined array elements to null. Encode other absent-value
    // failures by mismatching the arrays instead, as real JSON cannot contain it.
    if (value === undefined) body.hourly.precipitation_probability.pop();
    const cache = makeCache((async () => json(body)) as typeof fetch); await cache.refresh();
    assert.equal(cache.view().status, 'NO DATA'); assert.equal(cache.view().probability, null);
    assert.equal(cache.view().fetchedAt, null);
  }
});

test('returned grid coordinates must be finite and near the requested Yishun point', async () => {
  for (const [field, replacement] of [
    ['latitude', null], ['longitude', '103.875'], ['latitude', 2], ['longitude', 104.5],
    ['latitude', undefined], ['longitude', undefined],
  ] as const) {
    const body: any = fixture(); body[field] = replacement;
    const cache = makeCache((async () => json(body)) as typeof fetch); await cache.refresh();
    assert.equal(cache.view().status, 'NO DATA'); assert.equal(cache.view().fetchedAt, null);
  }
  for (const field of ['latitude', 'longitude', 'precipitation_probability']) {
    const body = JSON.stringify(fixture()).replace(
      field === 'precipitation_probability' ? /("precipitation_probability":\[)0/ : new RegExp(`("${field}":)-?[0-9.]+`),
      '$11e999',
    );
    const cache = makeCache((async () => new Response(body)) as typeof fetch); await cache.refresh();
    assert.equal(cache.view().status, 'NO DATA'); assert.equal(cache.view().fetchedAt, null);
  }
  for (const delta of [-0.5, 0.5]) {
    const body = fixture(); body.latitude = RAIN_SOURCE.latitude + delta; body.longitude = RAIN_SOURCE.longitude + delta;
    const cache = makeCache((async () => json(body)) as typeof fetch); await cache.refresh();
    assert.equal(cache.view().status, 'OK');
  }
});

test('invalid dates, offsets, non-hour boundaries, duplicate and descending source times fail closed', async () => {
  for (const replacement of [
    '2026-02-30T00:00', '2026-13-17T00:00', '2026-10-00T00:00', '2026-10-17T24:00',
    '2026-10-17T00:30', '2026-10-17T00:00Z', '2026-10-17T00:00+08:00', '2026-10-17T00:00:00',
    '2026-10-16T23:00', '2026-10-16T22:00', 'not a date', 1_792_166_400, null,
  ]) {
    const body: any = fixture(); body.hourly.time[24] = replacement;
    const cache = makeCache((async () => json(body)) as typeof fetch); await cache.refresh();
    assert.equal(cache.view().status, 'NO DATA'); assert.equal(cache.view().fetchedAt, null);
  }
});

test('a malformed non-current slot cannot hide inside an otherwise usable current forecast', async () => {
  const body = fixture(); body.hourly.precipitation_probability[47] = 101;
  const cache = makeCache((async () => json(body)) as typeof fetch); await cache.refresh();
  assert.equal(cache.view().probability, null); assert.equal(cache.view().status, 'NO DATA');
});

test('retrieval freshness becomes STALE at 30 minutes, independent of future valid forecast slots', async () => {
  const cache = makeCache(); await cache.refresh();
  assert.equal(cache.view(NOW + RAIN_STALE_AFTER_MS - 1).status, 'OK');
  assert.equal(cache.view(NOW + RAIN_STALE_AFTER_MS).status, 'STALE');
  assert.equal(cache.view(NOW + RAIN_STALE_AFTER_MS).probability, 25);
  assert.equal(cache.view(NOW + RAIN_STALE_AFTER_MS).fetchedAt, iso(NOW));
  assert.equal(cache.view(NOW - 1).status, 'STALE');
});

test('failed refresh retains only dated matching slots, marks them stale and preserves fetchedAt', async () => {
  let now = NOW; let fail = false;
  const cache = makeCache((async () => {
    if (fail) throw new Error('https://private.example/?token=secret');
    return json(fixture());
  }) as typeof fetch, () => now);
  await cache.refresh();
  fail = true; now += RAIN_REFRESH_MS; await cache.refresh();
  assert.equal(cache.view().probability, 25);
  assert.equal(cache.view().validFrom, '2026-10-16T16:00:00.000Z');
  assert.equal(cache.view().status, 'STALE'); assert.equal(cache.view().fetchedAt, iso(NOW));
  assert.ok(cache.view().error); assert.doesNotMatch(JSON.stringify(cache.view()), /secret|private/);
  now = Date.parse('2026-10-17T16:00:00.000Z');
  assert.equal(cache.view().probability, null); assert.equal(cache.view().status, 'NO DATA');
  assert.equal(cache.view().validFrom, null); assert.equal(cache.view().validTo, null);
});

test('malformed refresh cannot overwrite last-good data or its retrieval timestamp; later good data recovers', async () => {
  let now = NOW; let fail = false;
  const cache = makeCache((async () => {
    const body = fixture(); if (fail) body.hourly_units.precipitation_probability = 'mm';
    return json(body);
  }) as typeof fetch, () => now);
  await cache.refresh();
  now += RAIN_REFRESH_MS; fail = true; await cache.refresh();
  assert.equal(cache.view().status, 'STALE'); assert.equal(cache.view().fetchedAt, iso(NOW));
  now += RAIN_REFRESH_MS; fail = false; await cache.refresh();
  assert.equal(cache.view().status, 'OK'); assert.equal(cache.view().error, null);
  assert.equal(cache.view().fetchedAt, iso(now));
});

test('concurrent refresh callers share one in-flight request and obey the 15-minute cache', async () => {
  let now = NOW; let calls = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const cache = makeCache((async () => { calls++; await gate; return json(fixture()); }) as typeof fetch, () => now);
  const first = cache.refresh(); const second = cache.refresh();
  assert.equal(first, second); assert.equal(calls, 1);
  release(); await Promise.all([first, second]);
  now += RAIN_REFRESH_MS - 1; await cache.refresh(); assert.equal(calls, 1);
  now += 1; await cache.refresh(); assert.equal(calls, 2);
});

test('failed and HTTP 429 requests still back off for 15 minutes', async () => {
  for (const http of [false, true]) {
    let now = NOW; let calls = 0;
    const cache = makeCache((async () => {
      calls++; if (http) return json({ error: true }, 429);
      throw new Error('network failure');
    }) as typeof fetch, () => now);
    await cache.refresh();
    now += RAIN_REFRESH_MS - 1; await cache.refresh(); assert.equal(calls, 1);
    now += 1; await cache.refresh(); assert.equal(calls, 2);
    assert.equal(cache.view().status, 'NO DATA');
  }
});

test('timeouts cover unresolved fetch and stalled body; arbitrary upstream errors and malformed JSON stay private', async () => {
  for (const fetcher of [
    (async () => new Promise<Response>(() => {})) as typeof fetch,
    (async () => new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } }))) as typeof fetch,
    (async () => { throw new Error('secret provider diagnostic https://example.test/?key=private'); }) as typeof fetch,
    (async () => new Response('{invalid json')) as typeof fetch,
    (async () => new Response(new Uint8Array([0xff, 0xfe]))) as typeof fetch,
    (async () => new Response(null, { status: 204 })) as typeof fetch,
  ]) {
    const cache = new RainCache({ requestTimeoutMs: 10 }, { fetcher, clock: () => NOW });
    await cache.refresh(); assert.equal(cache.view().status, 'NO DATA');
    assert.doesNotMatch(JSON.stringify(cache.view()), /private|secret/);
  }
});

test('declared and streamed responses over 1 MiB are cancelled before parsing', async () => {
  for (const declared of [false, true]) {
    let cancelled = 0;
    const fetcher = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(RAIN_MAX_RESPONSE_BYTES + 1)); },
      cancel() { cancelled++; },
    }), { headers: declared ? { 'Content-Length': String(RAIN_MAX_RESPONSE_BYTES + 1) } : {} })) as typeof fetch;
    const cache = makeCache(fetcher); await cache.refresh();
    assert.equal(cache.view().status, 'NO DATA'); assert.equal(cancelled, 1);
  }
});

test('a response exactly at 1 MiB is permitted and streaming counts bytes across chunks', async () => {
  const base = JSON.stringify(fixture());
  const exact = base + ' '.repeat(RAIN_MAX_RESPONSE_BYTES - Buffer.byteLength(base));
  const cache = makeCache((async () => new Response(exact)) as typeof fetch);
  await cache.refresh(); assert.equal(cache.view().status, 'OK');
  let cancelled = 0;
  const oversized = makeCache((async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(exact));
      controller.enqueue(new Uint8Array([32]));
    }, cancel() { cancelled++; },
  }))) as typeof fetch);
  await oversized.refresh(); assert.equal(oversized.view().status, 'NO DATA'); assert.equal(cancelled, 1);
});

test('start is idempotent and stop aborts active requests without publishing late data or polling again', async () => {
  let calls = 0; let aborted = 0; let release!: () => void;
  const cache = makeCache((async (_input, init) => {
    calls++; init?.signal?.addEventListener('abort', () => { aborted++; });
    await new Promise<void>(resolve => { release = resolve; }); return json(fixture());
  }) as typeof fetch);
  cache.start(); cache.start(); assert.equal(calls, 1); cache.stop();
  release(); await cache.refresh();
  assert.equal(aborted, 1); assert.equal(cache.view().status, 'NO DATA');
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(calls, 1);
});

test('new instances start empty and snapshot views cannot mutate retained data', async () => {
  const cache = makeCache(); await cache.refresh();
  assert.ok(Object.isFrozen(cache.view()));
  assert.throws(() => { (cache.view() as any).probability = 0; }, TypeError);
  assert.equal(cache.view().probability, 24);
  assert.deepEqual(makeCache().view(), {
    source: 'Open-Meteo.com', timezone: 'Asia/Singapore', location: 'Yishun', probability: null,
    validFrom: null, validTo: null, fetchedAt: null, stale: true, status: 'NO DATA', error: null,
  });
});

test('configuration and reference times reject invalid values before making requests', () => {
  for (const requestTimeoutMs of [0, -1, 30_001, NaN, Infinity, 1.5]) assert.throws(() => new RainCache({ requestTimeoutMs }));
  for (const now of [NaN, Infinity, NOW + 0.5, Date.UTC(1999, 0, 1)]) {
    assert.throws(() => makeCache().view(now), /reference time/);
    assert.throws(() => makeCache(goodFetcher, () => now).refresh(), /reference time/);
  }
});
