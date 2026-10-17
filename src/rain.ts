// Fixed public Singapore demo region; no user/device location lookup is performed.
/**
 * Data-only Open-Meteo precipitation-probability cache for approximate Yishun
 * coordinates. This ensemble estimate is independent of the NEA forecast and
 * Sembawang station observations. No device calls or credentials are used.
 *
 * Source definitions verified on 2026-10-16:
 * https://open-meteo.com/en/docs#hourly-parameter-definition
 * https://open-meteo.com/en/licence
 */

export const RAIN_REFRESH_MS = 15 * 60_000;
export const RAIN_STALE_AFTER_MS = 30 * 60_000;
export const RAIN_MAX_RESPONSE_BYTES = 1_024 * 1_024;
export const RAIN_ENDPOINT = 'https://api.open-meteo.com/v1/forecast?latitude=1.418&longitude=103.839&hourly=precipitation_probability&timezone=Asia%2FSingapore&forecast_days=2';
export const RAIN_SOURCE = Object.freeze({
  name: 'Open-Meteo.com',
  url: 'https://open-meteo.com/',
  documentationUrl: 'https://open-meteo.com/en/docs#hourly-parameter-definition',
  licenceUrl: 'https://open-meteo.com/en/licence',
  dataLicence: 'CC BY 4.0',
  location: 'Yishun',
  latitude: 1.418,
  longitude: 103.839,
  timezone: 'Asia/Singapore',
  spatialResolutionKm: 27,
  definition: 'Ensemble probability of precipitation exceeding 0.1 mm during the displayed clock hour; approximate 27 km resolution.',
  intervalMeaning: 'Each source timestamp ends the preceding one-hour interval. This is not a rolling next-60-minute forecast.',
} as const);

export type RainConfig = { requestTimeoutMs?: number };
export type RainDependencies = { fetcher?: typeof fetch; clock?: () => number };
export type RainView = Readonly<{
  source: 'Open-Meteo.com';
  timezone: 'Asia/Singapore';
  location: 'Yishun';
  probability: number | null;
  validFrom: string | null;
  validTo: string | null;
  /** Successful retrieval time, not the forecast issue/model initialization time. */
  fetchedAt: string | null;
  stale: boolean;
  status: 'OK' | 'STALE' | 'NO DATA';
  error: string | null;
}>;

const HOUR_MS = 3_600_000;
const UTC_OFFSET_MS = 8 * HOUR_MS;
const MIN_DATE = Date.UTC(2000, 0, 1);
const MAX_DATE = 8_640_000_000_000_000 - UTC_OFFSET_MS - HOUR_MS;
const REQUEST_ERROR = 'Open-Meteo data unavailable or invalid; any retained probability keeps its original interval and retrieval time.';
const CURRENT_HOUR_ERROR = 'Open-Meteo has no probability for the current clock hour.';
type Slot = Readonly<{ end: number; probability: number | null }>;
type Series = Readonly<{ slots: readonly Slot[]; fetchedAt: number }>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function referenceTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_DATE || value > MAX_DATE) throw new Error('Invalid rain reference time.');
  return value;
}
function iso(time: number): string { return new Date(time).toISOString(); }

function hourlyTimestamp(value: unknown): number {
  // The API's ISO timestamps omit the offset. Accept only hourly boundaries and
  // explicitly apply its separately validated Singapore UTC+08:00 offset.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(value)) {
    throw new Error('Invalid hourly rain timestamp.');
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  if (year < 2000 || month < 1 || month > 12 || day < 1
    || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23) {
    throw new Error('Invalid hourly rain timestamp.');
  }
  const time = Date.UTC(year, month - 1, day, hour) - UTC_OFFSET_MS;
  if (!Number.isSafeInteger(time) || time < MIN_DATE || time > MAX_DATE) throw new Error('Invalid hourly rain timestamp.');
  return time;
}

function parseSeries(value: unknown, fetchedAt: number): Series {
  if (!record(value) || value.error === true || value.timezone !== 'Asia/Singapore'
    || typeof value.latitude !== 'number' || !Number.isFinite(value.latitude)
    || typeof value.longitude !== 'number' || !Number.isFinite(value.longitude)
    // Returned coordinates identify the model grid cell, not the requested
    // point. Allow a coarse nearby cell but reject a different location.
    || Math.abs(value.latitude - RAIN_SOURCE.latitude) > 0.5
    || Math.abs(value.longitude - RAIN_SOURCE.longitude) > 0.5
    || value.utc_offset_seconds !== 28_800 || !record(value.hourly_units)
    || value.hourly_units.time !== 'iso8601' || value.hourly_units.precipitation_probability !== '%'
    || !record(value.hourly) || !Array.isArray(value.hourly.time)
    || !Array.isArray(value.hourly.precipitation_probability)) {
    throw new Error('Invalid hourly rain feed.');
  }
  const times = value.hourly.time;
  const probabilities = value.hourly.precipitation_probability;
  // The fixed request asks for two days. Allow a small bounded envelope, with
  // gaps represented as missing slots, never bridged or interpolated locally.
  if (times.length < 1 || times.length > 72 || probabilities.length !== times.length) {
    throw new Error('Invalid hourly rain series.');
  }
  const slots: Slot[] = [];
  for (let i = 0; i < times.length; i++) {
    const end = hourlyTimestamp(times[i]);
    const probability: unknown = probabilities[i];
    if ((i > 0 && end <= slots[i - 1].end)
      || (probability !== null && (typeof probability !== 'number' || !Number.isFinite(probability)
        || probability < 0 || probability > 100))) {
      throw new Error('Invalid hourly rain series.');
    }
    slots.push({ end, probability });
  }
  // generationtime_ms is request processing duration, not an issue timestamp.
  // There is no trustworthy issue time in this API response to manufacture.
  return { slots, fetchedAt };
}

export class RainCache {
  #requestTimeoutMs: number;
  #fetcher: typeof fetch;
  #clock: () => number;
  #series?: Series;
  #failed = false;
  #nextAt = 0;
  #inFlight?: Promise<void>;
  #timer?: ReturnType<typeof setTimeout>;
  #running = false;
  #generation = 0;
  #controllers = new Set<AbortController>();

  constructor(config: RainConfig = {}, dependencies: RainDependencies = {}) {
    const timeout = config.requestTimeoutMs ?? 10_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error('Invalid rain request timeout.');
    this.#requestTimeoutMs = timeout;
    this.#fetcher = dependencies.fetcher ?? fetch;
    this.#clock = dependencies.clock ?? Date.now;
  }

  async #request(): Promise<unknown> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        void reader?.cancel().catch(() => {});
        reject(new Error('Rain request cancelled or timed out.'));
      }, { once: true });
      timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    });
    const work = (async () => {
      const response = await this.#fetcher(RAIN_ENDPOINT, {
        headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'error',
      });
      if (controller.signal.aborted || !response.ok || !response.body
        || Number(response.headers.get('Content-Length') ?? 0) > RAIN_MAX_RESPONSE_BYTES) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Rain request failed.');
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0;
      let text = '';
      while (true) {
        const chunk = await reader.read();
        if (controller.signal.aborted) throw new Error('Rain request cancelled.');
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > RAIN_MAX_RESPONSE_BYTES) {
          controller.abort();
          throw new Error('Rain response exceeded its byte limit.');
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode()) as unknown;
    })();
    try { return await Promise.race([work, cancelled]); }
    catch { throw new Error('Open-Meteo request failed or timed out.'); }
    finally {
      if (timer) clearTimeout(timer);
      this.#controllers.delete(controller);
      // A malformed stream/UTF-8 payload must not leave the response consuming
      // resources after failure. Cancellation after successful completion is safe.
      void reader?.cancel().catch(() => {});
    }
  }

  /** One shared request per 15 minutes, including failed requests and HTTP 429s. */
  refresh(): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    const startedAt = referenceTime(this.#clock());
    if (startedAt < this.#nextAt) return Promise.resolve();
    this.#nextAt = startedAt + RAIN_REFRESH_MS;
    const generation = this.#generation;
    const flight = (async () => {
      try {
        const data = await this.#request();
        if (generation !== this.#generation) return;
        const fetchedAt = referenceTime(this.#clock());
        const series = parseSeries(data, fetchedAt);
        this.#series = series;
        this.#failed = false;
      } catch {
        if (generation === this.#generation) this.#failed = true;
      } finally {
        if (generation === this.#generation) {
          this.#nextAt = Math.max(this.#nextAt, referenceTime(this.#clock()) + RAIN_REFRESH_MS);
        }
      }
    })();
    this.#inFlight = flight.finally(() => { this.#inFlight = undefined; });
    return this.#inFlight;
  }

  view(now = this.#clock()): RainView {
    referenceTime(now);
    const end = Math.floor((now + UTC_OFFSET_MS) / HOUR_MS) * HOUR_MS - UTC_OFFSET_MS + HOUR_MS;
    // Source time 00:00 describes 23:00–00:00. Exact hourly boundaries advance
    // immediately to the next slot, even without a network refresh.
    const slot = this.#series?.slots.find(entry => entry.end === end);
    const probability = slot?.probability ?? null;
    const stale = probability === null || this.#failed || !this.#series
      || now < this.#series.fetchedAt || now - this.#series.fetchedAt >= RAIN_STALE_AFTER_MS;
    return Object.freeze({
      source: 'Open-Meteo.com', timezone: 'Asia/Singapore', location: 'Yishun', probability,
      validFrom: slot ? iso(slot.end - HOUR_MS) : null,
      validTo: slot ? iso(slot.end) : null,
      fetchedAt: this.#series ? iso(this.#series.fetchedAt) : null,
      stale,
      status: probability === null ? 'NO DATA' : stale ? 'STALE' : 'OK',
      error: this.#failed ? REQUEST_ERROR : this.#series && probability === null ? CURRENT_HOUR_ERROR : null,
    });
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const generation = this.#generation;
    const tick = async () => {
      await this.refresh().catch(() => {});
      if (!this.#running || generation !== this.#generation) return;
      this.#timer = setTimeout(tick, Math.max(1, this.#nextAt - referenceTime(this.#clock())));
      this.#timer.unref?.();
    };
    void tick();
  }

  stop(): void {
    this.#running = false;
    this.#generation++;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const controller of this.#controllers) controller.abort();
  }
}
