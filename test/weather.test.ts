import assert from 'node:assert/strict';
import test from 'node:test';
import { WeatherCache, weatherText, WEATHER_ENDPOINTS, WEATHER_FIELDS, WEATHER_MAX_RESPONSE_BYTES, WEATHER_REFRESH_MS } from '../src/weather.ts';

const NOW = Date.parse('2026-10-16T13:30:00.000Z');
const iso = (time: number) => new Date(time).toISOString();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function forecast(now = NOW) {
  const start = Math.floor(now / 3_600_000) * 3_600_000;
  return { code: 0, errorMsg: '', data: {
    area_metadata: [{ name: 'Yishun', label_location: { latitude: 1.418, longitude: 103.839 } }],
    items: [{ timestamp: iso(start), update_timestamp: iso(start + 60_000),
      valid_period: { start: iso(start), end: iso(start + 2 * 3_600_000), text: '9.00 pm to 11.00 pm' },
      forecasts: [{ area: 'Sembawang', forecast: 'Showers' }, { area: 'Yishun', forecast: 'Cloudy' }] }],
  } };
}
function observation(kind: 'temperature' | 'humidity', now = NOW) {
  return { code: 0, errorMsg: '', data: {
    stations: [
      { id: 'S104', deviceId: 'S104', name: 'Woodlands Avenue 9', location: { latitude: 1.4439, longitude: 103.7854 } },
      { id: 'S80', deviceId: 'S80', name: 'Sembawang Meteorological Station', location: { latitude: 1.4247, longitude: 103.8201 } },
    ],
    readings: [{ timestamp: iso(now - (kind === 'temperature' ? 120_000 : 180_000)),
      data: [{ stationId: 'S104', value: 1 }, { stationId: 'S80', value: kind === 'temperature' ? 28.9 : 91.3 }] }],
    readingType: kind === 'temperature' ? 'DBT 1M F' : 'RH 1M F',
    readingUnit: kind === 'temperature' ? 'deg C' : 'percentage',
  } };
}
function fixture(url: string, now = NOW): unknown {
  if (url === WEATHER_ENDPOINTS.forecast) return forecast(now);
  if (url === WEATHER_ENDPOINTS.temperature) return observation('temperature', now);
  if (url === WEATHER_ENDPOINTS.humidity) return observation('humidity', now);
  throw new Error('Unexpected URL.');
}
const goodFetcher = (async input => json(fixture(String(input)))) as typeof fetch;
function makeCache(fetcher = goodFetcher, clock = () => NOW) {
  return new WeatherCache({}, { fetcher, clock });
}

test('NEA cache uses only three verified public endpoints without keys, with safe request options', async () => {
  const calls: string[] = [];
  const cache = makeCache((async (input, init) => {
    const url = String(input); calls.push(url);
    assert.equal(new Headers(init?.headers).get('Accept'), 'application/json');
    assert.equal(new Headers(init?.headers).has('x-api-key'), false);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    return json(fixture(url));
  }) as typeof fetch);
  await cache.refresh();
  assert.deepEqual(new Set(calls), new Set(Object.values(WEATHER_ENDPOINTS)));
  assert.equal(cache.view().status, 'OK');
  assert.equal(cache.view().area, 'Yishun');
  assert.equal(cache.view().stationFullName, 'Sembawang Meteorological Station');
  assert.equal(cache.view().source, 'NEA');
});

test('source issue, update, validity, temperature, humidity and retrieval timestamps remain separate', async () => {
  const cache = makeCache(); await cache.refresh();
  const view = cache.view();
  assert.deepEqual(view.forecast, {
    text: 'Cloudy', issuedAt: '2026-10-16T13:00:00.000Z', updatedAt: '2026-10-16T13:01:00.000Z',
    validFrom: '2026-10-16T13:00:00.000Z', validTo: '2026-10-16T15:00:00.000Z', retrievedAt: iso(NOW),
  });
  assert.deepEqual(view.observation, {
    temperatureC: 28.9, relativeHumidity: 91.3, temperatureObservedAt: iso(NOW - 120_000),
    humidityObservedAt: iso(NOW - 180_000), observedAt: iso(NOW - 180_000), retrievedAt: iso(NOW),
  });
  assert.notEqual(view.observation?.temperatureObservedAt, view.observation?.humidityObservedAt);
  assert.notEqual(view.observation?.observedAt, view.observation?.retrievedAt);
});

test('weather field allowlist gives ASCII SGT native rows and never traverses arbitrary fields', async () => {
  const cache = makeCache(); await cache.refresh();
  assert.deepEqual(WEATHER_FIELDS.map(field => weatherText(cache.view(), field)), [
    'YISHUN', 'CLOUDY', '28.9C RH 91.3%', 'S80 SEMBAWANG', '21:00-23:00 SGT',
    'FC 16 21:00 SGT', 'OBS 16 21:27 SGT', 'NEA',
    'YISHUN 2H', '28.9C 91% RH', '16 21:27 SGT', '--% -- SGT', 'Open-Meteo.com', 'NEA OK OM --',
    'CLOUDY', '28.9', '91%', 'Semb.16 21:27', '...', 'N/A', '%',
  ]);
  for (const field of ['__proto__', 'constructor', 'toString', 'observation.temperatureC', '', 'STATUS']) {
    assert.throws(() => weatherText(cache.view(), field), /Unsupported/);
  }
  for (const field of WEATHER_FIELDS) assert.match(weatherText(cache.view(), field), /^[\x20-\x7e]+$/);
});

test('NO DATA is explicit and never substitutes numbers, source timestamps, or another station', async () => {
  const cache = makeCache((async () => json({ code: 404, errorMsg: 'missing', data: null })) as typeof fetch);
  assert.equal(cache.view().status, 'NO DATA');
  await cache.refresh();
  const view = cache.view();
  assert.equal(view.forecast, null); assert.equal(view.observation, null); assert.equal(view.stale, true);
  assert.equal(weatherText(view, 'forecast'), 'NO FORECAST');
  assert.equal(weatherText(view, 'conditions'), 'NO OBS DATA');
  assert.equal(weatherText(view, 'issued'), 'FC -- SGT');
  assert.equal(weatherText(view, 'observed'), 'OBS -- SGT');
  assert.equal(weatherText(view, 'status'), 'NEA NO DATA');
});

test('shared five-minute TTL deduplicates concurrent callers and cannot be bypassed by repeated polling', async () => {
  let now = NOW; let calls = 0;
  const cache = makeCache((async input => { calls++; return json(fixture(String(input), now)); }) as typeof fetch, () => now);
  await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);
  assert.equal(calls, 3);
  await cache.refresh(); now += WEATHER_REFRESH_MS - 1; await cache.refresh();
  assert.equal(calls, 3);
  now += 1; await cache.refresh(); assert.equal(calls, 6);
});

test('HTTP 429 failures also wait five minutes and preserve independently dated last-good values', async () => {
  let now = NOW; let broken = false; let calls = 0;
  const cache = makeCache((async input => { calls++; return broken ? json({ errorMsg: 'secret upstream body' }, 429) : json(fixture(String(input), now)); }) as typeof fetch, () => now);
  await cache.refresh(); const before = cache.view();
  now += WEATHER_REFRESH_MS; broken = true; await cache.refresh();
  const after = cache.view();
  assert.equal(after.status, 'STALE'); assert.equal(after.delayed, false);
  assert.deepEqual(after.forecast, before.forecast); assert.deepEqual(after.observation, before.observation);
  await cache.refresh(); assert.equal(calls, 6);
  assert.equal(JSON.stringify(after).includes('secret upstream body'), false);
  now += WEATHER_REFRESH_MS; broken = false; await cache.refresh();
  assert.equal(calls, 9); assert.equal(cache.view().status, 'OK'); assert.equal(cache.view().error, null);
});

test('forecast and observation failures do not discard the other successfully refreshed component', async () => {
  let now = NOW; let broken: 'forecast' | 'humidity' | null = null;
  const cache = makeCache((async input => {
    const url = String(input);
    return broken && url === WEATHER_ENDPOINTS[broken] ? json({}, 503) : json(fixture(url, now));
  }) as typeof fetch, () => now);
  await cache.refresh();
  now += WEATHER_REFRESH_MS; broken = 'forecast'; await cache.refresh();
  assert.equal(cache.view().forecast?.retrievedAt, iso(NOW));
  assert.equal(cache.view().observation?.retrievedAt, iso(now));
  now += WEATHER_REFRESH_MS; broken = 'humidity'; await cache.refresh();
  assert.equal(cache.view().forecast?.retrievedAt, iso(now));
  assert.equal(cache.view().observation?.retrievedAt, iso(NOW + WEATHER_REFRESH_MS));
  assert.equal(cache.view().status, 'STALE');
});

test('successful fresh fetch cannot hide hours-old humidity; mark source delay separately from request errors', async () => {
  const cache = makeCache((async input => {
    const url = String(input);
    if (url !== WEATHER_ENDPOINTS.humidity) return json(fixture(url));
    const body = observation('humidity'); body.data.readings[0].timestamp = '2026-10-16T17:53:00+08:00';
    return json(body);
  }) as typeof fetch);
  await cache.refresh();
  const view = cache.view();
  assert.equal(view.error, null); assert.equal(view.observation?.retrievedAt, iso(NOW));
  assert.equal(view.observation?.humidityObservedAt, '2026-10-16T09:53:00.000Z');
  assert.equal(view.temperatureDelayed, false); assert.equal(view.humidityDelayed, true);
  assert.equal(view.delayed, true); assert.equal(view.stale, true); assert.equal(view.status, 'STALE');
  assert.equal(weatherText(view, 'status'), 'NEA RH STALE');
  assert.equal(weatherText(view, 'observed'), 'OBS 16 17:53 SGT');
});

test('successful fetches with old temperature or both old measurements identify the delayed component', async () => {
  for (const both of [false, true]) {
    const cache = makeCache((async input => {
      const url = String(input);
      if (url === WEATHER_ENDPOINTS.forecast) return json(forecast());
      const kind = url === WEATHER_ENDPOINTS.temperature ? 'temperature' : 'humidity';
      return json(observation(kind, kind === 'temperature' || both ? NOW - 3_600_000 : NOW));
    }) as typeof fetch);
    await cache.refresh();
    assert.equal(weatherText(cache.view(), 'status'), both ? 'NEA T/RH STALE' : 'NEA T STALE');
  }
});

test('expired forecast is stale even when source observations and HTTP retrieval are current', async () => {
  const cache = makeCache((async input => json(String(input) === WEATHER_ENDPOINTS.forecast ? forecast(NOW - 3 * 3_600_000) : fixture(String(input)))) as typeof fetch);
  await cache.refresh();
  assert.equal(cache.view().forecastStale, true); assert.equal(cache.view().observationStale, false);
  assert.equal(cache.view().delayed, false); assert.equal(cache.view().status, 'STALE');
  assert.equal(weatherText(cache.view(), 'status'), 'NEA STALE');
});

test('missed refresh deadline marks last-good snapshots stale without changing their source time', async () => {
  let now = NOW; const cache = makeCache(goodFetcher, () => now); await cache.refresh();
  const sourceTime = cache.view().observation?.observedAt;
  now += 600_000 - 1; assert.equal(cache.view().stale, false);
  now += 1; assert.equal(cache.view().stale, true); assert.equal(cache.view().delayed, false);
  assert.equal(cache.view().observation?.observedAt, sourceTime);
});

test('S80 validation rejects missing, duplicated, renamed, relocated or mismatched stations and wrong units', async () => {
  const changes: Array<(body: ReturnType<typeof observation>) => void> = [
    body => { body.data.stations = body.data.stations.filter(station => station.id !== 'S80'); },
    body => { body.data.stations.push({ ...body.data.stations[1] }); },
    body => { body.data.stations[1].deviceId = 'S104'; },
    body => { body.data.stations[1].name = 'Yishun'; },
    body => { body.data.stations[1].location.latitude = 1.3; },
    body => { body.data.readings[0].data = [{ stationId: 'S104', value: 28 }]; },
    body => { body.data.readings[0].data.push({ stationId: 'S80', value: 28 }); },
    body => { body.data.readingType = 'RH 1M F'; },
    body => { body.data.readingUnit = 'Fahrenheit'; },
  ];
  for (const change of changes) {
    const body = observation('temperature'); change(body);
    const cache = makeCache((async input => json(String(input) === WEATHER_ENDPOINTS.temperature ? body : fixture(String(input)))) as typeof fetch);
    await cache.refresh(); assert.equal(cache.view().observation, null); assert.equal(cache.view().forecast?.text, 'Cloudy');
  }
});

test('bad values, future times, naive local times, impossible dates and malformed observations fail closed', async () => {
  for (const [kind, replacement] of [
    ['temperature', { value: 99 }], ['temperature', { value: '28' }],
    ['humidity', { value: -1 }], ['humidity', { value: 101 }],
    ['humidity', { value: null }], ['humidity', { timestamp: iso(NOW + 1) }],
    ['humidity', { timestamp: '2026-10-16T13:25:00' }], ['humidity', { timestamp: '2026-02-30T13:25:00Z' }],
  ] as const) {
    const body = observation(kind);
    if ('timestamp' in replacement) body.data.readings[0].timestamp = replacement.timestamp;
    else (body.data.readings[0].data[1] as { value: unknown }).value = replacement.value;
    const cache = makeCache((async input => json(String(input) === WEATHER_ENDPOINTS[kind] ? body : fixture(String(input)))) as typeof fetch);
    await cache.refresh(); assert.equal(cache.view().observation, null);
  }
});

test('forecast requires exact Yishun area and valid source issue/update/validity timestamps', async () => {
  const changes: Array<(body: ReturnType<typeof forecast>) => void> = [
    body => { body.data.area_metadata[0].name = 'Sembawang'; },
    body => { body.data.items[0].forecasts[1].area = 'Yishun South'; },
    body => { body.data.items[0].forecasts.push({ area: 'Yishun', forecast: 'Showers' }); },
    body => { body.data.items[0].forecasts[1].forecast = ''; },
    body => { body.data.items[0].forecasts[1].forecast = '<script>bad()</script>'; },
    body => { body.data.items[0].timestamp = iso(NOW + 1); },
    body => { body.data.items[0].update_timestamp = 'not a date'; },
    body => { body.data.items[0].valid_period.end = body.data.items[0].valid_period.start; },
    body => { body.data.items[0].valid_period.end = iso(NOW + 20 * 3_600_000); },
  ];
  for (const change of changes) {
    const body = forecast(); change(body);
    const cache = makeCache((async input => json(String(input) === WEATHER_ENDPOINTS.forecast ? body : fixture(String(input)))) as typeof fetch);
    await cache.refresh(); assert.equal(cache.view().forecast, null); assert.ok(cache.view().observation);
  }
});

test('timezone conversion handles Singapore midnight without confusing UTC day or forecast validity dates', async () => {
  const now = Date.parse('2026-10-16T17:30:00.000Z');
  const cache = makeCache((async input => json(fixture(String(input), now))) as typeof fetch, () => now);
  await cache.refresh();
  assert.equal(weatherText(cache.view(), 'issued'), 'FC 17 01:00 SGT');
  assert.equal(weatherText(cache.view(), 'observed'), 'OBS 17 01:27 SGT');
  assert.equal(weatherText(cache.view(), 'valid'), '01:00-03:00 SGT');
});

test('source timestamp regression does not overwrite a newer last-good snapshot', async () => {
  let now = NOW; let old = false;
  const cache = makeCache((async input => json(fixture(String(input), old ? NOW - 3_600_000 : now))) as typeof fetch, () => now);
  await cache.refresh(); const before = cache.view();
  now += WEATHER_REFRESH_MS; old = true; await cache.refresh();
  assert.deepEqual(cache.view().forecast, before.forecast); assert.deepEqual(cache.view().observation, before.observation);
  assert.equal(cache.view().status, 'STALE');
});

test('a forecast revision can retain an earlier validity-window start, as verified in live NEA data', async () => {
  const now = Date.parse('2026-10-16T13:52:00.000Z');
  const body = forecast(now);
  body.data.items[0].timestamp = '2026-10-16T21:29:00+08:00';
  body.data.items[0].update_timestamp = '2026-10-16T21:36:36+08:00';
  const cache = makeCache((async input => json(String(input) === WEATHER_ENDPOINTS.forecast ? body : fixture(String(input), now))) as typeof fetch, () => now);
  await cache.refresh();
  assert.equal(cache.view().status, 'OK');
  assert.equal(cache.view().forecast?.issuedAt, '2026-10-16T13:29:00.000Z');
  assert.equal(cache.view().forecast?.validFrom, '2026-10-16T13:00:00.000Z');
  assert.equal(weatherText(cache.view(), 'issued'), 'FC 16 21:29 SGT');
  assert.equal(weatherText(cache.view(), 'valid'), '21:00-23:00 SGT');
});

test('newest readings and issue are selected by source time rather than response array order', async () => {
  const cache = makeCache((async input => {
    const url = String(input);
    if (url === WEATHER_ENDPOINTS.forecast) {
      const body = forecast(); body.data.items.unshift(forecast(NOW - 3_600_000).data.items[0]); return json(body);
    }
    const kind = url === WEATHER_ENDPOINTS.temperature ? 'temperature' : 'humidity';
    const body = observation(kind); body.data.readings.unshift(observation(kind, NOW - 300_000).data.readings[0]); return json(body);
  }) as typeof fetch);
  await cache.refresh(); assert.equal(cache.view().forecast?.issuedAt, '2026-10-16T13:00:00.000Z');
  assert.equal(cache.view().observation?.temperatureObservedAt, iso(NOW - 120_000));
});

test('snapshot views are defensive copies, including separately dated nested components', async () => {
  const cache = makeCache(); await cache.refresh();
  const view = cache.view(); view.forecast!.text = 'Changed'; view.observation!.temperatureC = 0;
  assert.equal(cache.view().forecast?.text, 'Cloudy'); assert.equal(cache.view().observation?.temperatureC, 28.9);
});

test('timeouts cover both unresolved fetch and stalled response streams; arbitrary upstream errors stay private', async () => {
  for (const fetcher of [
    (async () => new Promise<Response>(() => {})) as typeof fetch,
    (async () => new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } }))) as typeof fetch,
    (async () => { throw new Error('secret provider diagnostic https://example.test/?key=private'); }) as typeof fetch,
    (async () => new Response('{invalid json')) as typeof fetch,
  ]) {
    const cache = new WeatherCache({ requestTimeoutMs: 10 }, { fetcher, clock: () => NOW });
    await cache.refresh(); assert.equal(cache.view().status, 'NO DATA');
    assert.equal(JSON.stringify(cache.view()).includes('private'), false);
    assert.equal(JSON.stringify(cache.view()).includes('secret'), false);
  }
});

test('declared and streamed oversized responses are cancelled before parsing', async () => {
  for (const declared of [false, true]) {
    let cancelled = 0;
    const fetcher = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(WEATHER_MAX_RESPONSE_BYTES + 1)); },
      cancel() { cancelled++; },
    }), { headers: declared ? { 'Content-Length': String(WEATHER_MAX_RESPONSE_BYTES + 1) } : {} })) as typeof fetch;
    const cache = makeCache(fetcher); await cache.refresh();
    assert.equal(cache.view().status, 'NO DATA'); assert.equal(cancelled, 3);
  }
});

test('start is idempotent; stop aborts outstanding work and prevents late data or extra polls', async () => {
  let calls = 0; let aborted = 0;
  const releases: Array<() => void> = [];
  const cache = makeCache((async (input, init) => {
    calls++; init?.signal?.addEventListener('abort', () => { aborted++; });
    await new Promise<void>(resolve => releases.push(resolve)); return json(fixture(String(input)));
  }) as typeof fetch);
  cache.start(); cache.start(); assert.equal(calls, 3); cache.stop();
  for (const release of releases) release();
  await cache.refresh();
  assert.equal(aborted, 3); assert.equal(cache.view().status, 'NO DATA');
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(calls, 3);
});

test('configuration rejects unbounded timeouts and thresholds before any requests', () => {
  for (const requestTimeoutMs of [0, -1, 30_001, NaN, 1.5]) assert.throws(() => new WeatherCache({ requestTimeoutMs }));
  for (const observationDelaySeconds of [299, 3_601, NaN]) assert.throws(() => new WeatherCache({ observationDelaySeconds }));
  for (const staleAfterSeconds of [299, 3_601, NaN]) assert.throws(() => new WeatherCache({ staleAfterSeconds }));
});
