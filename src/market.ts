/**
 * Server-only market data. There is deliberately no mock or synthetic fallback.
 * The API key lives only in a closure and is sent only in a Finnhub header.
 * Yahoo is an unofficial, delayed source; explicit alias feeds are price-only.
 */
import { fetchHistory as fetchDailyHistory, validateSnapshot } from './history.ts';
import type { Bar, Snapshot } from './history.ts';
export type { Bar, Snapshot } from './history.ts';

export const MAX_TICKERS = 20;
export const VWRA_SYMBOL = 'VWRA.L';
export type Fetcher = typeof fetch;
export type MarketConfig = {
  tickers: string[];
  apiKey: string;
  quoteRefreshSeconds?: number;
  historyRefreshHours?: number;
  requestTimeoutMs?: number;
  staleQuoteSeconds?: number;
  historyCount?: number;
  unsupportedSymbols?: string[];
};
export type Quote = {
  symbol: string;
  providerSymbol: string;
  price: number;
  changePercent: number | null;
  /** Source trade time in Unix milliseconds, never the retrieval time. */
  asOf: number;
  /** Completion of this successful retrieval, in Unix milliseconds. */
  fetchedAt: number;
  currency: 'USD' | 'JPY';
  source: 'FINNHUB' | 'YAHOO';
  unofficial: boolean;
  delayed: boolean;
  /** Original Yahoo regularMarketTime in Unix seconds; absent for Finnhub. */
  regularMarketTime: number | null;
};
export type QuoteView = {
  symbol: string;
  providerSymbol: string;
  price: number | null;
  changePercent: number | null;
  asOf: string | null;
  retrievedAt: string | null;
  regularMarketTime: number | null;
  source: 'FINNHUB' | 'YAHOO';
  currency: 'USD' | 'JPY' | null;
  unofficial: boolean;
  delayed: boolean;
  label: string;
  stale: boolean;
  status: 'OK' | 'STALE' | 'ERROR' | 'NO DATA';
  error: string | null;
};
export type HistoryView = { symbol: string; snapshot?: Snapshot; stale: boolean; error?: string };
export type MarketProvider = {
  getQuote(symbol: string): Promise<Quote>;
  getHistory(symbol: string, count: number): Promise<Snapshot>;
};
export type MarketDependencies = { fetcher?: Fetcher; clock?: () => number; provider?: MarketProvider };

type SafeConfig = {
  tickers: string[]; quoteRefreshMs: number; historyRefreshMs: number;
  requestTimeoutMs: number; staleQuoteMs: number; historyCount: number;
  unsupportedSymbols: string[];
};
type QuoteEntry = { quote?: Quote; error?: string; failures: number; nextAt: number };
type HistoryEntry = { snapshot?: Snapshot; error?: string; failures: number; nextAt: number };
const HOUR = 3_600_000;
const MINUTE = 60_000;
const METADATA_TTL = 6 * HOUR;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
type YahooRoute = {
  providerSymbol: string; currency: 'USD' | 'JPY'; instrumentType: string;
  exchange: string; timezone: string; longName?: string;
};
const YAHOO_ROUTES: Readonly<Record<string, YahooRoute>> = Object.freeze({
  'VWRA.L': { providerSymbol: 'VWRA.L', currency: 'USD', instrumentType: 'ETF', exchange: 'LSE', timezone: 'Europe/London' },
  VALL: { providerSymbol: 'VALU.L', currency: 'USD', instrumentType: 'ETF', exchange: 'LSE', timezone: 'Europe/London',
    longName: 'Vanguard Funds PLC - Vanguard FTSE Global All-Cap UCITS ETF USD Acc' },
  SPCX: { providerSymbol: 'SPCX', currency: 'USD', instrumentType: 'EQUITY', exchange: 'NMS', timezone: 'America/New_York',
    longName: 'Space Exploration Technologies Corp.' },
  'USD/JPY': { providerSymbol: 'JPY=X', currency: 'JPY', instrumentType: 'CURRENCY', exchange: 'CCY', timezone: 'Europe/London',
    longName: 'USD/JPY' },
});

export function isHistorySupported(symbol: string): boolean { return !Object.hasOwn(YAHOO_ROUTES, symbolOf(symbol)); }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nowMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) throw new Error('Invalid reference time.');
  return value;
}
function symbolOf(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Ticker must be a string.');
  const normalized = input.trim().toUpperCase();
  const symbol = normalized === 'VWRA' ? VWRA_SYMBOL : normalized;
  // US listing symbols, including common class-share suffixes, plus explicit price-only aliases.
  if (!Object.hasOwn(YAHOO_ROUTES, symbol) && !/^[A-Z][A-Z0-9]{0,9}(?:[.-][ABC])?$/.test(symbol)) {
    throw new Error('Use a US ticker or a supported explicit price-only alias.');
  }
  return symbol;
}
export function normalizeTickers(tickers: readonly string[]): string[] {
  if (!Array.isArray(tickers) || tickers.length < 1 || tickers.length > MAX_TICKERS) {
    throw new Error(`Configure 1–${MAX_TICKERS} distinct tickers.`);
  }
  const normalized = tickers.map(symbolOf);
  if (new Set(normalized).size !== normalized.length) throw new Error('Duplicate tickers are not allowed.');
  return normalized;
}
export function parseTickers(value: string): string[] {
  if (typeof value !== 'string') throw new Error('Tickers must be comma-separated text.');
  return normalizeTickers(value.split(','));
}
function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}
function safeConfig(config: MarketConfig): SafeConfig {
  return {
    tickers: normalizeTickers(config.tickers),
    quoteRefreshMs: bounded(config.quoteRefreshSeconds, 30, 30, 60, 'Quote refresh seconds') * 1_000,
    historyRefreshMs: bounded(config.historyRefreshHours, 6, 6, 24, 'History refresh hours') * HOUR,
    requestTimeoutMs: bounded(config.requestTimeoutMs, 10_000, 1, 60_000, 'Request timeout milliseconds'),
    staleQuoteMs: bounded(config.staleQuoteSeconds, 180, 30, 86_400, 'Quote stale seconds') * 1_000,
    historyCount: bounded(config.historyCount, 20, 12, 20, 'History sessions'),
    unsupportedSymbols: (config.unsupportedSymbols ?? []).map(symbolOf),
  };
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function sourceTime(value: unknown, now: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 946_684_800 && value * 1_000 <= now;
}
function backoff(failures: number, initial: number, ceiling: number): number {
  return Math.min(ceiling, initial * 2 ** Math.min(Math.max(0, failures - 1), 16));
}

/** Keep this adapter separate from the broad, manually usable Yahoo history module. */
export async function fetchHistory(symbol: string, count = 20, fetcher: Fetcher = fetch, now = Date.now()): Promise<Snapshot> {
  const ticker = symbolOf(symbol);
  if (!isHistorySupported(ticker)) throw new Error('This instrument is price-only in the combined display.');
  const snapshot = await fetchDailyHistory(ticker, count, fetcher, nowMs(now));
  if (snapshot.currency !== 'USD') throw new Error('US daily-history currency must be USD.');
  return snapshot;
}

/**
 * Finnhub profile2 is the documented free company-profile endpoint. /quote does
 * not return currency, so validated USD listing metadata is required first.
 * Missing metadata fails closed. Neither a paid candle endpoint nor an inferred
 * currency is used. Metadata failure and HTTP 429s have independent backoff.
 */
export function createProvider(config: MarketConfig, fetcher: Fetcher = fetch, clock: () => number = Date.now): MarketProvider {
  const safe = safeConfig(config);
  const allowed = new Set(safe.tickers);
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  const profiles = new Map<string, { expiresAt: number; retryAt: number; failures: number }>();
  const cooldown = { finnhub: 0, yahoo: 0 };
  const recentFinnhubRequests: number[] = [];
  const checkAllowed = (input: string) => {
    const symbol = symbolOf(input);
    if (!allowed.has(symbol)) throw new Error('Ticker is not configured.');
    if (safe.unsupportedSymbols.includes(symbol)) throw new Error('This instrument is unsupported.');
    return symbol;
  };

  async function requestJson(url: string, source: 'finnhub' | 'yahoo', init: RequestInit = {}): Promise<unknown> {
    const started = nowMs(clock());
    if (started < cooldown[source]) throw new Error('Provider is cooling down; retry later.');
    if (source === 'finnhub') {
      if (!apiKey) throw new Error('A server-side Finnhub API key is required for US quotes.');
      while (recentFinnhubRequests.length && recentFinnhubRequests[0] <= started - MINUTE) recentFinnhubRequests.shift();
      // Conservative rolling budget, including profile lookups. No waiting queue
      // can grow, and a manual refresh cannot create an unbounded request storm.
      if (recentFinnhubRequests.length >= 45 || recentFinnhubRequests.filter(time => time > started - 1_000).length >= 30) {
        throw new Error('Local Finnhub request budget reached; retry later.');
      }
      recentFinnhubRequests.push(started);
    }
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        void reader?.cancel().catch(() => {});
        reject(new Error('Provider request timed out.'));
      }, safe.requestTimeoutMs);
    });
    try {
      const work = (async () => {
        const response = await fetcher(url, {
          ...init,
          headers: source === 'finnhub'
            ? { Accept: 'application/json', 'X-Finnhub-Token': apiKey }
            : { Accept: 'application/json', 'User-Agent': 'TimesGateCombined/0.1' },
          signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
          redirect: 'error',
        });
        if (!response.ok) {
          if (response.status === 429) cooldown[source] = nowMs(clock()) + MINUTE;
          void response.body?.cancel().catch(() => {});
          throw new Error('Provider request was unsuccessful.');
        }
        if (Number(response.headers.get('Content-Length') ?? 0) > MAX_RESPONSE_BYTES || !response.body) {
          void response.body?.cancel().catch(() => {});
          throw new Error('Provider response is oversized or empty.');
        }
        reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let bytes = 0;
        let text = '';
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            void reader.cancel().catch(() => {});
            controller.abort();
            throw new Error('Provider response is oversized.');
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        return JSON.parse(text) as unknown;
      })();
      return await Promise.race([work, deadline]);
    } catch {
      // Never propagate errors, HTTP bodies, request headers, URLs, or causes.
      throw new Error('Provider request failed or timed out.');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function checkUsdProfile(symbol: string): Promise<void> {
    const now = nowMs(clock());
    const previous = profiles.get(symbol);
    if (previous && now < previous.expiresAt) return;
    if (previous && now < previous.retryAt) throw new Error('US listing metadata is unavailable; retry later.');
    try {
      const data = await requestJson(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}`, 'finnhub');
      if (!record(data)) throw new Error('US listing metadata is invalid.');
      // Never override contradictory identity/currency. An empty/incomplete free
      // profile (notably for ETFs such as SPY) can use explicit Yahoo US metadata.
      if ((data.ticker !== undefined && data.ticker !== symbol)
        || (data.currency !== undefined && data.currency !== 'USD')
        || (data.exchange !== undefined && (typeof data.exchange !== 'string'
          || !/NASDAQ|NEW YORK|NYSE|CBOE|BATS|OTC|PINK|AMEX/i.test(data.exchange)))) {
        throw new Error('US listing metadata is invalid.');
      }
      if (data.ticker !== symbol || data.currency !== 'USD' || typeof data.exchange !== 'string') {
        const fallback = await requestJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`, 'yahoo');
        if (!record(fallback) || !record(fallback.chart) || fallback.chart.error != null
          || !Array.isArray(fallback.chart.result) || fallback.chart.result.length !== 1 || !record(fallback.chart.result[0])) {
          throw new Error('US metadata is unavailable.');
        }
        const meta = fallback.chart.result[0].meta;
        if (!record(meta) || meta.symbol !== symbol || meta.currency !== 'USD'
          || !['EQUITY', 'ETF'].includes(String(meta.instrumentType))
          || !['NMS', 'NYQ', 'PCX', 'NGM', 'NCM', 'ASE', 'BATS', 'BTS', 'OTC', 'OBB', 'PNK'].includes(String(meta.exchangeName))
          || meta.exchangeTimezoneName !== 'America/New_York') throw new Error('US metadata is invalid.');
      }
      profiles.set(symbol, { expiresAt: nowMs(clock()) + METADATA_TTL, retryAt: 0, failures: 0 });
    } catch {
      const failures = (previous?.failures ?? 0) + 1;
      profiles.set(symbol, { expiresAt: 0, retryAt: nowMs(clock()) + backoff(failures, MINUTE, HOUR), failures });
      throw new Error('Could not verify a USD US listing; retry later.');
    }
  }

  return {
    async getQuote(input) {
      const symbol = checkAllowed(input);
      const route = YAHOO_ROUTES[symbol];
      if (route) {
        const data = await requestJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(route.providerSymbol)}?range=1d&interval=1m`, 'yahoo');
        if (!record(data) || !record(data.chart) || data.chart.error != null
          || !Array.isArray(data.chart.result) || data.chart.result.length !== 1 || !record(data.chart.result[0])) {
          throw new Error('Yahoo returned no usable delayed price.');
        }
        const meta = data.chart.result[0].meta;
        const fetchedAt = nowMs(clock());
        if (!record(meta) || meta.symbol !== route.providerSymbol || meta.currency !== route.currency
          || meta.instrumentType !== route.instrumentType
          || meta.exchangeName !== route.exchange || meta.exchangeTimezoneName !== route.timezone
          || (route.longName && (typeof meta.longName !== 'string' || meta.longName.trim() !== route.longName))
          || !positive(meta.regularMarketPrice) || !sourceTime(meta.regularMarketTime, fetchedAt)) {
          throw new Error('Yahoo delayed price, instrument identity, currency, or source timestamp is invalid.');
        }
        return { symbol, providerSymbol: route.providerSymbol, price: meta.regularMarketPrice, changePercent: null,
          asOf: meta.regularMarketTime * 1_000, fetchedAt, regularMarketTime: meta.regularMarketTime,
          currency: route.currency, source: 'YAHOO', unofficial: true, delayed: true };
      }
      await checkUsdProfile(symbol);
      const data = await requestJson(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`, 'finnhub');
      const fetchedAt = nowMs(clock());
      if (!record(data) || !positive(data.c) || typeof data.dp !== 'number' || !Number.isFinite(data.dp)
        || data.dp < -100 || !sourceTime(data.t, fetchedAt)) {
        throw new Error('Finnhub price, daily change, or source timestamp is invalid.');
      }
      return { symbol, providerSymbol: symbol, price: data.c, changePercent: data.dp, asOf: data.t * 1_000, fetchedAt,
        currency: 'USD', source: 'FINNHUB', unofficial: false, delayed: false, regularMarketTime: null };
    },
    async getHistory(input, count) {
      const symbol = checkAllowed(input);
      if (!isHistorySupported(symbol)) throw new Error('This instrument is price-only in the combined display.');
      // The existing adapter owns parsing completed raw daily OHLC. This wrapper
      // adds an independent full-response deadline and the USD-only restriction.
      const boundedFetcher = (async (url, init) => {
        const body = await requestJson(String(url), 'yahoo', init);
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as Fetcher;
      const snapshot = await fetchHistory(symbol, count, boundedFetcher, nowMs(clock()));
      const completed = nowMs(clock());
      return validateSnapshot({ ...snapshot, fetchedAt: new Date(completed).toISOString() }, completed);
    },
  };
}

function validateQuote(value: Quote, symbol: string, now: number): Quote {
  const route = YAHOO_ROUTES[symbol];
  const yahoo = Boolean(route);
  if (!record(value) || value.symbol !== symbol || value.providerSymbol !== (route?.providerSymbol ?? symbol)
    || value.currency !== (route?.currency ?? 'USD') || !positive(value.price)
    || !Number.isSafeInteger(value.asOf) || !sourceTime(value.asOf / 1_000, now)
    || !Number.isSafeInteger(value.fetchedAt) || value.fetchedAt > now || value.fetchedAt < value.asOf
    || value.source !== (yahoo ? 'YAHOO' : 'FINNHUB') || value.unofficial !== yahoo || value.delayed !== yahoo
    || (yahoo ? value.changePercent !== null || value.regularMarketTime !== value.asOf / 1_000
      : typeof value.changePercent !== 'number' || !Number.isFinite(value.changePercent)
        || value.changePercent < -100 || value.regularMarketTime !== null)) {
    throw new Error('Invalid normalized quote.');
  }
  // Copy only whitelisted fields, including for injected providers.
  return { symbol, providerSymbol: value.providerSymbol, price: value.price, changePercent: value.changePercent, asOf: value.asOf,
    fetchedAt: value.fetchedAt, currency: value.currency, source: value.source, unofficial: yahoo,
    delayed: yahoo, regularMarketTime: value.regularMarketTime };
}

export class MarketCache {
  readonly tickers: readonly string[];
  #config: SafeConfig;
  #provider: MarketProvider;
  #clock: () => number;
  #quotes = new Map<string, QuoteEntry>();
  #histories = new Map<string, HistoryEntry>();
  #quotesInFlight?: Promise<void>;
  #historyInFlight?: Promise<void>;
  #quoteTimer?: ReturnType<typeof setTimeout>;
  #historyTimer?: ReturnType<typeof setTimeout>;
  #running = false;
  #generation = 0;

  constructor(config: MarketConfig, dependencies: MarketDependencies = {}) {
    this.#config = safeConfig(config);
    this.tickers = Object.freeze([...this.#config.tickers]);
    this.#clock = dependencies.clock ?? Date.now;
    this.#provider = dependencies.provider ?? createProvider(config, dependencies.fetcher ?? fetch, this.#clock);
  }
  #configured(input: string): string {
    const symbol = symbolOf(input);
    if (!this.tickers.includes(symbol)) throw new Error('Ticker is not configured.');
    return symbol;
  }

  async refreshQuotes(): Promise<void> {
    if (this.#quotesInFlight) return this.#quotesInFlight;
    const generation = this.#generation;
    this.#quotesInFlight = (async () => {
      for (const symbol of this.tickers) {
        if (generation !== this.#generation) break;
        if (this.#config.unsupportedSymbols.includes(symbol)) continue;
        const previous = this.#quotes.get(symbol);
        if (previous && nowMs(this.#clock()) < previous.nextAt) continue;
        try {
          const value = await this.#provider.getQuote(symbol);
          const completed = nowMs(this.#clock());
          const quote = validateQuote(value, symbol, completed);
          if (previous?.quote && quote.asOf < previous.quote.asOf) throw new Error('Source timestamp regressed.');
          this.#quotes.set(symbol, { quote, failures: 0, nextAt: completed + this.#config.quoteRefreshMs });
        } catch {
          const failures = (previous?.failures ?? 0) + 1;
          this.#quotes.set(symbol, { ...previous, failures,
            error: 'Quote fetch or validation failed; retry scheduled.',
            nextAt: nowMs(this.#clock()) + backoff(failures, this.#config.quoteRefreshMs, 15 * MINUTE) });
        }
      }
    })();
    try { await this.#quotesInFlight; } finally { this.#quotesInFlight = undefined; }
  }

  async refreshHistory(): Promise<void> {
    if (this.#historyInFlight) return this.#historyInFlight;
    const generation = this.#generation;
    this.#historyInFlight = (async () => {
      for (const symbol of this.tickers) {
        if (generation !== this.#generation) break;
        if (!isHistorySupported(symbol) || this.#config.unsupportedSymbols.includes(symbol)) continue;
        const previous = this.#histories.get(symbol);
        if (previous && nowMs(this.#clock()) < previous.nextAt) continue;
        try {
          const raw = await this.#provider.getHistory(symbol, this.#config.historyCount);
          const completed = nowMs(this.#clock());
          const snapshot = validateSnapshot(raw, completed);
          if (snapshot.symbol !== symbol || snapshot.currency !== 'USD' || snapshot.bars.length !== this.#config.historyCount
            || (previous?.snapshot && snapshot.bars.at(-1)!.timestamp < previous.snapshot.bars.at(-1)!.timestamp)) {
            throw new Error('Invalid or regressed US daily history.');
          }
          this.#histories.set(symbol, { snapshot, failures: 0, nextAt: completed + this.#config.historyRefreshMs });
        } catch {
          const failures = (previous?.failures ?? 0) + 1;
          this.#histories.set(symbol, { ...previous, failures,
            error: 'Daily history fetch or validation failed; retry scheduled.',
            nextAt: nowMs(this.#clock()) + backoff(failures, 5 * MINUTE, this.#config.historyRefreshMs) });
        }
      }
    })();
    try { await this.#historyInFlight; } finally { this.#historyInFlight = undefined; }
  }
  async refresh(): Promise<void> { await Promise.all([this.refreshQuotes(), this.refreshHistory()]); }

  /** Separate loops keep slow serial history requests from blocking quote polls. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    const generation = ++this.#generation;
    const tickQuotes = async () => {
      try { await this.refreshQuotes(); } catch { /* Never log provider data. */ }
      if (this.#running && generation === this.#generation) this.#quoteTimer = setTimeout(tickQuotes, this.#config.quoteRefreshMs);
    };
    const tickHistory = async () => {
      try { await this.refreshHistory(); } catch { /* Never log provider data. */ }
      if (this.#running && generation === this.#generation) this.#historyTimer = setTimeout(tickHistory, this.#config.quoteRefreshMs);
    };
    void tickQuotes();
    void tickHistory();
  }
  /** In-flight HTTP is bounded by its deadline; later symbols and polls stop. */
  stop(): void {
    this.#running = false;
    this.#generation += 1;
    if (this.#quoteTimer) clearTimeout(this.#quoteTimer);
    if (this.#historyTimer) clearTimeout(this.#historyTimer);
  }
  quote(input: string): QuoteView {
    const symbol = this.#configured(input);
    const { quote, error: storedError } = this.#quotes.get(symbol) ?? {};
    const error = this.#config.unsupportedSymbols.includes(symbol) ? 'This instrument is unsupported.' : storedError;
    const now = nowMs(this.#clock());
    const route = YAHOO_ROUTES[symbol];
    const yahoo = Boolean(route);
    // Normal Yahoo delay is explicitly labeled, not mistaken for a live feed.
    const sourceMaxAge = yahoo ? Math.max(30 * MINUTE, this.#config.staleQuoteMs) : this.#config.staleQuoteMs;
    const aged = !quote || now < quote.fetchedAt || now - quote.asOf > sourceMaxAge
      || now - quote.fetchedAt > this.#config.staleQuoteMs;
    return {
      symbol, providerSymbol: route?.providerSymbol ?? symbol,
      price: quote?.price ?? null, changePercent: quote?.changePercent ?? null,
      asOf: quote ? new Date(quote.asOf).toISOString() : null,
      retrievedAt: quote ? new Date(quote.fetchedAt).toISOString() : null,
      regularMarketTime: quote?.regularMarketTime ?? null,
      source: yahoo ? 'YAHOO' : 'FINNHUB', currency: quote?.currency ?? null,
      unofficial: yahoo, delayed: yahoo, label: yahoo ? 'YAHOO DELAYED UNOFFICIAL' : 'FINNHUB',
      stale: aged || Boolean(error), status: !quote ? 'NO DATA' : error ? 'ERROR' : aged ? 'STALE' : 'OK',
      error: error ?? null,
    };
  }
  history(input: string): HistoryView {
    const symbol = this.#configured(input);
    if (!isHistorySupported(symbol)) return { symbol, stale: true, error: 'This instrument is price-only.' };
    if (this.#config.unsupportedSymbols.includes(symbol)) return { symbol, stale: true, error: 'This instrument is unsupported.' };
    const { snapshot, error } = this.#histories.get(symbol) ?? {};
    const now = nowMs(this.#clock());
    const fetchedAt = snapshot ? Date.parse(snapshot.fetchedAt) : 0;
    return { symbol,
      ...(snapshot ? { snapshot: structuredClone(snapshot) } : {}),
      stale: !snapshot || Boolean(error) || now < fetchedAt || now - fetchedAt >= this.#config.historyRefreshMs,
      ...(error ? { error } : {}),
    };
  }
  all(): QuoteView[] { return this.tickers.map(symbol => this.quote(symbol)); }
  /** Explicit allowlist: private fields/config/credentials never serialize. */
  toJSON(): { quotes: QuoteView[]; histories: HistoryView[] } {
    return { quotes: this.all(), histories: this.tickers.filter(isHistorySupported).map(symbol => this.history(symbol)) };
  }
}
