import { access, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { isTradingDate, shiftDate } from './price-tracking-market.mjs';

const archive = new URL('../data/taiex.js', import.meta.url);
const require = createRequire(import.meta.url);
const fields = ['日期', '開盤指數', '最高指數', '最低指數', '收盤指數'];

export function parseMonth(payload, month) {
  if (payload.stat !== 'OK' || !Array.isArray(payload.data) || !Array.isArray(payload.fields)) {
    throw new Error('TWSE 大盤月報無有效資料 ' + month);
  }
  const columns = fields.map(field => payload.fields.indexOf(field));
  if (columns.includes(-1)) throw new Error('TWSE 大盤月報缺少欄位');
  return payload.data.map(row => {
    const [roc, ...values] = columns.map(i => row[i]);
    const match = /^(\d{2,3})\/(\d\d)\/(\d\d)$/.exec(roc);
    const date = match && (Number(match[1]) + 1911) + '-' + match[2] + '-' + match[3];
    const prices = values.map(value => Number(String(value).replaceAll(',', '')));
    const [open, high, low, close] = prices;
    if (!date || date.slice(0, 7) !== month || shiftDate(date, 0) !== date || !prices.every(v => Number.isFinite(v) && v > 0) ||
        low > Math.min(open, close) || high < Math.max(open, close)) throw new Error('TWSE 大盤資料異常 ' + roc);
    return { date, open, high, low, close };
  });
}

export async function loadArchive() {
  const filename = fileURLToPath(archive);
  await access(archive);
  delete require.cache[filename];
  return require(filename);
}

async function fetchMonth(month) {
  const url = new URL('https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST');
  url.search = new URLSearchParams({ date: month.replace('-', '') + '01', response: 'json' });
  const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error('TWSE HTTP ' + response.status);
  return parseMonth(await response.json(), month);
}

export async function updateArchive(start, end, persist = true) {
  const existing = await loadArchive().catch(err => { if (err.code === 'ENOENT') return []; throw err; });
  const byDate = new Map(existing.map(row => [row.date, row]));
  for (let first = start.slice(0, 7) + '-01'; first <= end; first = shiftDate(first, 32).slice(0, 7) + '-01') {
    for (const bar of await fetchMonth(first.slice(0, 7))) {
      if (bar.date >= start && bar.date <= end) byDate.set(bar.date, bar);
    }
    if (first.slice(0, 7) !== end.slice(0, 7)) await new Promise(resolve => setTimeout(resolve, 800));
  }
  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!persist) return bars;
  const tmp = new URL('taiex.js.tmp', archive);
  const rows = bars.map(bar => JSON.stringify(bar)).join(',\n');
  await writeFile(tmp, '(function (bars) {\n  if (typeof module === "object" && module.exports) module.exports = bars;\n  else window.taiexHistory = bars;\n})([\n' + rows + '\n]);\n');
  await rename(tmp, archive);
  return bars;
}

// 更新跨月斷檔。舊日期的補抓只需查該月。
export async function barsThrough(date, persist = true) {
  const bars = await loadArchive();
  if (bars.some(bar => bar.date === date)) return bars.filter(bar => bar.date <= date);
  const last = bars.at(-1)?.date;
  const start = last && last < date ? shiftDate(last, 1) : date;
  return (await updateArchive(start, date, persist)).filter(bar => bar.date <= date);
}

export const activationFile = new URL('../data/taiex-start.txt', import.meta.url);
export async function readStart() {
  return readFile(activationFile, 'utf8').then(text => text.trim()).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

export async function activationDate(date, hour) {
  if (hour >= 9) date = shiftDate(date, 1);
  while (!await isTradingDate(date)) date = shiftDate(date, 1);
  return date;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [start, end] = process.argv.slice(2);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  if (![start, end].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && shiftDate(d, 0) === d) || end < start || end > today) {
    throw new Error('用法：node scripts/taiex.mjs YYYY-MM-DD YYYY-MM-DD');
  }
  const bars = await updateArchive(start, end);
  console.log('TAIEX ' + bars.length + ' 筆，截至 ' + bars.at(-1)?.date);
}
