import assert from 'node:assert/strict';
import test from 'node:test';
import { createProvider, fetchHistory, isHistorySupported, MarketCache, MAX_TICKERS, normalizeTickers, parseTickers } from '../src/market.ts';
import type { MarketConfig, MarketProvider, Quote, Snapshot } from '../src/market.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const SECRET = 'server-only-secret-must-never-appear';
const config = (tickers = ['AAPL', 'VWRA.L']): MarketConfig => ({ tickers, apiKey: SECRET });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const profile = (symbol = 'AAPL') => ({ ticker: symbol, currency: 'USD', exchange: 'NASDAQ NMS - GLOBAL MARKET' });
const currentQuote = () => ({ c: 123.45, dp: 1.2, t: NOW / 1_000 - 15 });
function yahoo(symbol = 'VWRA.L', currency = 'USD', instrumentType = 'ETF') {
  const london = symbol.endsWith('.L') || symbol === 'JPY=X';
  const longName = symbol === 'VALU.L' ? 'Vanguard Funds PLC - Vanguard FTSE Global All-Cap UCITS ETF USD Acc'
    : symbol === 'JPY=X' ? 'USD/JPY' : 'Space Exploration Technologies Corp.';
  return { chart: { error: null, result: [{ meta: {
    symbol, currency, instrumentType, regularMarketTime: NOW / 1_000 - 900, regularMarketPrice: 135.25,
    exchangeName: symbol.endsWith('.L') ? 'LSE' : symbol === 'JPY=X' ? 'CCY' : symbol === 'SPCX' ? 'NMS' : 'PCX',
    exchangeTimezoneName: london ? 'Europe/London' : 'America/New_York', longName,
  } }] } };
}

function historyBody(symbol = 'AAPL', currency = 'USD') {
  const start = Date.parse('2026-09-01T13:30:00.000Z') / 1_000;
  return { chart: { error: null, result: [{
    meta: { symbol, currency, instrumentType: 'EQUITY', exchangeTimezoneName: 'America/New_York', dataGranularity: '1d' },
    timestamp: Array.from({ length: 30 }, (_, index) => start + index * 86_400),
    indicators: { quote: [{ open: Array(30).fill(100), high: Array(30).fill(105), low: Array(30).fill(95), close: Array(30).fill(102) }],
      adjclose: [{ adjclose: Array(30).fill(999) }] },
  }] } };
}
async function daily(symbol = 'AAPL', now = NOW): Promise<Snapshot> {
  return fetchHistory(symbol, 20, (async () => json(historyBody(symbol))) as typeof fetch, now);
}
function quote(symbol = 'AAPL', now = NOW): Quote {
  return { symbol, providerSymbol: symbol, price: 123.45, changePercent: 1.2, asOf: now - 15_000,
    fetchedAt: now, currency: 'USD', source: 'FINNHUB', unofficial: false, delayed: false, regularMarketTime: null };
}
function providerFor(fetcher: typeof fetch, tickers = ['AAPL', 'VWRA.L'], clock = () => NOW) {
  return createProvider(config(tickers), fetcher, clock);
}

test('parses aliases, preserves order, permits varied example symbols, and caps the configured cache at 20', () => {
  assert.equal(MAX_TICKERS, 20);
  const wanted = parseTickers('VWRA,AAPL,MSFT,SPY,SPCX,VALL,USD/JPY');
  assert.equal(wanted.length, 7);
  assert.equal(wanted[0], 'VWRA.L');
  assert.equal(wanted.at(-1), 'USD/JPY');
  assert.deepEqual(parseTickers(' aapl, vwra.l '), ['AAPL', 'VWRA.L']);
  assert.throws(() => parseTickers('VWRA,VWRA.L'), /Duplicate/);
  for (const bad of ['', 'AAPL,,MSFT', 'VALL.L', 'AAPL?token=secret', 'EUR/USD']) assert.throws(() => parseTickers(bad));
  assert.throws(() => normalizeTickers(Array.from({ length: 21 }, (_, index) => `T${index}`)), /1–20/);
});

test('validates bounded schedules and configured symbols before network activity', async () => {
  for (const quoteRefreshSeconds of [0, 29, 61, NaN, 30.5]) assert.throws(() => new MarketCache({ ...config(), quoteRefreshSeconds }));
  for (const historyRefreshHours of [0, 5, 25]) assert.throws(() => new MarketCache({ ...config(), historyRefreshHours }));
  let calls = 0;
  const provider = providerFor((async () => { calls++; return json({}); }) as typeof fetch);
  await assert.rejects(provider.getQuote('MSFT'), /not configured/);
  assert.equal(calls, 0);
});

test('Finnhub uses a header-only secret, validates USD metadata, and preserves source vs fetch timestamps', async () => {
  const requests: string[] = [];
  const provider = providerFor((async (input, init) => {
    const url = String(input); requests.push(url);
    assert.equal(new Headers(init?.headers).get('X-Finnhub-Token'), SECRET);
    assert.equal(url.includes(SECRET), false);
    assert.equal(url.includes('token='), false);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
    return json(url.includes('/profile2') ? profile() : currentQuote());
  }) as typeof fetch);
  const result = await provider.getQuote('AAPL');
  assert.equal(result.asOf, NOW - 15_000);
  assert.equal(result.fetchedAt, NOW);
  assert.equal(result.currency, 'USD');
  assert.equal(result.source, 'FINNHUB');
  await provider.getQuote('AAPL');
  assert.equal(requests.filter(url => url.includes('/profile2')).length, 1);
  assert.equal(requests.filter(url => url.includes('/quote?')).length, 2);
  assert.equal(JSON.stringify(provider).includes(SECRET), false);
});

test('all explicit Yahoo aliases use verified destinations, currency, type, and delayed price-only fields', async () => {
  const routes = [
    ['VWRA.L', 'VWRA.L', 'USD', 'ETF'], ['VALL', 'VALU.L', 'USD', 'ETF'],
    ['SPCX', 'SPCX', 'USD', 'EQUITY'], ['USD/JPY', 'JPY=X', 'JPY', 'CURRENCY'],
  ];
  for (const [symbol, destination, currency, kind] of routes) {
    let calls = 0;
    const provider = providerFor((async (input, init) => {
      calls++;
      assert.equal(String(input), `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(destination)}?range=1d&interval=1m`);
      assert.equal(new Headers(init?.headers).has('X-Finnhub-Token'), false);
      return json(yahoo(destination, currency, kind));
    }) as typeof fetch, [symbol]);
    const result = await provider.getQuote(symbol);
    assert.equal(result.symbol, symbol);
    assert.equal(result.providerSymbol, destination);
    assert.equal(result.currency, currency);
    assert.equal(result.changePercent, null);
    assert.equal(result.asOf, NOW - 900_000);
    assert.equal(result.regularMarketTime, NOW / 1_000 - 900);
    assert.equal(result.fetchedAt, NOW);
    assert.equal(result.unofficial, true);
    assert.equal(result.delayed, true);
    assert.equal(isHistorySupported(symbol), false);
    await assert.rejects(provider.getHistory(symbol, 20), /price-only/);
    assert.equal(calls, 1);
  }
});

test('Yahoo rejects mismatched currency, destination, type, issuer, invalid price, and future timestamps', async () => {
  for (const change of [
    { symbol: 'VALL.L' }, { currency: 'GBP' }, { instrumentType: 'EQUITY' },
    { regularMarketTime: NOW / 1_000 + 1 }, { regularMarketTime: 1.5 },
    { regularMarketTime: 0 }, { regularMarketPrice: 0 }, { regularMarketPrice: '135.25' },
    { longName: 'An unrelated Vanguard fund' }, { exchangeName: 'PCX' }, { exchangeTimezoneName: 'America/New_York' },
  ]) {
    const body = yahoo('VALU.L'); Object.assign(body.chart.result[0].meta, change);
    const provider = providerFor((async () => json(body)) as typeof fetch, ['VALL']);
    await assert.rejects(provider.getQuote('VALL'), /invalid/);
  }
  const body = yahoo('SPCX', 'USD', 'EQUITY'); body.chart.result[0].meta.longName = 'Unrelated SPAC fund';
  await assert.rejects(providerFor((async () => json(body)) as typeof fetch, ['SPCX']).getQuote('SPCX'), /identity/);
});

test('Finnhub rejects malformed quotes and never infers a currency from a successful price response', async () => {
  for (const change of [{ c: 0 }, { c: '123' }, { dp: null }, { dp: -101 }, { t: 0 }, { t: NOW / 1_000 + 1 }, { t: NOW / 1_000 - 0.5 }]) {
    const provider = providerFor((async input => json(String(input).includes('/profile2') ? profile() : { ...currentQuote(), ...change })) as typeof fetch);
    await assert.rejects(provider.getQuote('AAPL'), /invalid/);
  }
  let count = 0;
  const provider = providerFor((async () => { count++; return json({ ...profile(), currency: 'EUR' }); }) as typeof fetch);
  await assert.rejects(provider.getQuote('AAPL'), /verify/);
  await assert.rejects(provider.getQuote('AAPL'), /unavailable/);
  assert.equal(count, 1, 'contradictory metadata must not fall back or repeatedly fetch');
});

test('SPY missing company profile uses validated US Yahoo metadata but keeps Finnhub as price source', async () => {
  const requests: string[] = [];
  const provider = providerFor((async input => {
    const url = String(input); requests.push(url);
    if (url.includes('/profile2')) return json({});
    if (url.includes('yahoo')) return json(yahoo('SPY'));
    return json(currentQuote());
  }) as typeof fetch, ['SPY']);
  assert.equal((await provider.getQuote('SPY')).source, 'FINNHUB');
  await provider.getQuote('SPY');
  assert.equal(requests.filter(url => url.includes('/profile2')).length, 1);
  assert.equal(requests.filter(url => url.includes('yahoo')).length, 1);
  assert.equal(requests.filter(url => url.includes('/quote?')).length, 2);
});

test('SPY metadata fallback rejects non-US or non-USD ETF metadata and preserves NO DATA', async () => {
  const body = yahoo('SPY'); body.chart.result[0].meta.exchangeName = 'LSE';
  const cache = new MarketCache(config(['SPY']), { clock: () => NOW,
    fetcher: (async input => json(String(input).includes('/profile2') ? {} : body)) as typeof fetch });
  await cache.refreshQuotes();
  assert.equal(cache.quote('SPY').status, 'NO DATA');
  assert.equal(cache.quote('SPY').currency, null);
});

test('profile validation expires at six hours and fails closed when revalidation fails', async () => {
  let now = NOW; let profiles = 0;
  const provider = providerFor((async input => {
    if (String(input).includes('/profile2')) { profiles++; return json(profiles === 1 ? profile() : { ...profile(), currency: 'EUR' }); }
    return json({ ...currentQuote(), t: Math.floor(now / 1_000) });
  }) as typeof fetch, ['AAPL'], () => now);
  await provider.getQuote('AAPL'); now += 6 * 3_600_000 - 1;
  await provider.getQuote('AAPL'); assert.equal(profiles, 1);
  now += 1; await assert.rejects(provider.getQuote('AAPL')); assert.equal(profiles, 2);
});

test('timeouts include body reads and sanitize arbitrary provider exceptions and payloads', async () => {
  for (const fetcher of [
    (async () => { throw new Error(`bad https://example.test/?token=${SECRET}`); }) as typeof fetch,
    (async () => new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } }))) as typeof fetch,
    (async () => json({ message: SECRET }, 403)) as typeof fetch,
  ]) {
    const provider = createProvider({ ...config(['VWRA.L']), requestTimeoutMs: 10 }, fetcher, () => NOW);
    await assert.rejects(provider.getQuote('VWRA.L'), error => {
      assert.equal(String(error).includes(SECRET), false);
      assert.match(String(error), /failed or timed out/);
      return true;
    });
  }
});

test('HTTP 429 opens provider-wide cooldown instead of sending requests for each ticker', async () => {
  let calls = 0;
  const provider = providerFor((async () => { calls++; return json({ message: SECRET }, 429); }) as typeof fetch, ['AAPL', 'MSFT']);
  await assert.rejects(provider.getQuote('AAPL'));
  await assert.rejects(provider.getQuote('MSFT'));
  assert.equal(calls, 1);
});

test('HTTP bodies are capped at two MiB before parsing and oversized streams are canceled', async () => {
  for (const withLength of [false, true]) {
    let canceled = false;
    const fetcher = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1_024 * 1_024 + 1)); },
      cancel() { canceled = true; },
    }), { headers: withLength ? { 'Content-Length': String(2 * 1_024 * 1_024 + 1) } : {} })) as typeof fetch;
    await assert.rejects(providerFor(fetcher, ['VWRA.L']).getQuote('VWRA.L'), /failed/);
    assert.equal(canceled, true);
  }
});

test('the provider enforces rolling minute and second budgets even when called outside the cache', async () => {
  let now = NOW; let calls = 0;
  const provider = providerFor((async input => {
    calls++;
    return json(String(input).includes('/profile2') ? profile() : currentQuote());
  }) as typeof fetch, ['AAPL'], () => now);
  await provider.getQuote('AAPL'); // One metadata call and one quote call.
  for (let index = 0; index < 28; index++) await provider.getQuote('AAPL');
  await assert.rejects(provider.getQuote('AAPL'), /budget/); assert.equal(calls, 30);
  now += 1_000;
  for (let index = 0; index < 15; index++) await provider.getQuote('AAPL');
  await assert.rejects(provider.getQuote('AAPL'), /budget/); assert.equal(calls, 45);
  now += 60_000;
  await provider.getQuote('AAPL'); assert.equal(calls, 46);
});

test('daily history uses completed raw OHLC, rejects non-USD and excludes all price-only instruments', async () => {
  const snapshot = await daily();
  assert.equal(snapshot.bars.length, 20);
  assert.equal(snapshot.bars.at(-1)?.close, 102);
  assert.equal(snapshot.currency, 'USD');
  await assert.rejects(fetchHistory('AAPL', 20, (async () => json(historyBody('AAPL', 'EUR'))) as typeof fetch, NOW), /USD/);
  for (const symbol of ['VWRA.L', 'SPCX', 'VALL', 'USD/JPY']) {
    await assert.rejects(fetchHistory(symbol, 20, (async () => { throw new Error('must never request'); }) as typeof fetch, NOW), /price-only/);
  }
});

test('quotes respect 30-second TTL, deduplicate refreshes, preserve lastgood, back off, and recover', async () => {
  let now = NOW; let calls = 0; let broken = false;
  const provider: MarketProvider = { async getQuote(symbol) { calls++; if (broken) throw new Error(SECRET); return quote(symbol, now); }, getHistory: daily };
  const cache = new MarketCache(config(['AAPL']), { clock: () => now, provider });
  await Promise.all([cache.refreshQuotes(), cache.refreshQuotes(), cache.refreshQuotes()]);
  assert.equal(calls, 1); assert.equal(cache.quote('AAPL').status, 'OK');
  await cache.refreshQuotes(); assert.equal(calls, 1);
  now += 30_000; broken = true; await cache.refreshQuotes(); assert.equal(calls, 2);
  assert.equal(cache.quote('AAPL').price, 123.45); assert.equal(cache.quote('AAPL').status, 'ERROR');
  assert.equal(cache.quote('AAPL').retrievedAt, new Date(NOW).toISOString());
  assert.equal(JSON.stringify(cache).includes(SECRET), false);
  now += 30_000; await cache.refreshQuotes(); assert.equal(calls, 3);
  now += 30_000; broken = false; await cache.refreshQuotes(); assert.equal(calls, 3);
  now += 30_000; await cache.refreshQuotes(); assert.equal(calls, 4); assert.equal(cache.quote('AAPL').status, 'OK');
});

test('history is serial, cached six hours, retains stale lastgood and waits five minutes before first retry', async () => {
  let now = NOW; let active = 0; let maxActive = 0; let calls = 0; let broken = false;
  const provider: MarketProvider = {
    async getQuote(symbol) { return quote(symbol, now); },
    async getHistory(symbol) { calls++; active++; maxActive = Math.max(maxActive, active);
      try { await Promise.resolve(); if (broken) throw new Error(SECRET); return await daily(symbol, now); } finally { active--; } },
  };
  const cache = new MarketCache(config(['AAPL', 'MSFT', 'VWRA.L', 'SPCX', 'VALL', 'USD/JPY']), { clock: () => now, provider });
  await Promise.all([cache.refreshHistory(), cache.refreshHistory()]);
  assert.equal(calls, 2); assert.equal(maxActive, 1);
  assert.equal(cache.history('AAPL').stale, false);
  await cache.refreshHistory(); assert.equal(calls, 2);
  now += 6 * 3_600_000; broken = true; await cache.refreshHistory(); assert.equal(calls, 4);
  assert.equal(cache.history('AAPL').stale, true); assert.equal(cache.history('AAPL').snapshot?.bars.length, 20);
  now += 5 * 60_000 - 1; await cache.refreshHistory(); assert.equal(calls, 4);
  now += 1; broken = false; await cache.refreshHistory(); assert.equal(calls, 6);
  assert.equal(cache.history('AAPL').stale, false);
  assert.equal(JSON.stringify(cache).includes(SECRET), false);
});

test('history state is copied, and stale cached source sessions are not replaced by fabricated current values', async () => {
  const provider: MarketProvider = { async getQuote(symbol) { return quote(symbol); }, async getHistory(symbol) { return daily(symbol); } };
  const cache = new MarketCache(config(['AAPL']), { clock: () => NOW, provider });
  await cache.refresh();
  const view = cache.history('AAPL'); view.snapshot!.bars[0].close = 1;
  assert.equal(cache.history('AAPL').snapshot?.bars[0].close, 102);
  assert.ok(cache.history('AAPL').snapshot!.bars.at(-1)!.date < '2026-10-16');
});

test('validates injected provider data, rejects timestamp regression, and never serializes extra secret fields', async () => {
  let now = NOW; let value: Quote = { ...quote(), key: SECRET } as Quote;
  const provider: MarketProvider = { async getQuote() { return value; }, getHistory: daily };
  const cache = new MarketCache(config(['AAPL']), { clock: () => now, provider });
  await cache.refreshQuotes(); assert.equal(JSON.stringify(cache).includes(SECRET), false);
  now += 30_000; value = { ...quote('AAPL', now), asOf: NOW - 16_000 };
  await cache.refreshQuotes(); assert.equal(cache.quote('AAPL').asOf, new Date(NOW - 15_000).toISOString());
  assert.equal(cache.quote('AAPL').stale, true);
  now += 30_000; value = { ...quote('AAPL', now), fetchedAt: now + 1 };
  await cache.refreshQuotes(); assert.equal(cache.quote('AAPL').status, 'ERROR');
});

test('missing data is explicitly missing, and optional disabled instruments trigger no network calls', async () => {
  let calls = 0;
  const cache = new MarketCache({ ...config(['AAPL', 'USD/JPY']), unsupportedSymbols: ['AAPL', 'USD/JPY'] }, {
    clock: () => NOW, fetcher: (async () => { calls++; throw new Error(SECRET); }) as typeof fetch,
  });
  await cache.refresh(); assert.equal(calls, 0);
  for (const view of cache.all()) {
    assert.equal(view.price, null); assert.equal(view.currency, null); assert.equal(view.asOf, null);
    assert.equal(view.retrievedAt, null); assert.equal(view.status, 'NO DATA'); assert.equal(view.stale, true);
  }
});

test('views show old source timestamps as stale even after a successful fresh retrieval', async () => {
  const provider: MarketProvider = { async getQuote(symbol) { return { ...quote(symbol), asOf: NOW - 600_000 }; }, getHistory: daily };
  const cache = new MarketCache(config(['AAPL']), { clock: () => NOW, provider });
  await cache.refreshQuotes();
  assert.equal(cache.quote('AAPL').status, 'STALE');
  assert.equal(cache.quote('AAPL').retrievedAt, new Date(NOW).toISOString());
});

test('start is idempotent and stop prevents remaining serial work and later scheduled polls', async () => {
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  let quotes = 0; let histories = 0;
  const provider: MarketProvider = {
    async getQuote(symbol) { quotes++; await pending; return quote(symbol); },
    async getHistory(symbol) { histories++; await pending; return daily(symbol); },
  };
  const cache = new MarketCache(config(['AAPL', 'MSFT']), { clock: () => NOW, provider });
  cache.start(); cache.start(); cache.stop(); release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(quotes, 1); assert.equal(histories, 1);
});
