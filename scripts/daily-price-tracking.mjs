import { fileURLToPath } from 'node:url';
import model from '../forecast-model.js';
import { MonthlyRecords } from './price-tracking-records.mjs';
import {
  finMindPrices, historicalTWSEClose, isTradingDate, latestTWSEPrices, previousTradingDate, shiftDate
} from './price-tracking-market.mjs';

const symbols = ['2312', '2317', '2330', '2603', '3231', '3481'];
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

function validDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && shiftDate(date, 0) === date;
}

async function forecastFor(stock, previous) {
  const series = await finMindPrices(stock, shiftDate(previous, -120), previous);
  const dates = [...series.keys()].sort();
  if (dates.length < model.defaultMAPeriod || dates.at(-1) !== previous) {
    throw new Error(`needs ${model.defaultMAPeriod} FinMind records through ${previous}`);
  }
  const closes = dates.map((date) => Number(series.get(date).toFixed(2)));
  return {
    forecast_close: model.forecastClosePath(closes, 1)[0].toFixed(2),
    model_version: model.version
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

async function runForecast(records, date, started) {
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
  const forecasts = await collectForecasts(date, targets);
  const recorded = taipeiClock();
  if (recorded.date !== date || recorded.hour >= 9) {
    throw new Error(`${date}: forecast calculation finished after the pre-market window`);
  }
  if (!forecasts.length) throw new Error(`${date}: no forecast could be recorded`);
  for (const [stock, values] of forecasts) {
    await records.update(date, stock, { ...values, forecast_at: recorded.timestamp });
  }
  console.log(`${date}: recorded ${forecasts.length} new forecasts`);
}

async function runClose(records, date, today, allowFinMind, pendingOnly = false) {
  const missing = [];
  for (const stock of symbols) {
    const row = await records.get(date, stock);
    if (row?.actual_close || (pendingOnly && !row)) continue;
    missing.push(stock);
    await records.update(date, stock, {});
  }
  const results = await officialCloses(date, missing, date === today, allowFinMind);
  for (const [stock, values] of results) await records.update(date, stock, values);
  if (missing.length) console.log(`${date}: recorded ${results.length} closes, ${missing.length - results.length} pending`);
  return results.length;
}

async function main(mode, requestedDate) {
  if (!['forecast', 'close', 'retry', 'verify'].includes(mode)) throw new Error('Use forecast, close, retry or verify');
  const now = taipeiClock();
  const date = requestedDate || (mode === 'verify' ? await previousTradingDate(now.date) : now.date);
  if (!validDate(date) || date > now.date) throw new Error(`Invalid trading date: ${date}`);
  if (mode === 'forecast' && date !== now.date) {
    throw new Error('Forecasts can only be recorded on their target trading date');
  }
  if (mode !== 'forecast' && date === now.date && now.hour < 17) {
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
    if (isOpen) await runClose(records, date, now.date, true);
    if (!requestedDate) {
      for (let days = 1; days <= 7; days++) {
        await runClose(records, shiftDate(date, -days), now.date, true, true);
      }
    }
  }
  await records.save();
}

await main(process.argv[2], process.argv[3]).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
