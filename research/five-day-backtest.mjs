import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { symbols } from '../scripts/price-tracking-market.mjs';
import { loadArchive } from '../scripts/taiex.mjs';
import { features, direction, predictClose } from '../shared/daily-model.js';
import { train } from './train.mjs';
import stocks from '../scripts/daily-model-parameters.json' with { type: 'json' };
import index from '../scripts/taiex-model-parameters.json' with { type: 'json' };

const history = (await readFile(new URL('history.csv', import.meta.url), 'utf8')).trim().split(/\r?\n/);
if (history.shift() !== ['date', ...symbols].join(',')) throw new Error('行情表頭異常');
const rows = history.map(line => line.split(','));
const dates = rows.map(row => row[0]);
if (dates.at(-1) !== '2026-11-17') throw new Error('行情期間異常');
const archive = new Map((await loadArchive()).map(bar => [bar.date, bar.close]));
const instruments = [...symbols, 'TAIEX'];
const series = Object.fromEntries(symbols.map((id, i) => [id, rows.map(row => Number(row[i + 1]))]));
series.TAIEX = dates.map(date => archive.get(date));
if (series.TAIEX.some(n => !(n > 0))) throw new Error('缺大盤行情');
const period = date => date < '2025' ? 'train' : date < '2026' ? 'validation' : 'holdout';

function samples(prices, horizon) {
  const groups = { train: [], validation: [], holdout: [] };
  for (let base = 20; base + horizon < dates.length; base++) {
    const end = base + horizon;
    const split = period(dates[base + 1]);
    if (period(dates[end]) !== split) continue;
    const window = prices.slice(base - 20, base + 1);
    const previous = window[20], actual = prices[end];
    if (window.some(n => !(n > 0)) || !(actual > 0)) continue;
    groups[split].push({ input: features(window), previous, actual, label: direction(actual - previous), returnPct: 100 * (actual / previous - 1) });
  }
  return groups;
}

function metrics(rows, model) {
  let abs = 0, pct = 0;
  for (const row of rows) {
    const error = Math.abs(predictClose(model, row.input, row.previous) - row.actual);
    abs += error;
    pct += 100 * error / row.previous;
  }
  return { n: rows.length, mae: abs / rows.length, pct: pct / rows.length };
}

const models = Object.fromEntries(instruments.map(id => [id, []]));
const report = ['# 五個交易日收盤價格回測', '',
  '2023–2024 年訓練，2025 年驗證，2026 年截至 11 月 17 日驗收。特徵只使用基準日以前（含當日）的連續 21 筆收盤；發布日及目標日須在同一期間。第 1 天採用已部署的正式單日價格方法，第 2 至 5 天分別訓練累積報酬。每個天期只在驗證期及保留期的誤差均嚴格低於基準時採用迴歸。六檔個股等權選模，大盤獨立選模。', '',
  '誤差為平均絕對誤差（個股為元、大盤為點），百分比以基準日收盤為分母。差距為迴歸減去基準的百分點。', '',
  '| 天期 | 標的 | 期間 | 筆數 | 基準誤差 | 基準 % | 迴歸誤差 | 迴歸 % | 差距 | 採用 |', '|---:|---|---|---:|---:|---:|---:|---:|---:|---|'];
for (let h = 1; h <= 5; h++) {
  const results = {};
  for (const id of instruments) {
    const data = samples(series[id], h);
    const fitted = train(data.train);
    const candidate = { priceMethod: 'ridge', center: fitted.center, scale: fitted.scale, ridge: fitted.ridge };
    const scores = {};
    for (const split of ['validation', 'holdout']) {
      scores[split] = [metrics(data[split], { priceMethod: 'previous' }), metrics(data[split], candidate)];
    }
    results[id] = { candidate, scores };
  }
  for (const group of [symbols, ['TAIEX']]) {
    const wins = ['validation', 'holdout'].every(split => group.reduce((sum, id) => {
      const [base, ridge] = results[id].scores[split];
      return sum + (ridge.pct - base.pct);
    }, 0) < 0);
    const method = h === 1 ? (group === symbols ? stocks : index).priceMethod : wins ? 'ridge' : 'previous';
    for (const id of group) {
      const { candidate, scores } = results[id];
      if (h > 1) models[id].push(method === 'ridge' ? candidate : { priceMethod: 'previous' });
      for (const split of ['validation', 'holdout']) {
        const [base, ridge] = scores[split];
        report.push('| ' + [h,id,split === 'validation' ? '驗證' : '保留',base.n,base.mae.toFixed(3),base.pct.toFixed(3),
          ridge.mae.toFixed(3),ridge.pct.toFixed(3),(ridge.pct-base.pct).toFixed(3),method === 'ridge' ? '迴歸' : '基準收盤'].join(' | ') + ' |');
      }
    }
  }
}
const version = 'five-day-v1-' + createHash('sha256').update(JSON.stringify([stocks.version,index.version,models])).digest('hex').slice(0,10);
report.splice(2, 0, '部署版本 `' + version + '`。', '');
const markdown = report.join('\n') + '\n';
if (process.argv.includes('--write')) {
  await writeFile(new URL('../scripts/five-day-parameters.json', import.meta.url), JSON.stringify({ version, models }, null, 2) + '\n');
  await writeFile(new URL('five-day-results.md', import.meta.url), markdown);
} else process.stdout.write(markdown);
