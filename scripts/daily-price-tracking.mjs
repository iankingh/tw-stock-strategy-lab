import { onTimeForecast } from '../shared/premarket.js';
import { appendFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import indexParameters from './taiex-model-parameters.json' with { type: 'json' };
import { barsThrough, readStart, activationDate, activationFile } from './taiex.mjs';
import parameters from './daily-model-parameters.json' with { type: 'json' };
import { features, predictDaily } from '../shared/daily-model.js';
import { MonthlyRecords } from './price-tracking-records.mjs';
import {
  finMindPrices, historicalTWSEClose, isTradingDate, latestTWSEPrices, previousTradingDate, shiftDate, symbols, taipeiClock
} from './price-tracking-market.mjs';

import { validDate } from '../shared/trading-calendar.js';

export { onTimeForecast, validDate };

const recordsDirectory = fileURLToPath(new URL('../data/daily-price-tracking', import.meta.url));
const indexStart = await readStart();
export function trackingSymbols(date, start = indexStart) {
  return start && date >= start ? [...symbols, 'TAIEX'] : symbols;
}

async function forecastFor(stock, previous, persist) {
  const index = stock === 'TAIEX';
  const deployment = index ? indexParameters : parameters;
  const series = index
    ? new Map((await barsThrough(previous, persist)).map(row => [row.date, row.close]))
    : await finMindPrices(stock, shiftDate(previous, -120), previous);
  const dates = [...series.keys()].sort();
  if (dates.length < 21 || dates.at(-1) !== previous) {
    throw new Error(`needs 21 daily records through ${previous}`);
  }
  const closes = dates.slice(-21).map((date) => Number(series.get(date).toFixed(2)));
  const previousClose = closes.at(-1);
  const model = { ...deployment.models[stock], priceMethod: deployment.priceMethod, directionMethod: deployment.directionMethod };
  const prediction = predictDaily(model, features(closes), previousClose);
  return {
    forecast_close: prediction.close.toFixed(2), previous_close: previousClose.toFixed(2),
    forecast_direction: prediction.direction, model_version: deployment.version
  };
}

async function collectForecasts(date, targets, persist = true) {
  if (!targets.length) return [];
  const previous = await previousTradingDate(date);
  const results = await Promise.allSettled(targets.map((symbol) => forecastFor(symbol, previous, persist)));
  return results.flatMap((result, index) => {
    const stock = targets[index];
    if (result.status === 'fulfilled') return [[stock, result.value]];
    console.warn(`${date} ${stock} forecast unavailable: ${result.reason.message}`);
    return [];
  });
}

async function officialCloses(date, targets, preferLatest, allowFinMind, persist = true) {
  let latest = new Map();
  if (preferLatest && targets.some(code => code !== 'TAIEX')) {
    latest = await latestTWSEPrices(date).catch((error) => {
      console.warn(`${date} TWSE OpenAPI: ${error.message}`);
      return new Map();
    });
  }

  const results = [];
  for (const stock of targets) {
    let close = latest.get(stock);
    let source = 'TWSE';
    if (stock === 'TAIEX') {
      const bars = await barsThrough(date, persist).catch(error => {
        console.warn(date + ' TAIEX: ' + error.message);
        return [];
      });
      close = bars.find(bar => bar.date === date)?.close;
    } else if (close === undefined) {
      close = await historicalTWSEClose(stock, date).catch((error) => {
        console.warn(`${date} ${stock} TWSE: ${error.message}`);
        return undefined;
      });
    }
    if (stock !== 'TAIEX' && close === undefined && allowFinMind) {
      source = 'FinMind';
      close = await finMindPrices(stock, date, date)
        .then((quotes) => quotes.get(date))
        .catch((error) => {
          console.warn(`${date} ${stock} FinMind: ${error.message}`);
          return undefined;
        });
    }
    if (close === undefined) {
      console.warn(`${date} ${stock} close not available`);
      continue;
    }
    if (source === 'FinMind') console.log(`${date} ${stock} close collected from FinMind`);
    results.push([stock, {
      actual_close: close.toFixed(2), actual_recorded_at: taipeiClock().timestamp
    }]);
  }
  return results;
}

async function missingForecasts(records, date, start) {
  const targets = [];
  for (const stock of trackingSymbols(date, start)) {
    if (!onTimeForecast(await records.get(date, stock), date)) targets.push(stock);
  }
  return targets;
}

// 以 runner 真正啟動時的台灣日期判斷，允許延遲的夜間事件救回當日盤前預測。
export async function recoveryDate(records, now, start = indexStart) {
  if (now.hour < 7 || now.hour >= 9 || !await isTradingDate(now.date)) return null;
  const missing = await missingForecasts(records, now.date, start);
  return missing.length ? now.date : null;
}

export async function runForecast(records, date, started, collect = collectForecasts, clock = taipeiClock, start = indexStart) {
  const targets = await missingForecasts(records, date, start);
  if (!targets.length) {
    console.log(`${date}: all forecasts already recorded`);
    return;
  }
  if (started.hour < 6 || started.hour >= 9) {
    throw new Error(`${date}: ${targets.length} forecasts missing; job started at ${started.timestamp}, outside the 06:00–09:00 Taiwan pre-market window`);
  }
  const forecasts = await collect(date, targets);
  const recorded = clock();
  if (recorded.date !== date || recorded.hour >= 9) {
    throw new Error(`${date}: forecast calculation finished after the pre-market window`);
  }
  if (!forecasts.length) throw new Error(`${date}: no forecast could be recorded`);
  for (const [stock, values] of forecasts) {
    await records.update(date, stock, { ...values, forecast_at: recorded.timestamp });
  }
  const completed = new Set(forecasts.map(([stock]) => stock));
  const missing = targets.filter(stock => !completed.has(stock));
  await summary(`${date} 新增 ${forecasts.length} 筆盤前預測。${missing.length ? '行情或計算缺漏：' + missing.join('、') : ''}`);
}

async function summary(report) {
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report + '\n');
}

async function auditForecasts(date, now, start = indexStart) {
  let message;
  let failure;
  if (!await isTradingDate(date)) {
    message = '休市日，跳過檢查。';
  } else if (date === now.date && now.hour < 9) {
    message = '盤前預測仍可寫入，請於台灣時間 09:00 後檢查當日紀錄。';
    failure = message;
  } else {
    const records = new MonthlyRecords(recordsDirectory);
    const missing = [];
    for (const stock of trackingSymbols(date, start)) {
      const row = await records.get(date, stock);
      if (!onTimeForecast(row, date)) {
        missing.push(stock);
      }
    }
    const total = trackingSymbols(date, start).length;
    message = `已完成 ${total - missing.length}/${total} 個標的。`;
    if (missing.length) {
      failure = `缺漏標的：${missing.join('、')}。`;
      message = `${message}\n\n${failure}`;
    }
  }

  await summary(`## ${date} 盤前預測檢查\n\n${message}\n`);
  if (failure) throw new Error(failure);
}

function hasClose(row) {
  const price = Number(row?.actual_close);
  return Number.isFinite(price) && price > 0;
}

export async function closeRecoveryDate(records, now, start = indexStart) {
  if (now.hour >= 7 && now.hour < 9) return null;
  const date = now.hour >= 17 && await isTradingDate(now.date)
    ? now.date : await previousTradingDate(now.date);
  for (const symbol of trackingSymbols(date, start)) {
    if (!hasClose(await records.get(date, symbol))) return date;
  }
  return null;
}

export async function runClose(records, date, today, allowFinMind, pendingOnly = false, collect = officialCloses, start = indexStart) {
  const missing = [];
  for (const stock of trackingSymbols(date, start)) {
    const row = await records.get(date, stock);
    if (hasClose(row) || (pendingOnly && !row)) continue;
    missing.push(stock);
    await records.update(date, stock, {});
  }
  const results = await collect(date, missing, date === today, allowFinMind);
  for (const [stock, values] of results) await records.update(date, stock, values);
  if (missing.length) console.log(`${date}: recorded ${results.length} closes, ${missing.length - results.length} pending`);
  return results.length;
}

export async function retryDates(date, includeBacklog) {
  const dates = [];
  if (await isTradingDate(date)) dates.push({ date, pendingOnly: false });
  if (includeBacklog) {
    for (let days = 1; days <= 7; days++) dates.push({ date: shiftDate(date, -days), pendingOnly: true });
  }
  return dates;
}

export async function checkCloses(records, dates, start = indexStart) {
  const missing = [];
  for (const { date, pendingOnly } of dates) {
    for (const stock of trackingSymbols(date, start)) {
      const row = await records.get(date, stock);
      if ((!pendingOnly || row) && !hasClose(row)) {
        missing.push(date + ' ' + stock);
      }
    }
  }
  await summary(missing.length ? '收盤價待補：\n\n' + missing.map(key => '- ' + key).join('\n') : '收盤價檢查完成，無待補紀錄。');
  if (missing.length) throw new Error(`尚缺 ${missing.length} 筆收盤價`);
}

// 排程延遲跨午夜時，收盤任務仍屬於最近一次已到期的台灣晚間排程。
export function closeScheduleDate(now, schedule) {
  const slot = { '0 17 * * *': '17:00', '45 17 * * *': '17:45' }[schedule];
  return slot && now.timestamp.slice(11, 16) < slot ? shiftDate(now.date, -1) : now.date;
}

async function main(mode, requestedDate, option) {
  if (mode === 'check-recovery') {
    const now = taipeiClock();
    const records = new MonthlyRecords(recordsDirectory);
    const premarket = now.hour >= 7 && now.hour < 9;
    const date = premarket ? await recoveryDate(records, now) : await closeRecoveryDate(records, now);
    await summary(`行情備援檢查（台灣）${now.timestamp}，${date ? date + (premarket ? ' 缺盤前預測' : ' 缺收盤價') : '無需補跑'}。`);
    if (date && process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `trade_date=${date}\nmode=${premarket ? 'forecast' : 'retry'}\n`);
    }
    return;
  }
  if (mode === 'activate-index') {
    if (indexStart) return;
    const now = taipeiClock();
    // 首次盤前排程即使延遲啟動，仍從該次應交付日計算。
    const scheduled = ['0 7 * * *', '20 7 * * *'].includes(process.env.ACTION_SCHEDULE);
    const start = await activationDate(now.date, scheduled ? 7 : now.hour);
    await writeFile(activationFile, start + '\n', { flag: 'wx' });
    return summary('大盤盤前準時率自 ' + start + ' 起算。');
  }
  if (!['forecast', 'close', 'retry', 'verify', 'audit', 'check-close'].includes(mode)) throw new Error('Use forecast, close, retry, check-close, verify or audit');
  const now = taipeiClock();
  const scheduledDate = closeScheduleDate(now, process.env.ACTION_SCHEDULE);
  const date = requestedDate || (mode === 'verify' ? await previousTradingDate(now.date) : scheduledDate);
  if (!validDate(date) || date > now.date) throw new Error(`Invalid trading date: ${date}`);
  if (mode === 'audit') return auditForecasts(date, now);
  if (mode === 'check-close') return checkCloses(new MonthlyRecords(recordsDirectory), await retryDates(date, !requestedDate || option === '--backlog'));
  if (mode === 'forecast') await summary(`盤前工作實際啟動時間（台灣）：${now.timestamp}`);
  if (mode === 'forecast' && date !== now.date) {
    throw new Error('Forecasts can only be recorded on their target trading date');
  }
  if (mode !== 'forecast' && date === now.date && now.hour < 17) {
    throw new Error('當日收盤價於台灣時間 17:00 後開放');
  }

  const isOpen = await isTradingDate(date);
  if (!isOpen && mode !== 'retry') {
    console.log(`${date}: market closed`);
    return;
  }
  if (mode === 'verify') {
    const targets = [...symbols, 'TAIEX'];
    const forecasts = await collectForecasts(date, targets, false);
    const closes = await officialCloses(date, targets, date === now.date, false, false);
    if (forecasts.length !== targets.length || closes.length !== targets.length) {
      throw new Error(`Verification incomplete: ${forecasts.length} forecasts and ${closes.length} official closes for ${targets.length} instruments`);
    }
    console.log(`${date}: verified ${forecasts.length} forecasts and ${closes.length} dated TWSE closes; CSV not modified`);
    return;
  }

  const records = new MonthlyRecords(recordsDirectory);
  if (mode === 'forecast') {
    await runForecast(records, date, now);
    await records.save();
    const missing = await missingForecasts(records, date);
    if (missing.length) throw new Error(`${date} 盤前預測待補：${missing.join('、')}`);
    return;
  } else if (mode === 'close') {
    await runClose(records, date, now.date, date < now.date);
    await records.save();
    return checkCloses(records, [{ date, pendingOnly: false }]);
  } else {
    const dates = await retryDates(date, !requestedDate);
    for (const target of dates) await runClose(records, target.date, now.date, true, target.pendingOnly);
    await records.save();
    if (option === '--defer-check' && process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `retry_date=${date}\nretry_scope=${requestedDate ? '' : '--backlog'}\n`);
      return;
    }
    return checkCloses(records, dates);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(...process.argv.slice(2)).catch(async error => {
    await summary('行情工作失敗：' + error.message.replace(/\s+/g, ' ').slice(0, 400));
    process.exitCode = 1;
  });
}
