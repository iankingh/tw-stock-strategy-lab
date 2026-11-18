import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { directions, direction, features, predictDaily } from '../scripts/daily-model.mjs';
import { loadArchive } from '../scripts/taiex.mjs';
import { train } from './train.mjs';

const through = '2026-11-17';
const bars = (await loadArchive()).filter(row => row.date >= '2023-01-01' && row.date <= through);
const sessions = (await readFile(new URL('history.csv', import.meta.url), 'utf8')).trimEnd().split('\n').slice(1).map(line => line.slice(0, 10));
if (sessions.at(-1) !== through || sessions.length !== bars.length ||
    bars.some((row, i) => row.date !== sessions[i] || !(row.close > 0))) throw new Error('大盤行情與封存交易日不一致');

const closes = [];
const periods = { train: [], validation: [], holdout: [] };
for (const { date, close: actual } of bars) {
  if (closes.length >= 21) {
    const previous = closes.at(-1);
    const period = date < '2025' ? 'train' : date < '2026' ? 'validation' : 'holdout';
    periods[period].push({ previous, actual, input: features(closes), label: direction(actual - previous), returnPct: 100 * (actual / previous - 1) });
  }
  closes.push(actual);
}

const fitted = train(periods.train);
function evaluate(samples, priceMethod, directionMethod) {
  let points = 0, pct = 0, hits = 0;
  const classes = Object.fromEntries(directions.map(d => [d, { hits: 0, total: 0 }]));
  for (const row of samples) {
    const p = predictDaily({ ...fitted, priceMethod, directionMethod }, row.input, row.previous);
    const abs = Math.abs(p.close - row.actual);
    points += abs;
    pct += 100 * abs / row.previous;
    const hit = Number(p.direction === row.label);
    hits += hit;
    classes[row.label].hits += hit;
    classes[row.label].total++;
  }
  const n = samples.length;
  return { points: points / n, pct: pct / n, accuracy: 100 * hits / n, classes };
}

const priceMethods = ['previous', 'ridge'];
const directionMethods = ['majority', 'persistence', 'softmax'];
function scores(samples) {
  return Object.fromEntries([
    ...priceMethods.map(m => [m, evaluate(samples, m, 'majority')]),
    ...directionMethods.map(m => [m, evaluate(samples, 'previous', m)])
  ]);
}
const validation = scores(periods.validation);
const priceCandidate = validation.ridge.pct < validation.previous.pct ? 'ridge' : 'previous';
const dirCandidate = directionMethods.reduce((best, m) => validation[m].accuracy > validation[best].accuracy ? m : best);
const holdout = scores(periods.holdout);
const priceMethod = holdout[priceCandidate].pct < holdout.previous.pct ? priceCandidate : 'previous';
const directionMethod = holdout[dirCandidate].accuracy > holdout.majority.accuracy ? dirCandidate : 'majority';
const model = { center: fitted.center, scale: fitted.scale, majority: fitted.majority };
if (priceMethod === 'ridge') model.ridge = fitted.ridge;
if (directionMethod === 'softmax') model.softmax = fitted.softmax;
const params = { priceMethod, directionMethod, models: { TAIEX: model } };
const hash = createHash('sha256').update(JSON.stringify([bars.map(b => [b.date, b.close]), params])).digest('hex').slice(0, 10);
params.version = 'taiex-v1-' + hash;
const names = { previous: '昨收點位', ridge: '正則化迴歸', majority: '訓練期多數方向（' + fitted.majority + '）', persistence: '延續昨日方向', softmax: '三類邏輯迴歸' };
const report = ['# 台灣加權指數盤前預測回測', '',
  '證交所日 K，訓練期為 2023–2024 年。開頭 21 筆作為特徵暖機，訓練樣本 ' + periods.train.length + ' 筆。交易日與封存日曆逐日核對，缺漏 0 筆。',
  '', '2025 年分別依最低平均絕對誤差占昨收百分比及最高方向命中率選模。驗證期同分時優先採用基準，保留期只驗收一次，未嚴格超過基準即回到基準。', '',
  '版本 `' + params.version + '`。採用點位方法「' + names[priceMethod] + '」與方向方法「' + names[directionMethod] + '」。', ''];
for (const [period, result, title] of [['validation', validation, '2025 驗證期'], ['holdout', holdout, '2026 保留期（截至 11 月 17 日）']]) {
  report.push('## ' + title + ' · ' + periods[period].length + ' 個交易日', '', '| 點位方法 | 平均絕對誤差（點） | 占昨收百分比 |', '|---|---:|---:|');
  for (const m of priceMethods) report.push('| ' + [names[m], result[m].points.toFixed(2), result[m].pct.toFixed(3) + '%'].join(' | ') + ' |');
  report.push('', '| 方向方法 | 命中率 | 跌（命中／樣本） | 平（命中／樣本） | 漲（命中／樣本） |', '|---|---:|---:|---:|---:|');
  for (const m of directionMethods) report.push('| ' + [names[m], result[m].accuracy.toFixed(3) + '%', ...directions.map(d => result[m].classes[d].hits + '/' + result[m].classes[d].total)].join(' | ') + ' |');
  report.push('');
}
await writeFile(new URL('../scripts/taiex-model-parameters.json', import.meta.url), JSON.stringify(params, null, 2) + '\n');
await writeFile(new URL('taiex-results.md', import.meta.url), report.join('\n'));
console.log(report.join('\n'));
