// Fixed public Singapore demo region; no user/device location lookup is performed.
import type {RainView} from './rain.ts';
/**
 * Data-only NEA/MSS weather cache. No device calls, credentials, or invented data.
 * The v2 endpoints and their live schema were verified on 2026-10-16 against:
 * https://data.gov.sg/datasets/d_3f9e064e25005b0e42969944ccaf2e7a/view
 * https://data.gov.sg/datasets/d_66b77726bbae1b33f218db60ff5861f0/view
 * https://data.gov.sg/datasets/d_2d3b0c4da128a9a59efca806441e1429/view
 * Forecasts describe Yishun; observations are from nearby Sembawang, not a
 * fictional Yishun sensor. Forecast issue/validity and observation times differ.
 */

export const WEATHER_REFRESH_MS = 5 * 60_000;
export const WEATHER_MAX_RESPONSE_BYTES = 1_024 * 1_024;
export const WEATHER_ENDPOINTS = Object.freeze({
  forecast: 'https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast',
  temperature: 'https://api-open.data.gov.sg/v2/real-time/api/air-temperature',
  humidity: 'https://api-open.data.gov.sg/v2/real-time/api/relative-humidity',
});
export const WEATHER_FIELDS = Object.freeze([
  'heading', 'forecast', 'conditions', 'station', 'valid', 'issued', 'observed', 'status',
  'panelHeading', 'conditionsCompact', 'observedCompact', 'rain', 'rainSource', 'panelStatus',
  'forecastCompact', 'temperatureLarge', 'humidityBrief', 'observationBrief', 'rainLarge', 'rainWindow', 'rainPercent',
] as const);
export type WeatherField = typeof WEATHER_FIELDS[number];
export type WeatherConfig = {
  requestTimeoutMs?: number;
  /** Older observations are delayed and stale even after a fresh fetch. */
  observationDelaySeconds?: number;
  /** Missing successful retrievals for this long is STALE, not source delay. */
  staleAfterSeconds?: number;
};
export type WeatherDependencies = { fetcher?: typeof fetch; clock?: () => number };
export type WeatherForecast = {
  text: string;
  issuedAt: string;
  updatedAt: string;
  validFrom: string;
  validTo: string;
  retrievedAt: string;
};
export type WeatherObservation = {
  temperatureC: number;
  relativeHumidity: number;
  temperatureObservedAt: string;
  humidityObservedAt: string;
  /** The older of the two source times; never a claim of simultaneous readings. */
  observedAt: string;
  retrievedAt: string;
};
export type WeatherView = {
  rain?: RainView;
  area: 'Yishun';
  stationId: 'S80';
  stationName: 'Sembawang';
  stationFullName: 'Sembawang Meteorological Station';
  source: 'NEA';
  timezone: 'Asia/Singapore';
  forecast: WeatherForecast | null;
  observation: WeatherObservation | null;
  stale: boolean;
  delayed: boolean;
  temperatureDelayed: boolean;
  humidityDelayed: boolean;
  forecastStale: boolean;
  observationStale: boolean;
  status: 'OK' | 'DELAYED' | 'STALE' | 'NO DATA';
  error: string | null;
};

const STATION_NAME = 'Sembawang Meteorological Station';
const MIN_DATE = Date.UTC(2000, 0, 1);
const MAX_DATE = 8_640_000_000_000_000;
type SafeConfig = { requestTimeoutMs: number; observationDelayMs: number; staleAfterMs: number };
type Reading = { value: number; timestamp: number };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`Invalid ${label}.`);
  return result;
}
function safeConfig(config: WeatherConfig): SafeConfig {
  return {
    requestTimeoutMs: bounded(config.requestTimeoutMs, 10_000, 1, 30_000, 'weather request timeout'),
    observationDelayMs: bounded(config.observationDelaySeconds, 900, 300, 3_600, 'weather source-delay threshold') * 1_000,
    staleAfterMs: bounded(config.staleAfterSeconds, 600, 300, 3_600, 'weather stale threshold') * 1_000,
  };
}
function referenceTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_DATE || value > MAX_DATE) throw new Error('Invalid weather reference time.');
  return value;
}
function dateMs(value: unknown, latest: number): number {
  // A timezone is mandatory: the host/container timezone must never affect data.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error('Invalid weather source timestamp.');
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) {
    throw new Error('Invalid weather source timestamp.');
  }
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time) || time < MIN_DATE || time > latest) throw new Error('Invalid weather source timestamp.');
  return time;
}
function envelope(value: unknown): Record<string, unknown> {
  // Actual successful v2 responses use code 0 (some documentation examples use 1).
  if (!record(value) || value.code !== 0 || (value.errorMsg !== '' && value.errorMsg != null) || !record(value.data)) {
    throw new Error('NEA returned no usable weather data.');
  }
  return value.data;
}
function iso(time: number): string { return new Date(time).toISOString(); }
function forecastFrom(value: unknown, now: number): WeatherForecast {
  const data = envelope(value);
  if (!Array.isArray(data.area_metadata) || data.area_metadata.filter(item => record(item) && item.name === 'Yishun').length !== 1
    || !Array.isArray(data.items) || data.items.length < 1 || data.items.length > 100) throw new Error('No Yishun forecast.');
  const forecasts = data.items.map(item => {
    if (!record(item) || !record(item.valid_period) || !Array.isArray(item.forecasts)) throw new Error('Invalid Yishun forecast.');
    const matches = item.forecasts.filter(entry => record(entry) && entry.area === 'Yishun');
    if (matches.length !== 1 || !record(matches[0]) || typeof matches[0].forecast !== 'string'
      || !/^[A-Za-z0-9 (),.'/-]{1,100}$/.test(matches[0].forecast) || !matches[0].forecast.trim()) {
      throw new Error('No usable Yishun forecast.');
    }
    const issued = dateMs(item.timestamp, now);
    const updated = dateMs(item.update_timestamp, now);
    const start = dateMs(item.valid_period.start, now + 6 * 3_600_000);
    const end = dateMs(item.valid_period.end, now + 6 * 3_600_000);
    // Revisions can be issued during an already-running validity period. Live
    // NEA data on 2026-10-16 issued at 21:29 still covered 21:00 through 23:00.
    if (updated < issued || start < issued - 6 * 3_600_000 || end <= start || end - start > 6 * 3_600_000
      || end <= issued || start > issued + 6 * 3_600_000) throw new Error('Invalid forecast validity period.');
    return { text: matches[0].forecast.trim().replace(/ +/g, ' '), issuedAt: iso(issued), updatedAt: iso(updated),
      validFrom: iso(start), validTo: iso(end), retrievedAt: iso(now) };
  });
  forecasts.sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return forecasts[0];
}
function observationFrom(value: unknown, kind: 'temperature' | 'humidity', now: number): Reading {
  const data = envelope(value);
  if (data.readingType !== (kind === 'temperature' ? 'DBT 1M F' : 'RH 1M F')
    || data.readingUnit !== (kind === 'temperature' ? 'deg C' : 'percentage')
    || !Array.isArray(data.stations) || !Array.isArray(data.readings) || data.readings.length < 1 || data.readings.length > 100) {
    throw new Error('Invalid Sembawang observation feed.');
  }
  const stations = data.stations.filter(station => record(station) && station.id === 'S80');
  const station = stations[0];
  if (stations.length !== 1 || !record(station) || station.deviceId !== 'S80' || station.name !== STATION_NAME
    || !record(station.location) || typeof station.location.latitude !== 'number' || typeof station.location.longitude !== 'number'
    || !Number.isFinite(station.location.latitude) || !Number.isFinite(station.location.longitude)
    || Math.abs(station.location.latitude - 1.4247) > 0.001 || Math.abs(station.location.longitude - 103.8201) > 0.001) {
    throw new Error('S80 Sembawang station identity could not be verified.');
  }
  const readings = data.readings.map(item => {
    if (!record(item) || !Array.isArray(item.data)) throw new Error('Invalid Sembawang observation.');
    const timestamp = dateMs(item.timestamp, now);
    const matches = item.data.filter(entry => record(entry) && entry.stationId === 'S80');
    if (matches.length !== 1 || !record(matches[0]) || typeof matches[0].value !== 'number' || !Number.isFinite(matches[0].value)
      || matches[0].value < (kind === 'temperature' ? -10 : 0) || matches[0].value > (kind === 'temperature' ? 60 : 100)) {
      throw new Error('No usable S80 Sembawang observation.');
    }
    return { value: matches[0].value, timestamp };
  });
  readings.sort((a, b) => b.timestamp - a.timestamp);
  return readings[0];
}

export class WeatherCache {
  #config: SafeConfig;
  #fetcher: typeof fetch;
  #clock: () => number;
  #forecast?: WeatherForecast;
  #observation?: WeatherObservation;
  #forecastError = false;
  #observationError = false;
  #nextAt = 0;
  #inFlight?: Promise<void>;
  #timer?: ReturnType<typeof setTimeout>;
  #running = false;
  #generation = 0;
  #controllers = new Set<AbortController>();

  constructor(config: WeatherConfig = {}, dependencies: WeatherDependencies = {}) {
    this.#config = safeConfig(config);
    this.#fetcher = dependencies.fetcher ?? fetch;
    this.#clock = dependencies.clock ?? Date.now;
  }

  async #request(url: string): Promise<unknown> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = () => { void reader?.cancel().catch(() => {}); };
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => { aborted(); reject(new Error('Weather request cancelled or timed out.')); }, { once: true });
      timer = setTimeout(() => controller.abort(), this.#config.requestTimeoutMs);
    });
    const work = (async () => {
      const response = await this.#fetcher(url, {
        headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'error',
      });
      if (controller.signal.aborted || !response.ok || !response.body
        || Number(response.headers.get('Content-Length') ?? 0) > WEATHER_MAX_RESPONSE_BYTES) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Weather request failed.');
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0;
      let text = '';
      while (true) {
        const chunk = await reader.read();
        if (controller.signal.aborted) throw new Error('Weather request cancelled.');
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > WEATHER_MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => {});
          controller.abort();
          throw new Error('Weather response exceeded its byte limit.');
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode()) as unknown;
    })();
    try { return await Promise.race([work, cancelled]); }
    catch { throw new Error('NEA weather request failed or timed out.'); }
    finally { if (timer) clearTimeout(timer); this.#controllers.delete(controller); }
  }

  /** At most three requests per five minutes, including errors and HTTP 429s. */
  async refresh(): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    if (referenceTime(this.#clock()) < this.#nextAt) return;
    const generation = this.#generation;
    this.#inFlight = (async () => {
      const [forecastResult, temperatureResult, humidityResult] = await Promise.allSettled([
        this.#request(WEATHER_ENDPOINTS.forecast), this.#request(WEATHER_ENDPOINTS.temperature), this.#request(WEATHER_ENDPOINTS.humidity),
      ]);
      if (generation !== this.#generation) return;
      const now = referenceTime(this.#clock());
      // Independent components retain their own dated last-good snapshot.
      try {
        if (forecastResult.status !== 'fulfilled') throw new Error('Forecast unavailable.');
        const forecast = forecastFrom(forecastResult.value, now);
        if (this.#forecast && (Date.parse(forecast.issuedAt) < Date.parse(this.#forecast.issuedAt)
          || Date.parse(forecast.updatedAt) < Date.parse(this.#forecast.updatedAt))) throw new Error('Forecast timestamp regressed.');
        this.#forecast = forecast;
        this.#forecastError = false;
      } catch { this.#forecastError = true; }
      try {
        if (temperatureResult.status !== 'fulfilled' || humidityResult.status !== 'fulfilled') throw new Error('Observations unavailable.');
        const temperature = observationFrom(temperatureResult.value, 'temperature', now);
        const humidity = observationFrom(humidityResult.value, 'humidity', now);
        if (this.#observation && (temperature.timestamp < Date.parse(this.#observation.temperatureObservedAt)
          || humidity.timestamp < Date.parse(this.#observation.humidityObservedAt))) throw new Error('Observation timestamp regressed.');
        this.#observation = { temperatureC: temperature.value, relativeHumidity: humidity.value,
          temperatureObservedAt: iso(temperature.timestamp), humidityObservedAt: iso(humidity.timestamp),
          observedAt: iso(Math.min(temperature.timestamp, humidity.timestamp)), retrievedAt: iso(now) };
        this.#observationError = false;
      } catch { this.#observationError = true; }
      this.#nextAt = now + WEATHER_REFRESH_MS;
    })().finally(() => { this.#inFlight = undefined; });
    return this.#inFlight;
  }

  view(): WeatherView {
    const now = referenceTime(this.#clock());
    const forecastStale = !this.#forecast || this.#forecastError
      || Date.parse(this.#forecast.validFrom) > now || Date.parse(this.#forecast.validTo) <= now
      || now - Date.parse(this.#forecast.retrievedAt) >= this.#config.staleAfterMs;
    const temperatureDelayed = Boolean(this.#observation
      && now - Date.parse(this.#observation.temperatureObservedAt) > this.#config.observationDelayMs);
    const humidityDelayed = Boolean(this.#observation
      && now - Date.parse(this.#observation.humidityObservedAt) > this.#config.observationDelayMs);
    const delayed = temperatureDelayed || humidityDelayed;
    const observationStale = !this.#observation || this.#observationError || delayed
      || now - Date.parse(this.#observation.retrievedAt) >= this.#config.staleAfterMs;
    const stale = forecastStale || observationStale;
    return {
      area: 'Yishun', stationId: 'S80', stationName: 'Sembawang', stationFullName: STATION_NAME,
      source: 'NEA', timezone: 'Asia/Singapore',
      forecast: this.#forecast ? { ...this.#forecast } : null,
      observation: this.#observation ? { ...this.#observation } : null,
      stale, delayed, temperatureDelayed, humidityDelayed, forecastStale, observationStale,
      status: !this.#forecast && !this.#observation ? 'NO DATA' : stale ? 'STALE' : delayed ? 'DELAYED' : 'OK',
      error: this.#forecastError || this.#observationError ? 'NEA data unavailable or invalid; retaining any dated last-good data.' : null,
    };
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

function sgtParts(timestamp: string): { day: string; time: string } {
  // Singapore has a fixed UTC+08:00 offset. Explicit arithmetic avoids host TZ
  // differences, locale punctuation, and 24:00 formatting on the native display.
  const shifted = new Date(Date.parse(timestamp) + 8 * 3_600_000).toISOString();
  return { day: shifted.slice(8, 10), time: shifted.slice(11, 16) };
}

/** Native polling text fields only. Unknown names fail closed, never traverse objects. */
export function weatherText(view: WeatherView, field: string): string {
  if (!(WEATHER_FIELDS as readonly string[]).includes(field)) throw new Error('Unsupported weather field.');
  switch (field as WeatherField) {
    case 'forecastCompact': return !view.forecast?'NO DATA':view.forecastStale?'STALE':view.forecast.text.toUpperCase();
    case 'temperatureLarge': return view.observation&&!view.observationStale&&view.observation.temperatureC>=0&&view.observation.temperatureC<=99.9
      ? view.observation.temperatureC.toFixed(1) : '...';
    case 'humidityBrief': return !view.observation?'--%':view.observationStale?'STALE':view.observation.temperatureC<0||view.observation.temperatureC>99.9?'RANGE':`${Math.round(view.observation.relativeHumidity)}%`;
    case 'observationBrief': {
      if(!view.observation)return 'Semb. NO DATA';
      const parts=sgtParts(view.observation.observedAt);return `Semb.${parts.day} ${parts.time}`;
    }
    // Preserve the numeric-only 0.4 endpoint until the explicit new layout is applied.
    case 'rainLarge': return view.rain?.status==='OK'&&view.rain.probability!=null ? String(Math.round(view.rain.probability)) : '...';
    case 'rainPercent': return view.rain?.status==='OK'&&view.rain.probability!=null ? `${Math.round(view.rain.probability)}%` : '%';
    case 'rainWindow': return view.rain?.status==='STALE'?'STALE':view.rain?.status!=='OK'||!view.rain?.validFrom||!view.rain?.validTo?'N/A'
      : `${sgtParts(view.rain.validFrom).time.slice(0,2)}-${sgtParts(view.rain.validTo).time.slice(0,2)}`;
    case 'panelHeading': return 'YISHUN 2H';
    case 'conditionsCompact': return view.observation
      ? `${view.observation.temperatureC.toFixed(1)}C ${Math.round(view.observation.relativeHumidity)}% RH` : 'NO OBS DATA';
    case 'observedCompact': { const parts = view.observation ? sgtParts(view.observation.observedAt) : null;
      return parts ? `${parts.day} ${parts.time} SGT` : '-- --:-- SGT'; }
    case 'rain': {
      const rain=view.rain;const probability=rain?.probability==null?'--':String(Math.round(rain.probability));
      const interval=rain?.validFrom&&rain?.validTo?`${sgtParts(rain.validFrom).time.slice(0,2)}-${sgtParts(rain.validTo).time.slice(0,2)}`:'--';
      return `${probability}% ${interval} SGT`;
    }
    case 'rainSource': return 'Open-Meteo.com';
    case 'panelStatus': {
      const nea=view.status==='OK'?'OK':view.status==='NO DATA'?'--':'STALE';
      const om=view.rain?.status==='OK'?'OK':view.rain?.status==='STALE'?'STALE':'--';
      return nea===om?`NEA/OM ${nea}`:`NEA ${nea} OM ${om}`;
    }
    case 'heading': return 'YISHUN';
    case 'forecast': return view.forecast?.text.toUpperCase() ?? 'NO FORECAST';
    case 'conditions': return view.observation
      ? `${view.observation.temperatureC.toFixed(1)}C RH ${view.observation.relativeHumidity.toFixed(1)}%` : 'NO OBS DATA';
    case 'station': return 'S80 SEMBAWANG';
    case 'valid': return view.forecast
      ? `${sgtParts(view.forecast.validFrom).time}-${sgtParts(view.forecast.validTo).time} SGT` : 'VALID -- SGT';
    case 'issued': { const parts = view.forecast ? sgtParts(view.forecast.issuedAt) : null;
      return parts ? `FC ${parts.day} ${parts.time} SGT` : 'FC -- SGT'; }
    case 'observed': { const parts = view.observation ? sgtParts(view.observation.observedAt) : null;
      return parts ? `OBS ${parts.day} ${parts.time} SGT` : 'OBS -- SGT'; }
    case 'status': return view.status === 'OK' ? 'NEA'
      : view.status === 'STALE' && !view.forecastStale && !view.error && view.delayed
        ? `NEA ${view.temperatureDelayed ? 'T' : ''}${view.temperatureDelayed && view.humidityDelayed ? '/' : ''}${view.humidityDelayed ? 'RH' : ''} STALE`
        : `NEA ${view.status}`;
  }
}
