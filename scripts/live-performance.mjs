import { fileURLToPath, pathToFileURL } from 'node:url';
import { MonthlyRecords } from './price-tracking-records.mjs';
import { onTimeForecast } from '../shared/premarket.js';
import { validDate } from '../shared/trading-calendar.js';
import { readStart } from './taiex.mjs';
import { direction, isDirection } from '../shared/daily-model.js';
import { isTradingDate, shiftDate, symbols, taipeiClock } from './price-tracking-market.mjs';

export async function livePerformance(records, start, end, targets = symbols) {
  let days = 0, complete = 0, timely = 0;
  const versions = new Map();
  for (let date = start; date <= end; date = shiftDate(date, 1)) {
    if (!await isTradingDate(date)) continue;
    days++;
    let count = 0;
    for (const stock of targets) {
      const row = await records.get(date, stock);
      if (!onTimeForecast(row, date)) continue;
      count++;
      const version = row.model_version || '未記版本';
      if (!versions.has(version)) versions.set(version, { onTime: 0, scored: 0, abs: 0, pct: 0, normalized: 0, correct: 0, classified: 0 });
      const result = versions.get(version);
      result.onTime++;
      if (!(Number(row.actual_close) > 0)) continue;
      const error = Math.abs(Number(row.forecast_close) - Number(row.actual_close));
      result.abs += error;
      result.scored++;
      if (!(Number(row.previous_close) > 0)) continue;
      result.pct += 100 * error / Number(row.previous_close);
      result.normalized++;
      if (!isDirection(row.forecast_direction)) continue;
      result.classified++;
      if (direction(Number(row.actual_close) - Number(row.previous_close)) === row.forecast_direction) result.correct++;
    }
    timely += count;
    if (count === targets.length) complete++;
  }
  return { days, complete, timely, versions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [start, end] = process.argv.slice(2);
  const { date: today, hour } = taipeiClock();
  const cutoff = hour < 9 ? shiftDate(today, -1) : today;
  if (!validDate(start) || !validDate(end) || start < '2026-11-17' || end < start || end > cutoff) {
    throw new Error(`用法：node scripts/live-performance.mjs 起日 迄日，範圍為 2026-11-17 至 ${cutoff}`);
  }
  const records = new MonthlyRecords(fileURLToPath(new URL('../data/daily-price-tracking', import.meta.url)));
  const average = (sum, n, unit) => n ? (sum / n).toFixed(3) + unit : '—';
  const first = await readStart();
  const groups = [{ label: '六檔個股', targets: symbols, from: start, unit: '元' }];
  if (first && first <= end) groups.push({ label: '大盤', targets: ['TAIEX'], from: first > start ? first : start, unit: '點' });
  for (const { label, targets, from, unit } of groups) {
    const { days, complete, timely, versions } = await livePerformance(records, from, end, targets);
    console.log(`${from} ～ ${end}：${label}準時完成 ${complete}/${days} 個交易日，準時 ${timely}/${days * targets.length} 筆。`);
    for (const [version, r] of versions) {
      console.log(`${version}：準時 ${r.onTime}，已配對收盤 ${r.scored}，平均絕對誤差 ${average(r.abs, r.scored, unit)}，占昨收 ${average(r.pct, r.normalized, '%')}，方向命中 ${r.correct}/${r.classified}（${average(100 * r.correct, r.classified, '%')}）。`);
    }
  }
  if (!first || first > end) console.log('此區間尚未啟用大盤盤前追蹤。');
}
