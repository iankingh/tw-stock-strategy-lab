import * as tradingCalendar from '../shared/trading-calendar.js';

export const symbols = ['2312', '2317', '2330', '2603', '3231', '3481'];

const calendarCache = new Map();
const monthlyQuotes = new Map();
const calendarUrl = 'https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule';
export const { shiftDate, taipeiClock } = tradingCalendar;

async function getJSON(url, params = {}) {
  const endpoint = new URL(url);
  endpoint.search = new URLSearchParams(params);
  const response = await fetch(endpoint, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`${endpoint.hostname} HTTP ${response.status}`);
  return response.json();
}

function rocToISO(date) {
  const parts = String(date).trim().replaceAll('/', '').match(/^(\d{2,3})(\d{2})(\d{2})$/);
  return parts ? `${Number(parts[1]) + 1911}-${parts[2]}-${parts[3]}` : null;
}

function price(value) {
  const number = Number(String(value).replaceAll(',', '').trim());
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function loadCalendar(year) {
  const data = await getJSON(calendarUrl, {
    date: `${year}0101`, response: 'json'
  });
  if (!Array.isArray(data.data) || !data.data.length || data.date !== `${year}0101`) {
    throw new Error(`TWSE did not provide the ${year} trading calendar`);
  }
  const overrides = new Map();
  for (const [date, name] of data.data) {
    if (!date.startsWith(`${year}-`) || !name) continue;
    const isTradingDay = /(?:開始|最後|恢復|照常|補行)交易|開市/.test(name);
    overrides.set(date, isTradingDay);
  }
  if (!overrides.size) throw new Error(`TWSE ${year} calendar has no valid dates`);
  return overrides;
}

export async function isTradingDate(date) {
  const published = tradingCalendar.isTradingDate(date);
  if (published !== null) return published;

  const year = date.slice(0, 4);
  if (!calendarCache.has(year)) {
    calendarCache.set(year, loadCalendar(year));
  }
  const overrides = await calendarCache.get(year);
  return overrides.get(date) ?? tradingCalendar.isWeekday(date);
}

export async function previousTradingDate(date) {
  let previous = shiftDate(date, -1);
  while (!await isTradingDate(previous)) previous = shiftDate(previous, -1);
  return previous;
}

export async function finMindPrices(stock, startDate, endDate) {
  const data = await getJSON('https://api.finmindtrade.com/api/v4/data', {
    dataset: 'TaiwanStockPrice', data_id: stock, start_date: startDate, end_date: endDate
  });
  if (data.msg !== 'success' || !Array.isArray(data.data)) throw new Error(`FinMind returned no valid dataset for ${stock}`);
  const quotes = new Map();
  for (const row of data.data) {
    const close = price(row.close);
    if (String(row.stock_id) === stock && row.date >= startDate && row.date <= endDate && close !== null) {
      quotes.set(row.date, close);
    }
  }
  return quotes;
}

export async function latestTWSEPrices(date) {
  const data = await getJSON('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
  if (!Array.isArray(data)) throw new Error('TWSE OpenAPI did not return a list of stock quotes');
  const quotes = new Map();
  for (const row of data) {
    const close = price(row.ClosingPrice);
    if (rocToISO(row.Date) === date && close !== null) quotes.set(String(row.Code), close);
  }
  return quotes;
}

export async function datedTWSEPrices(date) {
  const reportDate = date.replaceAll('-', '');
  const data = await getJSON('https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX', {
    date: reportDate, type: 'ALLBUT0999', response: 'json'
  });
  if (data.stat !== 'OK' || data.date !== reportDate || !Array.isArray(data.tables)) {
    throw new Error(`證交所未提供 ${date} 的每日收盤行情`);
  }
  const table = data.tables.find(t =>
    t.fields?.includes('證券代號') && t.fields.includes('收盤價') && Array.isArray(t.data));
  if (!table) throw new Error('每日收盤行情缺少證券代號或收盤價欄位');
  const codeIndex = table.fields.indexOf('證券代號');
  const closeIndex = table.fields.indexOf('收盤價');
  const quotes = new Map();
  for (const row of table.data) {
    const close = price(row[closeIndex]);
    if (close !== null) quotes.set(String(row[codeIndex]).trim(), close);
  }
  return quotes;
}

async function loadTWSEMonth(stock, date) {
  const data = await getJSON('https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY', {
    date: date.replaceAll('-', ''), stockNo: stock, response: 'json'
  });
  if (data.stat !== 'OK' || !Array.isArray(data.data)) throw new Error(`TWSE did not publish the requested month for ${stock}`);
  const dateIndex = data.fields.indexOf('日期');
  const closeIndex = data.fields.indexOf('收盤價');
  if (dateIndex < 0 || closeIndex < 0) throw new Error('TWSE date or close field is missing');
  const quotes = new Map();
  for (const row of data.data) {
    const tradeDate = rocToISO(row[dateIndex]);
    const close = price(row[closeIndex]);
    if (tradeDate && close !== null) quotes.set(tradeDate, close);
  }
  return quotes;
}

export async function historicalTWSEClose(stock, date) {
  const key = `${stock}:${date.slice(0, 7)}`;
  if (!monthlyQuotes.has(key)) monthlyQuotes.set(key, loadTWSEMonth(stock, date));
  return (await monthlyQuotes.get(key)).get(date);
}
