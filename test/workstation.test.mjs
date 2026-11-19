import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as calendar from '../shared/trading-calendar.js';
import { forecastClosePath } from '../shared/forecast-model.js';
import { computeTechnicalIndicators, applyBaselineRule } from '../shared/indicators.js';
import { findPremarketRecord } from '../shared/premarket.js';
import { parseCSVToJSON } from '../shared/data-parser.js';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../workstation.js', import.meta.url), 'utf8');
const inline = source.replace(/^import .*?;$/gm, '');
function workstation() {
  const elements = new Map();
  let download;
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { style: {}, classList: { remove() {} } });
      return elements.get(id);
    },
    createElement: () => ({ click() {} }),
    body: { appendChild() {}, removeChild() {} }
  };
  const ctx = vm.createContext({
    window: { addEventListener() {} }, calendar, forecastClosePath, computeTechnicalIndicators, applyBaselineRule,
    findPremarketRecord, parseCSVToJSON,
    document, Blob, setTimeout() {},
    URL: { createObjectURL(blob) { download = blob; }, revokeObjectURL() {} }
  });
  vm.runInContext(inline, ctx);
  vm.runInContext("todayInTaipei = () => '2026-11-17'", ctx);
  function chart(closes, period) {
    ctx.raw = closes.map((close, i) => ({
      open: close, close, high: close, low: close, volume: 1000, date: calendar.shiftDate('2026-03-01', i).replaceAll('-', '/')
    }));
    ctx.period = period;
    return vm.runInContext('enrichCandlesWithIndicatorsAndForecast(raw, period, 2)', ctx);
  }
  return { ctx, chart, document, exported: async () => JSON.parse(await download.text()) };
}

test('歷史 B2 需要上揚、回落至均線、反彈；固定情境點仍有標記', () => {
  const { chart } = workstation();
  const run = tail => chart([...Array(20).fill(100), ...tail], 20);
  for (const tail of [[100, 100, 100], [99, 98, 99], [100, 100.5, 101], [108, 105, 106]]) {
    assert.notEqual(run(tail).find(b => b.isCurrent).rule, 'B2');
  }
  const bars = run([102, 101, 102, 103]);
  assert.equal(bars[22].rule, 'B2');
  assert.notEqual(bars[23].rule, 'B2');
  assert.equal(bars.filter(b => b.isForecast).length, 44);
  assert.equal(bars.filter(b => b.isForecast)[10].isPresetScenario, true);
  assert.equal(bars.filter(b => b.isForecast)[10].rule, 'B2');
});

test('MA10、20、60 的畫面摘要、下載內容、舊欄位一致', async () => {
  const app = workstation();
  vm.runInContext("state.selectedStockCode = '3481'", app.ctx);
  const closes = Array.from({ length: 75 }, (_, i) => 100 + i);
  for (const period of [10, 20, 60]) {
    app.ctx.bars = app.chart(closes, period);
    vm.runInContext('state.maPeriod = period; state.chartData = bars; state.currentBarIndex = bars.findIndex(b => b.isCurrent); renderSummaryBanner(); exportStrategyJSON()', app.ctx);
    const payload = await app.exported();
    const expected = closes.at(-1) - (period - 1) / 2;
    assert.equal(app.document.getElementById('stock-ma20-val').textContent, expected.toFixed(2));
    assert.match(app.document.getElementById('ma20-label-title').textContent, new RegExp('MA' + period + '$'));
    assert.equal(payload.parameters.maPeriod, period);
    assert.equal(payload.stock.selectedMACurrent, expected);
    assert.equal(payload.stock.ma20Current, expected);
    for (const bar of payload.chartData) {
      assert.equal(bar.ma20, bar.selectedMA);
      assert.equal(bar.bias20, bar.selectedBiasPct);
    }
    const base = payload.chartData.find(bar => bar.isCurrent);
    assert.equal(base.selectedBiasPct, +((174 / expected - 1) * 100).toFixed(2));
  }
  assert.equal(app.chart([100], 20)[0].selectedMA, null);
});

test('盤前顯示只使用當日同一檔股票的有效紀錄，也可讀取舊欄位', () => {
  const { ctx } = workstation();
  ctx.csv = [
    '\uFEFF交易日,股票代號,預測收盤價,預測時間,實際收盤價,收盤價取得時間,策略版本,昨收,預測方向',
    '2026-11-16,3481,31,2026-11-16 07:15:00,,,,30,漲',
    '2026-11-17,3481,35.3,2026-11-17 07:05:00,,,,35.3,跌',
    '2026-11-17,2330,2200,2026-11-17 11:15:00,,,,2200,平'
  ].join('\r\n');
  const read = (date, code) => JSON.parse(vm.runInContext(`JSON.stringify(findPremarketRecord(parseCSVToJSON(csv), '${date}', '${code}'))`, ctx));
  assert.deepEqual(read('2026-11-17', '3481'), { price: 35.3, time: '07:05:00', direction: '跌' });
  assert.equal(read('2026-11-17', '2330'), null);
  assert.equal(read('2026-11-18', '3481'), null);
  ctx.csv = 'trade_date,stock_id,forecast_close,forecast_at\n2026-11-17,3481,35.3,2026-11-17T07:05:00+08:00';
  assert.deepEqual(read('2026-11-17', '3481'), { price: 35.3, time: '07:05:00', direction: '—' });
});


test('最新收盤採指定股票最新實際價格，與盤前預估及手動校正分開', () => {
  const { ctx, document } = workstation();
  vm.runInContext(String.raw`
    state.selectedStockCode = '3481';
    state.liveCandlesMap['3481'] = [
      { date: '2026/11/13', close: 39.95 },
      { date: '2026/11/16', close: 36.3 }
    ];
    state.chartData = [{ date: '2026/11/16', close: 100, changePct: 10, source: 'manual' }];
    state.currentBarIndex = 0;
    const rows = parseCSVToJSON([
      '交易日,股票代號,預測收盤價,預測時間,實際收盤價,昨收',
      '2026-11-17,3481,39.1,2026-11-17 07:00:00,35.3,36.3',
      '2026-11-17,2330,2230,2026-11-17 07:00:00,2235,2215',
      '2026-11-18,3481,,,36.55,35.3'
    ].join('\n'));
    state.premarket = { code: '3481', close: findRecordedClose(rows, '2026-11-17', '3481') };
    renderSummaryBanner();
  `, ctx);
  assert.equal(document.getElementById('stock-current-price').textContent, '$35.30');
  assert.equal(document.getElementById('today-price-label').textContent, '最新收盤（2026-11-17）');
  assert.equal(document.getElementById('stock-close-source').textContent, '每日收盤紀錄');
  vm.runInContext("state.premarket.code = '2330'; renderSummaryBanner()", ctx);
  assert.equal(document.getElementById('stock-current-price').textContent, '$36.30');
  assert.equal(document.getElementById('stock-close-source').textContent, 'FinMind 日 K');
});

test('首頁預設大盤歷史日 K，前次個股查詢晚回來仍顯示指數點位', async () => {
  const { ctx, document } = workstation();
  const evaluate = code => vm.runInContext(code, ctx);
  assert.equal(evaluate('state.selectedStockCode'), 'TAIEX');
  assert.equal((html.match(/>台灣加權指數（TAIEX）<\/h/g) || []).length, 2);
  ctx.URLSearchParams = URLSearchParams;
  ctx.settleStock = null;
  ctx.fakeStock = new Promise(r => { ctx.settleStock = r; });
  ctx.indexBars = [
    { date: '2026-11-16', open: 42130.33, high: 43512.42, low: 41040.08, close: 41040.08 },
    { date: '2026-11-17', open: 40546.64, high: 41533.84, low: 39786.45, close: 40092.11 }
  ];
  evaluate(`
    loadStockBars = () => fakeStock;
    loadIndexBars = async () => indexBars;
    rebuildAndRenderAll = () => {
      const bars = state.liveCandlesMap[state.selectedStockCode];
      state.chartData = bars?.length ? enrichCandlesWithIndicatorsAndForecast(bars, 20, 2, undefined, isMarketIndex()) : [];
      state.currentBarIndex = state.chartData.findIndex(b => b.isCurrent);
      renderSummaryBanner();
    };
    state.selectedStockCode = '2330';
  `);
  const pending = evaluate("fetchRealTaiwanStockData('2330')");
  await evaluate("state.selectedStockCode = 'TAIEX'; fetchRealTaiwanStockData('TAIEX')");
  ctx.settleStock([{ date: '2026-11-17', stock_id: '2330', open: 2100, close: 2200, max: 2300, min: 2000 }]);
  await pending;
  assert.equal(document.getElementById('stock-current-price').textContent, '40,092.11 點');
  assert.equal(document.getElementById('stock-close-source').textContent, '證交所日 K');
  assert.equal(evaluate("state.chartData.every(b => b.source === 'twse' && !b.isForecast)"), true);
});

test('台灣跨月午夜的交易日、星期及 JSON 時間一致', async () => {
  const instant = new Date('2026-11-30T16:00:00.123Z');
  const clock = calendar.taipeiClock(instant);
  assert.equal(clock.timestamp, '2026-12-01 00:00:00');
  assert.equal(clock.hour, 0);
  assert.equal(new Date(clock.iso).getTime(), instant.getTime());
  const app = workstation();
  app.ctx.calendar = { ...calendar, taipeiClock: (time = instant) => calendar.taipeiClock(time) };
  for (const input of ['2026-11-30T16:00:00.123Z', '2026-11-30T08:00:00-08:00', '2026-12-01 00:00:00', '2026/12/1']) {
    app.ctx.input = input;
    assert.equal(vm.runInContext('calendar.getDateWithWeekday(input)', app.ctx), '2026/12/01 (週二)');
  }
  app.ctx.bars = app.chart([100], 20);
  vm.runInContext('state.chartData = bars; state.currentBarIndex = 0; exportStrategyJSON()', app.ctx);
  assert.equal((await app.exported()).exportedAt, '2026-12-01T00:00:00.123+08:00');
});
