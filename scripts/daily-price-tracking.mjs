import { appendFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import parameters from './daily-model-parameters.json' with { type: 'json' };
import { directions, features, predictDaily } from './daily-model.mjs';
import { MonthlyRecords } from './price-tracking-records.mjs';
import {
  finMindPrices, historicalTWSEClose, isTradingDate, latestTWSEPrices, previousTradingDate, shiftDate, symbols
} from './price-tracking-market.mjs';

const recordsDirectory = fileURLToPath(new URL('../data/daily-price-tracking', import.meta.url));
const timeZone = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

function taipeiClock() {
  const parts = Object.fromEntries(timeZone.formatToParts(new Date()).map(({ type, value }) => [type, value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    date, hour: Number(parts.hour),
    timestamp: `${date} ${parts.hour}:${parts.minute}:${parts.second}`
  };
}

export function validDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && shiftDate(date, 0) === date;
}

async function forecastFor(stock, previous) {
  const series = await finMindPrices(stock, shiftDate(previous, -120), previous);
  const dates = [...series.keys()].sort();
  if (dates.length < 21 || dates.at(-1) !== previous) {
    throw new Error(`needs 21 FinMind records through ${previous}`);
  }
  const closes = dates.map((date) => Number(series.get(date).toFixed(2)));
  const previousClose = closes.at(-1);
  const model = { ...parameters.models[stock], priceMethod: parameters.priceMethod, directionMethod: parameters.directionMethod };
  const prediction = predictDaily(model, features(closes), previousClose);
  return {
    forecast_close: prediction.close.toFixed(2), previous_close: previousClose.toFixed(2),
    forecast_direction: prediction.direction, model_version: parameters.version
  };
}

async function collectForecasts(date, targets) {
  if (!targets.length) return [];
  const previous = await previousTradingDate(date);
  const results = await Promise.allSettled(targets.map((symbol) => forecastFor(symbol, previous)));
  return results.flatMap((result, index) => {
    const stock = targets[index];
    if (result.status === 'fulfilled') return [[stock, result.value]];
    console.warn(`${date} ${stock} forecast unavailable: ${result.reason.message}`);
    return [];
  });
}

async function officialCloses(date, targets, preferLatest, allowFinMind) {
  let latest = new Map();
  if (preferLatest && targets.length) {
    latest = await latestTWSEPrices(date).catch((error) => {
      console.warn(`${date} TWSE OpenAPI: ${error.message}`);
      return new Map();
    });
  }

  const results = [];
  for (const stock of targets) {
    let close = latest.get(stock);
    let source = 'TWSE';
    if (close === undefined) {
      close = await historicalTWSEClose(stock, date).catch((error) => {
        console.warn(`${date} ${stock} TWSE: ${error.message}`);
        return undefined;
      });
    }
    if (close === undefined && allowFinMind) {
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

export async function runForecast(records, date, started, collect = collectForecasts, clock = taipeiClock) {
  const targets = [];
  for (const stock of symbols) {
    if (!(await records.get(date, stock))?.forecast_close) targets.push(stock);
  }
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

export function onTimeForecast(row, date) {
  if (!row || !(Number.isFinite(+row.forecast_close) && +row.forecast_close > 0)) return false;
  const [day, time] = (row.forecast_at || '').split(' ');
  if (day !== date || !/^0[6-8]:[0-5]\d:[0-5]\d$/.test(time)) return false;
  if (!row.model_version?.startsWith('daily-v2-')) return true;
  return Number.isFinite(+row.previous_close) && +row.previous_close > 0 && directions.includes(row.forecast_direction);
}

async function auditForecasts(date, now) {
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
    for (const stock of symbols) {
      const row = await records.get(date, stock);
      if (!onTimeForecast(row, date)) {
        missing.push(stock);
      }
    }
    message = `已完成 ${symbols.length - missing.length}/${symbols.length} 檔。`;
    if (missing.length) {
      failure = `缺漏股票代號：${missing.join('、')}。`;
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

export async function runClose(records, date, today, allowFinMind, pendingOnly = false, collect = officialCloses) {
  const missing = [];
  for (const stock of symbols) {
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

export async function checkCloses(records, dates) {
  const missing = [];
  for (const { date, pendingOnly } of dates) {
    for (const stock of symbols) {
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
    if (mode === 'retry') throw new Error('當日收盤補抓於台灣時間 17:00 後開放');
    console.warn('Today’s closing prices are collected from 17:00 Taiwan time');
    return;
  }

  const isOpen = await isTradingDate(date);
  if (!isOpen && mode !== 'retry') {
    console.log(`${date}: market closed`);
    return;
  }
  if (mode === 'verify') {
    const forecasts = await collectForecasts(date, symbols);
    const closes = await officialCloses(date, symbols, date === now.date, false);
    if (forecasts.length !== symbols.length || closes.length !== symbols.length) {
      throw new Error(`Verification incomplete: ${forecasts.length} forecasts and ${closes.length} official closes for ${symbols.length} stocks`);
    }
    console.log(`${date}: verified ${forecasts.length} forecasts and ${closes.length} dated TWSE closes; CSV not modified`);
    return;
  }

  const records = new MonthlyRecords(recordsDirectory);
  if (mode === 'forecast') {
    await runForecast(records, date, now);
  } else if (mode === 'close') {
    await runClose(records, date, now.date, date < now.date);
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
  await records.save();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(...process.argv.slice(2)).catch(async error => {
    await summary(error.message);
    process.exitCode = 1;
  });
}
