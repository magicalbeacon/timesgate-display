/**
 * Unofficial Yahoo Finance daily OHLC adapter for the manual chart prototype.
 * Timestamps are Unix seconds. Prices are the raw quote OHLC fields, never
 * adjusted-close substitutes. The current exchange-local date is always omitted
 * so even a quote returned after the close cannot become an intraday candle.
 */

export type Currency = 'USD' | 'GBP' | 'GBp' | 'EUR' | 'JPY' | 'SGD' | 'HKD' | 'AUD' | 'CAD' | 'CHF';

export type Bar = {
  timestamp: number;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type Snapshot = {
  version: 1;
  source: 'YAHOO';
  unofficial: true;
  interval: '1d';
  symbol: string;
  currency: Currency;
  timezone: string;
  fetchedAt: string;
  bars: Bar[];
};

const CURRENCIES = new Set<string>(['USD', 'GBP', 'GBp', 'EUR', 'JPY', 'SGD', 'HKD', 'AUD', 'CAD', 'CHF']);
const SNAPSHOT_KEYS = ['version', 'source', 'unofficial', 'interval', 'symbol', 'currency', 'timezone', 'fetchedAt', 'bars'];
const BAR_KEYS = ['timestamp', 'date', 'open', 'high', 'low', 'close'];
const MAX_DATE_MS = 8_640_000_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function checkedNow(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS) {
    throw new Error('The reference time must be a valid Unix timestamp in milliseconds.');
  }
  return now;
}

function normalizedSymbol(input: unknown): string {
  if (typeof input !== 'string') throw new Error('The Yahoo symbol must be a string.');
  const symbol = input.trim().toUpperCase();
  if (!/^[A-Z0-9^][A-Z0-9.^=_-]{0,31}$/.test(symbol)) {
    throw new Error('The Yahoo symbol must contain 1–32 ticker characters only.');
  }
  return symbol;
}

function checkedCurrency(input: unknown): Currency {
  if (typeof input !== 'string' || !CURRENCIES.has(input)) {
    throw new Error('Missing or unsupported Yahoo currency. Supported: USD, GBP, GBp, EUR, JPY, SGD, HKD, AUD, CAD, CHF.');
  }
  return input as Currency;
}

function exchangeFormatter(timezone: unknown): Intl.DateTimeFormat {
  if (typeof timezone !== 'string' || timezone.length === 0 || timezone.length > 100 || timezone !== timezone.trim()) {
    throw new Error('Missing or invalid exchange timezone.');
  }
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    throw new Error('Missing or invalid exchange timezone.');
  }
}

function exchangeDate(formatter: Intl.DateTimeFormat, timestampMs: number): string {
  const parts = formatter.formatToParts(timestampMs);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function validTimestamp(input: unknown, latestMs: number): input is number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input > 0 && input * 1_000 <= latestMs;
}

function positiveFinite(input: unknown): input is number {
  return typeof input === 'number' && Number.isFinite(input) && input > 0;
}

function validPrices(open: unknown, high: unknown, low: unknown, close: unknown): boolean {
  return positiveFinite(open) && positiveFinite(high) && positiveFinite(low) && positiveFinite(close)
    && low <= open && open <= high && low <= close && close <= high;
}

function fetchedTime(value: unknown, now: number): number {
  if (typeof value !== 'string') throw new Error('Snapshot fetchedAt must be a canonical UTC ISO timestamp.');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time < 0 || new Date(time).toISOString() !== value) {
    throw new Error('Snapshot fetchedAt must be a canonical UTC ISO timestamp.');
  }
  if (time > now) throw new Error('Snapshot fetchedAt cannot be in the future.');
  return time;
}

/** Strictly validate a stored snapshot before an explicitly requested push. */
export function validateSnapshot(input: unknown, now = Date.now()): Snapshot {
  checkedNow(now);
  if (!record(input) || !exactKeys(input, SNAPSHOT_KEYS)) {
    throw new Error('Snapshot must contain exactly the version 1 daily-history fields.');
  }
  if (input.version !== 1 || input.source !== 'YAHOO' || input.unofficial !== true || input.interval !== '1d') {
    throw new Error('Snapshot must be version 1, unofficial YAHOO, with a 1d interval.');
  }
  const symbol = normalizedSymbol(input.symbol);
  if (input.symbol !== symbol) throw new Error('Snapshot symbol must be uppercase with no surrounding whitespace.');
  const currency = checkedCurrency(input.currency);
  const formatter = exchangeFormatter(input.timezone);
  const fetchedAtMs = fetchedTime(input.fetchedAt, now);
  const fetchedDate = exchangeDate(formatter, fetchedAtMs);
  const currentDate = exchangeDate(formatter, now);
  if (!Array.isArray(input.bars) || input.bars.length < 12 || input.bars.length > 20) {
    throw new Error('Snapshot must contain 12–20 completed daily sessions.');
  }

  const bars: Bar[] = [];
  for (const candidate of input.bars) {
    if (!record(candidate) || !exactKeys(candidate, BAR_KEYS)) {
      throw new Error('Each snapshot bar must contain exactly timestamp, date, open, high, low, and close.');
    }
    if (!validTimestamp(candidate.timestamp, fetchedAtMs)) {
      throw new Error('Snapshot bar timestamp must be positive Unix seconds no later than fetchedAt.');
    }
    const date = exchangeDate(formatter, candidate.timestamp * 1_000);
    if (typeof candidate.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.date) || candidate.date !== date) {
      throw new Error('Snapshot bar date must match its timestamp in the exchange timezone.');
    }
    if (date >= currentDate || date >= fetchedDate) {
      throw new Error('Snapshot bars must precede both the fetch date and current date in the exchange timezone.');
    }
    if (!validPrices(candidate.open, candidate.high, candidate.low, candidate.close)) {
      throw new Error('Snapshot OHLC prices must be finite and positive, with low ≤ open/close ≤ high.');
    }
    const previous = bars.at(-1);
    if (previous && (candidate.timestamp <= previous.timestamp || date <= previous.date)) {
      throw new Error('Snapshot bars must be chronological, with one bar per exchange-local session date.');
    }
    bars.push({
      timestamp: candidate.timestamp,
      date,
      open: candidate.open as number,
      high: candidate.high as number,
      low: candidate.low as number,
      close: candidate.close as number,
    });
  }

  return {
    version: 1,
    source: 'YAHOO',
    unofficial: true,
    interval: '1d',
    symbol,
    currency,
    timezone: input.timezone as string,
    fetchedAt: input.fetchedAt as string,
    bars,
  };
}

/**
 * Fetch once with no retries. Invalid/missing quote rows, today's exchange-local
 * session, and future sessions are excluded; insufficient history is an error.
 */
export async function fetchHistory(
  symbol: string,
  count = 20,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<Snapshot> {
  checkedNow(now);
  const requestedSymbol = normalizedSymbol(symbol);
  if (!Number.isInteger(count) || count < 12 || count > 20) {
    throw new Error('Daily history count must be an integer from 12 to 20.');
  }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(requestedSymbol)}?range=3mo&interval=1d`;
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'TimesGateChartPrototype/0.1' },
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
  } catch {
    throw new Error('Yahoo daily-history request failed or timed out. Check network access and try again.');
  }
  if (!response.ok) {
    throw new Error(`Yahoo daily-history request failed (HTTP ${response.status}).`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Yahoo returned invalid JSON for daily history.');
  }
  if (!record(body) || !record(body.chart) || body.chart.error != null
      || !Array.isArray(body.chart.result) || body.chart.result.length !== 1 || !record(body.chart.result[0])) {
    throw new Error('Yahoo returned no usable daily-history result.');
  }
  const result = body.chart.result[0];
  if (!record(result.meta)) throw new Error('Yahoo daily-history metadata is missing.');
  if (normalizedSymbol(result.meta.symbol) !== requestedSymbol) {
    throw new Error('Yahoo returned a different symbol from the one requested.');
  }
  const currency = checkedCurrency(result.meta.currency);
  const formatter = exchangeFormatter(result.meta.exchangeTimezoneName);
  if (result.meta.dataGranularity !== undefined && result.meta.dataGranularity !== '1d') {
    throw new Error('Yahoo returned a non-daily interval.');
  }
  if (!Array.isArray(result.timestamp) || !record(result.indicators)
      || !Array.isArray(result.indicators.quote) || result.indicators.quote.length !== 1
      || !record(result.indicators.quote[0])) {
    throw new Error('Yahoo daily timestamps or raw OHLC quotes are missing.');
  }
  const quote = result.indicators.quote[0];
  if (!Array.isArray(quote.open) || !Array.isArray(quote.high) || !Array.isArray(quote.low) || !Array.isArray(quote.close)) {
    throw new Error('Yahoo raw open, high, low, and close arrays are required.');
  }
  const currentDate = exchangeDate(formatter, now);
  const byDate = new Map<string, Bar>();
  for (let index = 0; index < result.timestamp.length; index += 1) {
    const timestamp: unknown = result.timestamp[index];
    if (!validTimestamp(timestamp, now)) continue;
    const date = exchangeDate(formatter, timestamp * 1_000);
    if (date >= currentDate) continue;
    const open: unknown = quote.open[index];
    const high: unknown = quote.high[index];
    const low: unknown = quote.low[index];
    const close: unknown = quote.close[index];
    if (!validPrices(open, high, low, close)) continue;
    const previous = byDate.get(date);
    // In a malformed repeated daily session, keep its latest valid timestamp.
    if (!previous || timestamp >= previous.timestamp) {
      byDate.set(date, { timestamp, date, open: open as number, high: high as number, low: low as number, close: close as number });
    }
  }
  const available = [...byDate.values()].sort((left, right) => left.timestamp - right.timestamp);
  if (available.length < count) {
    throw new Error(`Yahoo returned ${available.length} valid completed daily sessions; ${count} are required. No chart was created.`);
  }
  return validateSnapshot({
    version: 1,
    source: 'YAHOO',
    unofficial: true,
    interval: '1d',
    symbol: requestedSymbol,
    currency,
    timezone: result.meta.exchangeTimezoneName,
    fetchedAt: new Date(now).toISOString(),
    bars: available.slice(-count),
  }, now);
}

/**
 * Cache age only: stale means fetched more than 24 hours ago, not that the last
 * session is more than 24 hours old. Source-session age stays visible separately
 * and can be older over weekends, holidays, or a provider delay.
 */
export function isSnapshotStale(snapshot: Snapshot, now = Date.now()): boolean {
  checkedNow(now);
  return now - fetchedTime(snapshot.fetchedAt, now) > DAY_MS;
}
