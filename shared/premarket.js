import { isDirection } from './daily-model.js';

/** @typedef {import('./types.js').ForecastRecord} ForecastRecord */

/** @param {ForecastRecord|null|undefined} row @param {string} date @returns {boolean} */
export function onTimeForecast(row, date) {
  if (!row || row.trade_date !== date || row.forecast_close === null || row.forecast_close <= 0 || !Number.isFinite(row.forecast_close)) return false;
  const match = /^(\d{4}-\d\d-\d\d) (0[6-8]:[0-5]\d:[0-5]\d)$/.exec(row.forecast_at ?? '');
  if (match?.[1] !== date) return false;
  if (row.stock_id === 'TAIEX' && !row.model_version?.startsWith('taiex-v1-')) return false;
  // 舊版個股紀錄可能只有價格。現代模型或有方向的紀錄必須可獨立評分。
  if (row.stock_id !== 'TAIEX' && !row.model_version?.startsWith('daily-') && row.forecast_direction === null) return true;
  return row.previous_close !== null && row.previous_close > 0 &&
    isDirection(row.forecast_direction);
}

/** @param {ForecastRecord[]} rows @param {string} date @param {string} code */
export function findPremarketRecord(rows, date, code) {
  const row = rows.find(r => r.trade_date === date && r.stock_id === code);
  if (!row || !onTimeForecast(row, date)) return null;
  return { price: row.forecast_close, time: row.forecast_at?.slice(11), direction: row.forecast_direction ?? '—' };
}
