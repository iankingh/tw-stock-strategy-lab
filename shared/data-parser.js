import { validDate } from './trading-calendar.js';
import { isDirection } from './daily-model.js';

/** @typedef {import('./types.js').ForecastRecord} ForecastRecord */
const titles = {
  trade_date: '交易日', stock_id: '股票代號', forecast_close: '預測收盤價', forecast_at: '預測時間',
  actual_close: '實際收盤價', actual_recorded_at: '收盤價取得時間', model_version: '策略版本',
  previous_close: '昨收', forecast_direction: '預測方向'
};
const columns = /** @type {(keyof ForecastRecord)[]} */ (Object.keys(titles));
const required = columns.slice(0, 4);
const supported = new Set(Object.keys(titles));
const aliases = new Map(Object.entries(titles).map(([key, title]) => [title, key]));
const legacy = 'trade_date,stock_id,forecast_close,forecast_at,history_through,previous_close,model_version,actual_close,actual_recorded_at,actual_source';

/** @param {string} csv @returns {string[][]} */
function cells(csv) {
  const rows = [];
  let row = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (csv[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; closed = true; }
      continue;
    }
    if (c === ',' || c === '\n' || c === '\r') {
      row.push(field);
      if (c !== ',') {
        if (row.length > 1 || field !== '') rows.push(row);
        row = [];
        if (c === '\r' && csv[i + 1] === '\n') i++;
      }
      field = '';
      closed = false;
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (closed || c === '"') throw new Error('Invalid CSV quoting');
    else field += c;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (field || closed || row.length) rows.push([...row, field]);
  return rows;
}

/** @param {unknown} value @returns {string|null} */
function valueOrNull(value) {
  const s = String(value ?? '').trim();
  return s === '' || s === '-' || s === 'null' ? null : s;
}

/** @param {unknown} value @returns {number|null} */
function price(value) {
  const s = valueOrNull(value);
  if (s === null) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error('Invalid price: ' + s);
  return n;
}

/** @param {unknown} value @returns {string|null} */
function timestamp(value) {
  return valueOrNull(value)?.replace(/^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)\+08:00$/, '$1 $2') ?? null;
}

/** @param {Record<string, unknown>} raw @returns {ForecastRecord} */
export function normalizeRecord(raw) {
  const day = String(raw.trade_date ?? '');
  const id = valueOrNull(raw.stock_id);
  if (!validDate(day) || !id) {
    throw new Error('Invalid record key: ' + day + ' ' + id);
  }
  const label = valueOrNull(raw.forecast_direction);
  return {
    trade_date: day, stock_id: id, forecast_close: price(raw.forecast_close), forecast_at: timestamp(raw.forecast_at),
    actual_close: price(raw.actual_close), actual_recorded_at: timestamp(raw.actual_recorded_at),
    model_version: valueOrNull(raw.model_version), previous_close: price(raw.previous_close),
    forecast_direction: isDirection(label) ? label : null
  };
}

/** @param {ForecastRecord[]} rows @param {string} [month] */
function checkKeys(rows, month) {
  const seen = new Set();
  for (const row of rows) {
    const key = row.trade_date + ':' + row.stock_id;
    if ((month && row.trade_date.slice(0, 7) !== month) || seen.has(key)) throw new Error('Invalid or duplicate row: ' + key);
    seen.add(key);
  }
}

/** @param {string} csv @param {string} [month] @returns {ForecastRecord[]} */
export function parseCSVToJSON(csv, month) {
  const [header, ...lines] = cells(csv.replace(/^\uFEFF/, ''));
  const keys = (header ?? []).map(h => aliases.get(h) ?? h);
  if (!required.every(k => keys.includes(k)) || new Set(keys).size !== keys.length ||
      (keys.join(',') !== legacy && keys.some(k => !supported.has(k)))) throw new Error('Unexpected CSV header');
  const rows = lines.map(fields => {
    if (fields.length !== keys.length) throw new Error('Invalid CSV row length');
    return normalizeRecord(Object.fromEntries(keys.map((key, i) => [key, fields[i]])));
  });
  checkKeys(rows, month);
  return rows;
}

/** @param {ForecastRecord[]} records @param {string} [month] @returns {string} */
export function formatJSONToCSV(records, month) {
  const rows = records.map(row => normalizeRecord(row));
  checkKeys(rows, month);
  const lines = [Object.values(titles).join(',')];
  for (const row of rows) {
    lines.push(columns.map(key => {
      const v = row[key];
      if (v === null) return '';
      if (typeof v === 'number') return Number(v.toFixed(2)) === v ? v.toFixed(2) : String(v);
      const text = String(v);
      return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
    }).join(','));
  }
  return lines.join('\n') + '\n';
}
