import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import calendar from '../trading-calendar.js';
import scenario from '../forecast-model.js';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const inline = html.match(/<script>([\s\S]*?)<\/script>/)[1];
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
    window: { addEventListener() {}, stockForecastModel: scenario, twseTradingCalendar: calendar },
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
  const read = (date, code) => JSON.parse(vm.runInContext(`JSON.stringify(findPremarketRecord(readDailyRecords(csv), '${date}', '${code}'))`, ctx));
  assert.deepEqual(read('2026-11-17', '3481'), { price: 35.3, time: '07:05:00', direction: '跌' });
  assert.equal(read('2026-11-17', '2330'), null);
  assert.equal(read('2026-11-18', '3481'), null);
  ctx.csv = 'trade_date,stock_id,forecast_close,forecast_at\n2026-11-17,3481,35.3,2026-11-17T07:05:00+08:00';
  assert.deepEqual(read('2026-11-17', '3481'), { price: 35.3, time: '07:05:00', direction: '—' });
});


test('最新收盤採指定股票最新實際價格，與盤前預估及手動校正分開', () => {
  const { ctx, document } = workstation();
  vm.runInContext(String.raw`
    state.liveCandlesMap['3481'] = [
      { date: '2026/11/13', close: 39.95 },
      { date: '2026/11/16', close: 36.3 }
    ];
    state.chartData = [{ date: '2026/11/16', close: 100, changePct: 10, source: 'manual' }];
    state.currentBarIndex = 0;
    const rows = readDailyRecords([
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
