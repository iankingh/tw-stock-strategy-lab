import { isPremarketHour, onTimeForecast, premarketStartHour } from '../shared/premarket.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { appendFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { barsThrough, readStart, activationDate, activationFile } from './taiex.mjs';
import { firstPathDate, pathCalendar, matchesDaily } from '../shared/five-day.js';
import { forecastGaps, readEdition, saveEdition } from './published-paths.mjs';
import { direction } from '../shared/daily-model.js';
import { defaultMAPeriod, forecastClosePath, version as forecastVersion } from '../shared/forecast-model.js';
import { MonthlyRecords } from './price-tracking-records.mjs';
import {
  datedTWSEPrices, finMindPrices, historicalTWSEClose, isTradingDate, latestTWSEPrices, previousTradingDate, shiftDate, symbols, taipeiClock
} from './price-tracking-market.mjs';

import { validDate } from '../shared/trading-calendar.js';

export { onTimeForecast, validDate };

const recordsDirectory = fileURLToPath(new URL('../data/daily-price-tracking', import.meta.url));
const indexStart = await readStart();
export function trackingSymbols(date, start = indexStart) {
  return start && date >= start ? [...symbols, 'TAIEX'] : symbols;
}

async function forecastFor(stock, previous, persist, expected) {
  const index = stock === 'TAIEX';
  const series = index
    ? new Map((await barsThrough(previous, persist)).map(row => [row.date, row.close]))
    : await finMindPrices(stock, shiftDate(previous, -120), previous);
  const dates = [...series.keys()].sort();
  if (dates.length < 21 || dates.at(-1) !== previous) {
    throw new Error(`needs 21 daily records through ${previous}`);
  }
  const closes = dates.slice(-21).map((date) => Number(series.get(date).toFixed(2)));
  const previousClose = closes.at(-1);
  const pathCloses = forecastClosePath(closes, 5, defaultMAPeriod);
  const forecastClose = pathCloses[0];
  return {
    forecast_close: forecastClose.toFixed(2), previous_close: previousClose.toFixed(2),
    forecast_direction: direction(forecastClose - previousClose), model_version: forecastVersion,
    path_closes: pathCloses, history_through: previous,
    complete_window: !expected || expected.every(day => series.has(day)), priceMethod: 'scenario'
  };
}

async function collectForecasts(date, targets, persist = true) {
  if (!targets.length) return [];
  const previous = await previousTradingDate(date);
  const expected = [previous];
  if (date >= firstPathDate) {
    while (expected.length < 21) expected.push(await previousTradingDate(expected.at(-1)));
  }
  const results = await Promise.allSettled(targets.map(symbol => forecastFor(symbol, previous, persist, expected)));
  const forecasts = [];
  const errors = [];
  for (const [i, result] of results.entries()) {
    const stock = targets[i];
    if (result.status === 'fulfilled') forecasts.push([stock, result.value]);
    else errors.push(`- ${stock}（${stock === 'TAIEX' ? '證交所大盤日 K' : 'FinMind'}）：${result.reason.message}`);
  }
  if (errors.length) await summary(`${date} 盤前行情或預測計算失敗\n\n${errors.join('\n')}\n`);
  return forecasts;
}

async function officialCloses(date, targets, preferLatest, allowFinMind, persist = true) {
  const stocks = targets.filter(code => code !== 'TAIEX');
  const sourceErrors = [];
  let latest = new Map();
  if (preferLatest && stocks.length) {
    latest = await latestTWSEPrices(date).catch((error) => {
      sourceErrors.push(`- 證交所最新行情 OpenAPI：${error.message}`);
      return new Map();
    });
  }

  let daily = new Map();
  const missing = stocks.filter(code => !latest.has(code));
  if (missing.length) {
    try {
      daily = await datedTWSEPrices(date);
      const found = missing.filter(code => daily.has(code));
      await summary(`${date} 證交所每日收盤行情取得 ${found.length}/${missing.length} 檔個股。`);
    } catch (error) {
      await summary(`${date} 證交所每日收盤行情：${error.message}。轉查個股月報。`);
    }
  }
  const results = [];
  for (const stock of targets) {
    let close = latest.get(stock) ?? daily.get(stock);
    let source = 'TWSE';
    if (stock === 'TAIEX') {
      const bars = await barsThrough(date, persist).catch(error => {
        sourceErrors.push(`- TAIEX 證交所大盤月報：${error.message}`);
        return [];
      });
      close = bars.find(bar => bar.date === date)?.close;
    } else if (close === undefined) {
      close = await historicalTWSEClose(stock, date).catch((error) => {
        sourceErrors.push(`- ${stock} 證交所個股月報：${error.message}`);
        return undefined;
      });
    }
    if (stock !== 'TAIEX' && close === undefined && allowFinMind) {
      source = 'FinMind';
      close = await finMindPrices(stock, date, date)
        .then((quotes) => quotes.get(date))
        .catch((error) => {
          sourceErrors.push(`- ${stock} FinMind：${error.message}`);
          return undefined;
        });
    }
    if (close === undefined) {
      sourceErrors.push(`- ${stock} 仍缺少指定交易日的收盤價。`);
      continue;
    }
    if (source === 'FinMind') console.log(`${date} ${stock} close collected from FinMind`);
    results.push([stock, {
      actual_close: close.toFixed(2), actual_recorded_at: taipeiClock().timestamp
    }]);
  }
  if (sourceErrors.length) await summary(`${date} 收盤來源查詢紀錄\n\n${sourceErrors.join('\n')}`);
  return results;
}

// 依 runner 實際啟動的台灣時間決定要等哪個交易時段。
const closeStartHour = 17;
const standbyHours = { forecast: premarketStartHour, retry: closeStartHour };

export async function standbyTask(now) {
  const slot = Object.entries(standbyHours).find(([, hour]) => now.hour >= hour - 2 && now.hour < hour);
  if (!slot || !await isTradingDate(now.date)) return null;
  const [mode] = slot;
  return { date: now.date, mode };
}

export async function waitForCollection(date, mode, clock = taipeiClock, delay = sleep) {
  const now = clock();
  if (!Object.hasOwn(standbyHours, mode) || !validDate(date) || date > now.date ||
      (mode === 'forecast' && now.date !== date) || !await isTradingDate(date)) {
    throw new Error(`無法為 ${date} 待命：${now.timestamp}`);
  }
  const time = String(standbyHours[mode]).padStart(2, '0') + ':00';
  const target = Date.parse(`${date}T${time}:00+08:00`);
  const remaining = target - Date.parse(now.iso);
  if (remaining > 2 * 60 * 60 * 1000) throw new Error(`尚未進入 ${date} 的待命時段`);
  if (remaining > 0) {
    await summary(`台灣時間 ${now.timestamp} 開始待命，目標為 ${date} ${time}。`);
    await delay(remaining);
  }
  const wake = clock();
  if (Date.parse(wake.iso) < target || (mode === 'forecast' && wake.date !== date)) {
    throw new Error(`${date} 待命結束時間異常：${wake.timestamp}`);
  }
  await summary(`台灣時間 ${wake.timestamp} 結束待命，交由正式工作核對 ${date} 的${mode === 'forecast' ? '盤前預測' : '收盤行情'}。`);
}

export async function recoveryTask(records, now, start = indexStart) {
  if (isPremarketHour(now.hour)) {
    if (!await isTradingDate(now.date)) return null;
    const { daily, paths } = await forecastGaps(records, now.date, trackingSymbols(now.date, start));
    const missing = [...new Set([...daily, ...paths])];
    return missing.length ? { mode: 'forecast', date: now.date, missing } : null;
  }
  const date = now.hour >= closeStartHour && await isTradingDate(now.date)
    ? now.date : await previousTradingDate(now.date);
  const missing = [];
  for (const symbol of trackingSymbols(date, start)) {
    if (!hasClose(await records.get(date, symbol))) missing.push(symbol);
  }
  return missing.length ? { mode: 'retry', date, missing } : null;
}

export async function runForecast(records, date, started, collect = collectForecasts, clock = taipeiClock, start = indexStart) {
  const symbols = trackingSymbols(date, start);
  const edition = date >= firstPathDate ? await readEdition(records, date) : {};
  const gaps = await forecastGaps(records, date, symbols, edition);
  const targets = [...new Set([...gaps.daily, ...gaps.paths])];
  if (!targets.length) return summary(date + ' 所有適用的盤前預測已齊。');
  if (gaps.daily.length) await summary(date + ' 單日預測待補：' + gaps.daily.join('、'));
  if (gaps.paths.length) await summary(date + ' 五日預估待補：' + gaps.paths.join('、'));
  if (started.date !== date || !isPremarketHour(started.hour)) {
    throw new Error(`${date} 盤前工作於台灣時間 ${started.timestamp} 啟動，超出 06:00 至 09:00 前的寫入時段，本次未開始抓取行情。`);
  }
  const needsCollection = targets.filter(code => gaps.daily.includes(code) || !Object.hasOwn(edition, code));
  const forecasts = needsCollection.length ? await collect(date, needsCollection) : [];
  const pending = [];
  for (const [code, values] of forecasts) {
    if (!gaps.paths.includes(code) || Object.hasOwn(edition, code)) continue;
    try {
      const daily = gaps.daily.includes(code) ? values : await records.get(date, code);
      if (daily.model_version !== values.model_version || Number(daily.previous_close) !== Number(values.previous_close)) {
        throw new Error('重跑的輸入或模型版本與已發布單日紀錄不符');
      }
      const { dates, previous } = pathCalendar(date);
      if (!values.complete_window) throw new Error('缺少連續 21 個交易日收盤');
      if (values.history_through !== previous) throw new Error('行情截止日與交易日曆不符');
      const targets = [{ date, close: Number(daily.forecast_close), method: values.priceMethod }];
      for (let i = 1; i < 5; i++) {
        targets.push({ date: dates[i], close: values.path_closes[i], method: values.priceMethod });
      }
      pending.push({ stock_id: code, trade_date: date, history_through: previous,
        model_version: forecastVersion, daily_model_version: daily.model_version, direction: daily.forecast_direction, targets });
    } catch (error) {
      await summary(date + ' ' + code + ' 五日預估失敗：' + error.message);
    }
  }
  const recorded = clock();
  if (recorded.date !== date || !isPremarketHour(recorded.hour)) {
    throw new Error(`${date} 盤前預測於台灣時間 ${recorded.timestamp} 才完成，超出寫入時段，預測留白。`);
  }
  for (const [code, values] of forecasts) {
    if (gaps.daily.includes(code)) await records.update(date, code, { ...values, forecast_at: recorded.timestamp });
  }
  await records.save();
  let added = 0;
  for (const candidate of pending) {
    const path = { ...candidate, generated_at: recorded.timestamp };
    if (matchesDaily(path, await records.get(date, path.stock_id))) {
      edition[path.stock_id] = path;
      added++;
    }
  }
  // 發布檔已落盤但索引寫入曾失敗時，只修復索引。
  if (added || gaps.paths.some(code => Object.hasOwn(edition, code))) await saveEdition(records, date, edition);
  const remaining = await forecastGaps(records, date, symbols);
  await summary(`${date} 單日預測已齊 ${symbols.length - remaining.daily.length}/${symbols.length}。`);
  if (date >= firstPathDate) await summary(`五日預估已齊 ${symbols.length - remaining.paths.length}/${symbols.length}，逐檔核對五個目標日與第 1 天 CSV。`);
  const failures = [];
  if (remaining.daily.length) failures.push('盤前預測待補：' + remaining.daily.join('、'));
  if (remaining.paths.length) failures.push('五日預估待補：' + remaining.paths.join('、'));
  if (failures.length) throw new Error(date + ' ' + failures.join('。'));

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
    const symbols = trackingSymbols(date, start);
    const gaps = await forecastGaps(records, date, symbols);
    message = `單日預測完成 ${symbols.length - gaps.daily.length}/${symbols.length}。`;
    if (date >= firstPathDate) message += ` 五日預估完成 ${symbols.length - gaps.paths.length}/${symbols.length}。`;
    const issues = [];
    if (gaps.daily.length) issues.push('單日缺漏標的：' + gaps.daily.join('、'));
    if (gaps.paths.length) issues.push('五日缺漏標的：' + gaps.paths.join('、'));
    if (issues.length) { failure = issues.join('。'); message += '\n\n' + failure; }
  }

  await summary(`## ${date} 盤前預測檢查\n\n${message}\n`);
  if (failure) throw new Error(failure);
}

function hasClose(row) {
  const price = Number(row?.actual_close);
  return Number.isFinite(price) && price > 0;
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
  if (mode === 'wait-for-premarket') return waitForCollection(requestedDate, 'forecast');
  if (mode === 'wait-for-collection') return waitForCollection(requestedDate, option);
  if (mode === 'check-recovery') {
    const now = taipeiClock();
    const records = new MonthlyRecords(recordsDirectory);
    await summary(`行情備援實際啟動時間（台灣）：${now.timestamp}`);
    const standby = await standbyTask(now);
    if (standby) {
      await summary(`${standby.date} 已安排${standby.mode === 'forecast' ? ' 06:00 盤前預測' : ' 17:00 收盤補抓'}。`);
      if (process.env.GITHUB_OUTPUT) {
        await appendFile(process.env.GITHUB_OUTPUT, `wait_date=${standby.date}\nwait_mode=${standby.mode}\n`);
        // 已啟動的舊版工作只認得盤前的 standby_date。
        if (standby.mode === 'forecast') await appendFile(process.env.GITHUB_OUTPUT, `standby_date=${standby.date}\n`);
      }
    }
    const task = await recoveryTask(records, now);
    if (!task) return summary(standby ? '上一個交易日的收盤價已齊。' : '無需補跑。');
    await summary(`${task.date} 缺${task.mode === 'forecast' ? '單日或五日盤前預測' : '收盤價'}：${task.missing.join('、')}。`);
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `trade_date=${task.date}\nmode=${task.mode}\n`);
    }
    return;
  }
  if (mode === 'check-paths') {
    if (!validDate(requestedDate) || requestedDate < firstPathDate || requestedDate > taipeiClock().date || !await isTradingDate(requestedDate)) throw new Error('無效的五日核對日期');
    const records = new MonthlyRecords(recordsDirectory);
    const targets = trackingSymbols(requestedDate);
    const gaps = await forecastGaps(records, requestedDate, targets);
    if (gaps.daily.length || gaps.paths.length) throw new Error(`單日缺漏：${gaps.daily.join('、') || '無'}。五日缺漏：${gaps.paths.join('、') || '無'}。`);
    await summary(`${requestedDate} 核對通過：${targets.length} 個標的、${targets.length * 5} 個目標價，第 1 天與正式 CSV 的價格、方向、版本一致。`);
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
  if (mode === 'forecast') await summary(`盤前工作實際啟動時間（台灣）：${now.timestamp}，目標交易日 ${date}。`);
  if (mode === 'forecast' && date !== now.date) {
    throw new Error('Forecasts can only be recorded on their target trading date');
  }
  if (mode !== 'forecast' && date === now.date && now.hour < closeStartHour) {
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
      const missing = rows => targets.filter(code => !rows.some(([stock]) => stock === code)).join('、') || '無';
      throw new Error(`${date} 行情驗證缺漏。預測輸入：${missing(forecasts)}。證交所收盤：${missing(closes)}。`);
    }
    console.log(`${date}: verified ${forecasts.length} forecasts and ${closes.length} dated TWSE closes; CSV not modified`);
    return;
  }

  const records = new MonthlyRecords(recordsDirectory);
  if (mode === 'forecast') {
    if (date >= firstPathDate && process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `path_date=${date}\n`);
    }
    return runForecast(records, date, now);
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
