import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as scenario from '../shared/forecast-model.js';
import { symbols } from '../scripts/price-tracking-market.mjs';
import { direction, directions, features, predictDaily } from '../shared/daily-model.js';
import { train } from './train.mjs';

const text = await readFile(new URL('history.csv', import.meta.url), 'utf8');
const [header, ...lines] = text.trimEnd().split(/\r?\n/);
if (header !== ['date', ...symbols].join(',')) throw new Error('Unexpected history header');
const dates = lines.map(line => line.split(','));
if (dates[0][0] !== '2023-01-03' || dates.at(-1)[0] !== '2026-11-17') throw new Error('Unexpected study period');
for (const [i, [date, ...values]] of dates.entries()) {
  if ((i && date <= dates[i - 1][0]) || values.length !== symbols.length ||
      values.some(value => value !== '' && !(Number.isFinite(+value) && +value > 0))) throw new Error(`Invalid history: ${date}`);
}

const periods = ['train', 'validation', 'holdout'];
const samples = {};
const fitted = {};
for (const [column, stock] of symbols.entries()) {
  const windows = Object.fromEntries(periods.map(p => [p, { rows: [], missing: 0, warmup: 0 }]));
  samples[stock] = windows;
  const history = [];
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i][0];
    const period = date < '2025' ? 'train' : date < '2026' ? 'validation' : 'holdout';
    const window = windows[period];
    const actual = Number(dates[i][column + 1]);
    if (!actual || (i > 0 && !Number(dates[i - 1][column + 1]))) {
      window.missing++;
    } else if (history.length < 21) {
      window.warmup++;
    } else {
      const previous = history.at(-1);
      window.rows.push({ input: features(history), previous, actual, label: direction(actual - previous),
        returnPct: 100 * (actual / previous - 1), scenario: scenario.forecastClosePath(history, 1)[0] });
    }
    if (actual) history.push(actual);
  }
  fitted[stock] = train(windows.train.rows);
}

function evaluate(period, priceMethod, directionMethod) {
  return symbols.map(stock => {
    const { rows, missing } = samples[stock][period];
    if (!rows.length) throw new Error(`Empty evaluation for ${stock} ${period}`);
    const model = { ...fitted[stock], priceMethod, directionMethod };
    let abs = 0, pct = 0, correct = 0;
    const classes = Object.fromEntries(directions.map(d => [d, { correct: 0, total: 0 }]));
    for (const row of rows) {
      const prediction = predictDaily(model, row.input, row.previous);
      const error = Math.abs((priceMethod === 'scenario' ? row.scenario : prediction.close) - row.actual);
      abs += error;
      pct += 100 * error / row.previous;
      const hit = Number(prediction.direction === row.label);
      classes[row.label].total++;
      classes[row.label].correct += hit;
      correct += hit;
    }
    return { stock, n: rows.length, missing, mae: abs / rows.length, pct: pct / rows.length, accuracy: 100 * correct / rows.length, classes };
  });
}

const mean = (rows, key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
function comparisons(period) {
  return {
    baseline: evaluate(period, 'previous', 'majority'),
    learned: evaluate(period, 'ridge', 'softmax'),
    reference: evaluate(period, 'scenario', 'persistence')
  };
}
const validation = comparisons('validation');
const directionCandidates = [['majority', validation.baseline], ['persistence', validation.reference], ['softmax', validation.learned]];
const bestDirection = directionCandidates.reduce((best, item) => mean(item[1], 'accuracy') > mean(best[1], 'accuracy') ? item : best)[0];
const bestPrice = mean(validation.learned, 'pct') < mean(validation.baseline, 'pct') ? 'ridge' : 'previous';
// 驗證期決定候選。保留期只做一次採用判斷，不用它改挑第二名。
const holdout = comparisons('holdout');
const selected = evaluate('holdout', bestPrice, bestDirection);
const priceMethod = mean(selected, 'pct') < mean(holdout.baseline, 'pct') ? bestPrice : 'previous';
const directionMethod = mean(selected, 'accuracy') > mean(holdout.baseline, 'accuracy') ? bestDirection : 'majority';
const models = {};
for (const stock of symbols) {
  const { center, scale, ridge, softmax, majority } = fitted[stock];
  models[stock] = { center, scale, majority };
  if (priceMethod === 'ridge') models[stock].ridge = ridge;
  if (directionMethod === 'softmax') models[stock].softmax = softmax;
}

const digest = createHash('sha256').update(text).digest('hex');
const version = 'daily-v2-' + createHash('sha256').update(JSON.stringify({ digest, priceMethod, directionMethod, models })).digest('hex').slice(0, 10);
const deployment = { version, priceMethod, directionMethod, models };
const names = { previous: '昨收', ridge: '正則化迴歸', scenario: '回檔情境首日', majority: '訓練期多數方向', persistence: '延續昨方向', softmax: '多類別邏輯迴歸' };
const f = n => n.toFixed(3);
const report = ['# 六檔台股盤前預測回測', '',
  `版本 \`${version}\`。收盤價採用**${names[priceMethod]}**，方向採用**${names[directionMethod]}**。\n`,
  'FinMind 未還原收盤價，方向以實際收盤相對昨收判斷，包含除權息日。每筆預測只使用截至前一交易日收盤為止的行情。訓練期為 2023–2024 年，驗證期為 2025 年，保留期為 2026-01-01 至 2026-11-17。',
  '', '每檔各自訓練，以六檔等權平均選出共用的方法。價格比較平均絕對誤差占昨收百分比，方向比較三類的整體命中率。先在驗證期選候選，再用保留期檢查是否嚴格勝過基準。平手採基準。舊情境模型只用於比較。',
  '', `驗證期選出的價格候選為${names[bestPrice]}，方向候選為${names[bestDirection]}。價格四捨五入至小數兩位後評分。\n`];
for (const [period, comp] of [['validation', validation], ['holdout', holdout]]) {
  report.push(`## ${period === 'validation' ? '2025 驗證期' : '2026 保留期'}\n`,
    '價格欄依序為元／占昨收百分比。方向欄為命中率。缺資料包含交易日當天或前一日缺收盤，各方法使用完全相同的樣本。', '',
    '| 股票 | 有效／缺資料 | 昨收 | 回檔情境 | 正則化迴歸 | 多數方向 | 延續昨方向 | 多類別迴歸 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (let i = 0; i <= symbols.length; i++) {
    const total = i === symbols.length;
    const metrics = [comp.baseline, comp.reference, comp.learned].map(rows => total
      ? Object.fromEntries(['mae', 'pct', 'accuracy'].map(k => [k, mean(rows, k)])) : rows[i]);
    const count = total ? '' : `${metrics[0].n}／${metrics[0].missing}`;
    report.push(`| ${symbols[i] ?? '六檔等權'} | ${count} | ${metrics.map(m => f(m.mae) + '／' + f(m.pct) + '%').join(' | ')} | ${metrics.map(m => f(m.accuracy) + '%').join(' | ')} |`);
  }
  const deployed = evaluate(period, priceMethod, directionMethod);
  report.push('', `採用方法的價格誤差為 ${f(mean(deployed, 'pct'))}%，相對昨收基準減少 ${f(mean(comp.baseline, 'pct') - mean(deployed, 'pct'))} 個百分點；方向命中率為 ${f(mean(deployed, 'accuracy'))}%，較多數方向增加 ${f(mean(deployed, 'accuracy') - mean(comp.baseline, 'accuracy'))} 個百分點。\n`,
    '各方向欄為預測正確筆數／實際筆數（採用方法）。', '',
    '| 股票 | 跌 | 平 | 漲 |', '|---|---:|---:|---:|');
  for (const row of deployed) report.push(`| ${row.stock} | ${directions.map(d => row.classes[d].correct + '／' + row.classes[d].total).join(' | ')} |`);
  report.push('');
}
report.push('## 資料與重現', '', `共 ${dates.length} 個市場交易日。資料 SHA-256 為 \`${digest}\`。訓練期各檔有效／缺資料／特徵暖身筆數如下。\n`,
  ...symbols.map(stock => { const { rows, missing, warmup } = samples[stock].train; return `- ${stock}　${rows.length}／${missing}／${warmup}`; }),
  '', '執行 `node research/backtest.mjs` 可用封存行情重算報告。`node research/backtest.mjs --write` 同時輸出報告與盤前模型參數。更新來源快照使用 `node research/download-history.mjs`。', '');
const markdown = report.join('\n');
if (process.argv.includes('--write')) {
  await writeFile(new URL('parameters/daily-model-parameters.json', import.meta.url), JSON.stringify(deployment, null, 2) + '\n');
  await writeFile(new URL('results.md', import.meta.url), markdown);
} else {
  process.stdout.write(markdown);
}
