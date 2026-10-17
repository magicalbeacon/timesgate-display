import jpeg from 'jpeg-js';
import { deflateSync } from 'node:zlib';
import type { Snapshot } from './history.ts';
import { isSnapshotStale, validateSnapshot } from './history.ts';
// Original hand-defined 5x7 bitmap glyphs, used to keep the renderer tiny and portable.
const letters: Record<string, string> = {
 ' ': '00000/00000/00000/00000/00000/00000/00000',
 '0':'01110/10001/10011/10101/11001/10001/01110','1':'00100/01100/00100/00100/00100/00100/01110',
 '2':'01110/10001/00001/00010/00100/01000/11111','3':'11110/00001/00001/01110/00001/00001/11110',
 '4':'00010/00110/01010/10010/11111/00010/00010','5':'11111/10000/10000/11110/00001/00001/11110',
 '6':'01110/10000/10000/11110/10001/10001/01110','7':'11111/00001/00010/00100/01000/01000/01000',
 '8':'01110/10001/10001/01110/10001/10001/01110','9':'01110/10001/10001/01111/00001/00001/01110',
 'A':'01110/10001/10001/11111/10001/10001/10001','B':'11110/10001/10001/11110/10001/10001/11110',
 'C':'01111/10000/10000/10000/10000/10000/01111','D':'11110/10001/10001/10001/10001/10001/11110',
 'E':'11111/10000/10000/11110/10000/10000/11111','F':'11111/10000/10000/11110/10000/10000/10000',
 'G':'01111/10000/10000/10111/10001/10001/01111','H':'10001/10001/10001/11111/10001/10001/10001',
 'I':'01110/00100/00100/00100/00100/00100/01110','J':'00111/00010/00010/00010/10010/10010/01100',
 'K':'10001/10010/10100/11000/10100/10010/10001','L':'10000/10000/10000/10000/10000/10000/11111',
 'M':'10001/11011/10101/10101/10001/10001/10001','N':'10001/11001/10101/10011/10001/10001/10001',
 'O':'01110/10001/10001/10001/10001/10001/01110','P':'11110/10001/10001/11110/10000/10000/10000',
 'Q':'01110/10001/10001/10001/10101/10010/01101','R':'11110/10001/10001/11110/10100/10010/10001',
 'S':'01111/10000/10000/01110/00001/00001/11110','T':'11111/00100/00100/00100/00100/00100/00100',
 'U':'10001/10001/10001/10001/10001/10001/01110','V':'10001/10001/10001/10001/10001/01010/00100',
 'W':'10001/10001/10001/10101/10101/10101/01010','X':'10001/10001/01010/00100/01010/10001/10001',
 'Y':'10001/10001/01010/00100/00100/00100/00100','Z':'11111/00001/00010/00100/01000/10000/11111',
 'p':'00000/00000/11110/10001/11110/10000/10000',
 '.':'00000/00000/00000/00000/00000/00110/00110','-':'00000/00000/00000/11111/00000/00000/00000',
 '+':'00000/00100/00100/11111/00100/00100/00000','/':'00001/00010/00010/00100/01000/01000/10000',
 ':':'00000/00110/00110/00000/00110/00110/00000','%':'11001/11010/00100/01000/10110/00110/00000',
 '_':'00000/00000/00000/00000/00000/00000/11111',
 '^':'00100/01010/10001/00000/00000/00000/00000','=':'00000/11111/00000/11111/00000/00000/00000',
};
export const WIDTH = 128, HEIGHT = 128;
export const COLORS = { background: '#03070B', grid: '#1B2B38', white: '#F4F7FA', cyan: '#64DFFF',
  green: '#52F5A0', red: '#FF6B7B', muted: '#8DABBF', amber: '#FFD478' };
function rgb(hex: string): number[] { return [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)); }
export function formatPrice(value: number): string {
  return value.toLocaleString('en-US', { useGrouping:false, minimumFractionDigits: value < 1 ? 4 : 2, maximumFractionDigits: value < 1 ? 4 : 2 });
}
/** The quote and completed daily history are deliberately independent inputs. */
export type PanelInput = {
  symbol: string;
  quote: {
    price: number | null;
    changePercent: number | null;
    asOf: string | null;
    source: 'FINNHUB' | 'YAHOO';
    currency: 'USD' | 'JPY' | null;
    stale: boolean;
    status: string;
    delayed: boolean;
    unofficial: boolean;
  };
  history: { symbol?: string; snapshot?: Snapshot; stale: boolean; error?: string } | undefined;
};
export type RenderedPanel = { rgba: Buffer; jpeg: Buffer; png: Buffer; labels: string[] };

/**
 * All marks are original integer-pixel bitmap primitives. No daily close is ever
 * substituted for a missing quote. History is validated again at this boundary,
 * so stale caches are visible and malformed/current-session bars are not drawn.
 */
export function renderPanel(input: PanelInput, now = Date.now()): RenderedPanel {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) {
    throw new Error('Panel time must be a valid Unix timestamp in milliseconds.');
  }
  const symbol = input.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9^][A-Z0-9.^=_\/-]{0,31}$/.test(symbol)) throw new Error('Invalid panel symbol.');
  const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
  function rect(x: number, y: number, w: number, h: number, color: string) {
    const [r, g, b] = rgb(color);
    for (let yy = Math.max(0, Math.round(y)); yy < Math.min(HEIGHT, Math.round(y + h)); yy++) {
      for (let xx = Math.max(0, Math.round(x)); xx < Math.min(WIDTH, Math.round(x + w)); xx++) {
        const off = (yy * WIDTH + xx) * 4;
        rgba[off] = r; rgba[off + 1] = g; rgba[off + 2] = b; rgba[off + 3] = 255;
      }
    }
  }
  function text(value: string, x: number, y: number, color: string, scale = 1) {
    [...value].forEach((char, index) => {
      const glyph = letters[char];
      if (!glyph) throw new Error('Unsupported panel-label glyph.');
      glyph.split('/').forEach((row, gy) => [...row].forEach((v, gx) => {
        if (v === '1') rect(x + (index * 6 + gx) * scale, y + gy * scale, scale, scale, color);
      }));
    });
  }
  function centered(value: string, y: number, color: string) {
    text(value, Math.floor((WIDTH - (value.length * 6 - 1)) / 2), y, color);
  }

  const quote = input.quote;
  const validSource = quote.source === 'FINNHUB' || quote.source === 'YAHOO';
  const isFx = symbol === 'USD/JPY' || symbol === 'JPY=X';
  const validCurrency = quote.currency === 'USD' || (isFx && quote.currency === 'JPY');
  const hasQuote = validSource && validCurrency
    && typeof quote.price === 'number' && Number.isFinite(quote.price) && quote.price > 0;
  const quoteTime = typeof quote.asOf === 'string' ? Date.parse(quote.asOf) : NaN;
  const validQuoteTime = Number.isFinite(quoteTime) && quoteTime >= 0 && quoteTime <= now;
  // Cache/market-age policy belongs to the quote adapter; preserve its stale flag.
  const delayed = quote.delayed || quote.source === 'YAHOO';
  const quoteStale = hasQuote && (quote.stale || !validQuoteTime);
  const price = hasQuote ? isFx ? quote.price!.toFixed(3) : formatPrice(quote.price!) : 'NO QUOTE';
  const validChange = hasQuote && typeof quote.changePercent === 'number' && Number.isFinite(quote.changePercent);
  const percentage = validChange
    ? `${quote.changePercent! > 0 ? '+' : ''}${quote.changePercent!.toFixed(2)}%`
    : 'CHG N/A';
  const change = percentage.length <= 13 ? percentage : 'CHG OUT OF RANGE';
  const changeColor = !validChange || quote.changePercent === 0 ? COLORS.muted
    : quote.changePercent! > 0 ? COLORS.green : COLORS.red;
  const quoteISO = validQuoteTime ? new Date(quoteTime).toISOString() : null;
  const quoteDateLabel = quoteISO ? `Q UTC ${quoteISO.slice(0, 10)}` : 'Q UTC UNKNOWN';
  const source = validSource ? quote.source : 'UNKNOWN';
  const quoteTimeLabel = `${quoteISO ? quoteISO.slice(11, 16) : '--:--'} ${source}`;

  const priceOnly = ['VWRA', 'VWRA.L', 'VALL', 'VALU.L', 'SPCX', 'USD/JPY', 'JPY=X'].includes(symbol)
    || (quote.source === 'YAHOO' && !input.history?.snapshot);
  let snapshot: Snapshot | undefined;
  let historyProblem: string | undefined;
  if (!priceOnly && input.history?.snapshot) {
    try {
      const checked = validateSnapshot(input.history.snapshot, now);
      if (checked.symbol !== symbol || checked.currency !== 'USD' || quote.currency === 'JPY') {
        throw new Error('History must match the displayed symbol and USD quote currency.');
      }
      snapshot = checked;
    } catch (error) {
      historyProblem = error instanceof Error ? error.message : 'Invalid daily history.';
    }
  }
  const chartStale = !!snapshot && (!!input.history?.stale || !!input.history?.error || isSnapshotStale(snapshot, now));
  const chartDateLabel = snapshot ? `C1D THRU ${snapshot.bars.at(-1)!.date}`
    : priceOnly ? 'C1D NOT REQUESTED' : 'CHART NO DATA';
  const chartMessage = priceOnly ? `${symbol === 'VWRA.L' ? 'VWRA' : symbol} PRICE ONLY` : 'CHART NO DATA';
  const attribution = snapshot ? 'C YAHOO UNOFFICIAL'
    : quote.source === 'YAHOO' ? 'Q YAHOO UNOFFICIAL' : 'C NO HISTORY';
  const flags = [
    !hasQuote ? 'Q NO DATA' : quoteStale && chartStale ? 'Q+C STALE' : quoteStale ? 'Q STALE' : '',
    chartStale && !(hasQuote && quoteStale) ? 'C STALE' : '',
    delayed ? 'DELAY' : '',
  ].filter(Boolean);
  // The only long combination is an absent quote plus stale history plus delay.
  const statusLabel = flags.join(' ').length <= 20 ? flags.join(' ') : 'NO Q C STALE DELAY';
  const footer = statusLabel || (snapshot ? 'QUOTE + DAILY' : priceOnly ? 'PRICE ONLY' : 'QUOTE ONLY');

  rect(0, 0, WIDTH, HEIGHT, COLORS.background);
  text(symbol.length <= 20 ? symbol : `${symbol.slice(0, 17)}...`, 4, 3, COLORS.cyan);
  if (price.length <= (quote.currency === 'JPY' ? 7 : 8)) text(price, 4, 15, hasQuote ? COLORS.white : COLORS.amber, 2);
  else text(price.length <= (quote.currency === 'JPY' ? 13 : 16) ? price : 'OUT OF RANGE', 4, 19, hasQuote ? COLORS.white : COLORS.amber);
  if (quote.currency === 'USD') text('USD', 106, 21, COLORS.muted);
  else if (validCurrency && quote.currency === 'JPY') text('JPY/USD', 86, 21, COLORS.muted);
  text(change, 4, 33, changeColor);
  if (snapshot) {
    const bars = snapshot.bars;
    const low = Math.min(...bars.map(bar => bar.low));
    const high = Math.max(...bars.map(bar => bar.high));
    // Normalising first also keeps finite, extremely large valid prices safe.
    const normalizedLow = low / high;
    const normalizedSpan = Math.max(1 - normalizedLow, 0.02);
    const min = normalizedLow - normalizedSpan * 0.06;
    const max = 1 + normalizedSpan * 0.06;
    const y = (value: number) => Math.round(44 + (max - value / high) / (max - min) * 32);
    for (const yy of [44, 60, 76]) rect(4, yy, 120, 1, COLORS.grid);
    const step = 120 / bars.length;
    const bodyWidth = Math.max(2, Math.floor(step * 0.55));
    bars.forEach((bar, i) => {
      const x = Math.round(4 + (i + 0.5) * step);
      const color = bar.close > bar.open ? COLORS.green : bar.close < bar.open ? COLORS.red : COLORS.muted;
      rect(x, y(bar.high), 1, Math.max(1, y(bar.low) - y(bar.high) + 1), color);
      rect(x - Math.floor(bodyWidth / 2), Math.min(y(bar.open), y(bar.close)), bodyWidth,
        Math.max(1, Math.abs(y(bar.open) - y(bar.close)) + 1), color);
    });
  } else {
    rect(4, 44, 120, 1, COLORS.grid);
    centered(chartMessage.length <= 20 ? chartMessage : 'PRICE ONLY', 53, COLORS.muted);
    centered(priceOnly ? validCurrency ? quote.currency === 'JPY' ? 'JPY PER USD' : 'USD QUOTE'
      : 'CURRENCY UNKNOWN' : 'OHLC UNAVAILABLE', 65, COLORS.muted);
    rect(4, 76, 120, 1, COLORS.grid);
  }
  text(chartDateLabel, 4, 80, chartStale ? COLORS.amber : COLORS.muted);
  text(quoteDateLabel, 4, 90, quoteStale || !hasQuote ? COLORS.amber : COLORS.muted);
  text(quoteTimeLabel, 4, 100, COLORS.muted);
  text(attribution, 4, 110, COLORS.muted);
  text(footer, 4, 120, flags.length ? COLORS.amber : COLORS.muted);

  // Full browser-readable provenance supplements the deliberately short LCD lines.
  const labels = [symbol, price, validCurrency ? quote.currency === 'JPY' ? 'JPY PER USD' : 'USD' : 'CURRENCY UNKNOWN', change, chartDateLabel, quoteDateLabel, quoteTimeLabel, attribution, footer,
    `QUOTE SOURCE: ${source}${source === 'YAHOO' ? ' DELAYED' : delayed ? ' DELAY' : ''}${quote.unofficial || source === 'YAHOO' ? ' UNOFFICIAL' : ''}`,
    `QUOTE AS OF: ${quoteISO ?? 'UNKNOWN'}`,
    `QUOTE STATUS: ${quote.status}`,
  ];
  if (!snapshot) labels.push(chartMessage);
  if (quoteStale) labels.push('QUOTE STALE');
  if (chartStale) labels.push('CHART STALE');
  if (historyProblem) labels.push(`CHART REJECTED: ${historyProblem}`);
  if (input.history?.error && !priceOnly) labels.push(`HISTORY ERROR: ${input.history.error}`);
  return { rgba, jpeg: jpeg.encode({ data: rgba, width: WIDTH, height: HEIGHT }, 95).data, png: encodePNG(rgba), labels };
}
function crc32(buffer:Buffer):number {
  let crc=0xffffffff;
  for(const byte of buffer){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
function chunk(type:string,data:Buffer):Buffer {
  const name=Buffer.from(type);const size=Buffer.alloc(4);size.writeUInt32BE(data.length);
  const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));
  return Buffer.concat([size,name,data,crc]);
}
function encodePNG(rgba:Buffer):Buffer {
  const header=Buffer.alloc(13);header.writeUInt32BE(WIDTH,0);header.writeUInt32BE(HEIGHT,4);header[8]=8;header[9]=6;
  const pixels=Buffer.alloc(HEIGHT*(1+WIDTH*4));
  for(let y=0;y<HEIGHT;y++)rgba.copy(pixels,y*(1+WIDTH*4)+1,y*WIDTH*4,(y+1)*WIDTH*4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
