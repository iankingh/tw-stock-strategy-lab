import { writeFile } from 'node:fs/promises';
import { finMindPrices, symbols } from '../scripts/price-tracking-market.mjs';

const start = '2023-01-01';
const end = '2026-11-17';
const byStock = new Map();
for (const stock of symbols) {
  const prices = await finMindPrices(stock, start, end);
  if (prices.size < 850 || !prices.has(end)) throw new Error(`Incomplete FinMind history for ${stock}: ${prices.size} rows`);
  byStock.set(stock, prices);
}

const params = new URLSearchParams({ dataset: 'TaiwanStockTradingDate', start_date: start, end_date: end });
const response = await fetch(`https://api.finmindtrade.com/api/v4/data?${params}`, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`FinMind trading dates HTTP ${response.status}`);
const payload = await response.json();
if (payload.msg !== 'success' || !Array.isArray(payload.data)) throw new Error('FinMind trading dates unavailable');
const dates = [...new Set(payload.data.map(row => row.date).filter(date => date >= start && date <= end))].sort();
if (dates.length < 850 || dates.at(-1) !== end) throw new Error('Incomplete trading dates');
const sessions = new Set(dates);
for (const [stock, prices] of byStock) {
  for (const date of prices.keys()) if (!sessions.has(date)) throw new Error(`Unexpected market date ${stock} ${date}`);
}
const rows = dates.map(date => [date, ...symbols.map(stock => byStock.get(stock).get(date) ?? '')].join(','));
await writeFile(new URL('history.csv', import.meta.url), [['date', ...symbols].join(','), ...rows, ''].join('\n'));
console.log(`FinMind: ${dates.length} trading dates (${dates[0]} to ${dates.at(-1)})`);
