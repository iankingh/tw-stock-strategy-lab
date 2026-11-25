import { isTradingDate, shiftDate, validDate } from './trading-calendar.js';
import { onTimeForecast } from './premarket.js';

// 線上發布後的第一個交易日，較早的日期只稽核單日紀錄。
export const firstPathDate = '2026-11-25';

/** @param {string} date @param {number} step */
function nextSession(date, step) {
  while (true) {
    date = shiftDate(date, step);
    const open = isTradingDate(date);
    if (open === null) throw new Error('交易日曆尚未涵蓋 ' + date);
    if (open) return date;
  }
}

/** @param {string} date */
export function pathCalendar(date) {
  if (!validDate(date) || !isTradingDate(date)) throw new Error('無效的五日發布日 ' + date);
  const dates = [date];
  while (dates.length < 5) dates.push(nextSession(dates[dates.length - 1], 1));
  return { dates, previous: nextSession(date, -1) };
}

/** @typedef {{date:string,close:number,method:string}} Target */
/** @typedef {{stock_id:string,trade_date:string,generated_at:string,history_through:string,model_version:string,daily_model_version:string,direction:string,targets:Target[]}} ForecastPath */
/** @param {ForecastPath|undefined|null} path @param {import('./types.js').ForecastRecord|undefined|null} row */
export function matchesDaily(path, row) {
  if (!row || !path || !onTimeForecast(row, row.trade_date) || path.trade_date !== row.trade_date ||
      path.stock_id !== row.stock_id || path.daily_model_version !== row.model_version ||
      !path.model_version || path.direction !== row.forecast_direction || !row.forecast_at ||
      typeof path.generated_at !== 'string' || path.generated_at < row.forecast_at ||
      !onTimeForecast({ ...row, forecast_at: path.generated_at }, row.trade_date) ||
      !Array.isArray(path.targets) || path.targets.length !== 5) return false;
  const calendar = pathCalendar(row.trade_date);
  return path.history_through === calendar.previous && path.targets[0]?.close === row.forecast_close &&
    path.targets.every((t, i) => t && t.date === calendar.dates[i] && Number.isFinite(t.close) &&
      t.close > 0 && ['previous', 'ridge', 'scenario'].includes(t.method));
}
