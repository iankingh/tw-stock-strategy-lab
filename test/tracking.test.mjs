import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonthlyRecords } from '../scripts/price-tracking-records.mjs';
import { onTimeForecast, runForecast, runClose, retryDates, checkCloses, closeScheduleDate } from '../scripts/daily-price-tracking.mjs';
import { symbols } from '../scripts/price-tracking-market.mjs';
import { livePerformance } from '../scripts/live-performance.mjs';
import parameters from '../scripts/daily-model-parameters.json' with { type: 'json' };

async function tempRecords(t) {
  const dir = await mkdtemp(join(tmpdir(), 'stock-tracking-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new MonthlyRecords(dir);
}

test('讀取舊中英文 CSV，新版更新保留價格、時間及既有昨收', async t => {
  const records = await tempRecords(t);
  const cn = '交易日,股票代號,預測收盤價,預測時間,實際收盤價,收盤價取得時間,策略版本';
  const en = 'trade_date,stock_id,forecast_close,forecast_at,history_through,previous_close,model_version,actual_close,actual_recorded_at,actual_source';
  await writeFile(join(records.directory, '2026-10.csv'), en + '\n2026-10-30,2330,41,2026-10-30T07:00:00+08:00,2026-10-29,40,v1,,,\n');
  await writeFile(join(records.directory, '2026-11.csv'), cn + '\n2026-11-02,2330,42,2026-11-02 07:00:00,,,v1\n');
  for (const date of ['2026-10-30', '2026-11-02']) await records.update(date, '2330', { actual_close: '43' });
  await records.save();
  const disk = new MonthlyRecords(records.directory);
  const old = await disk.get('2026-10-30', '2330');
  assert.deepEqual([old.forecast_close, old.forecast_at, old.previous_close, old.forecast_direction], ['41', '2026-10-30 07:00:00', '40', '']);
  const recent = await disk.get('2026-11-02', '2330');
  assert.deepEqual([recent.forecast_close, recent.forecast_direction, recent.previous_close], ['42', '', '']);
  assert.ok(onTimeForecast(recent, '2026-11-02'));
});

test('補抓可跨月；部分收盤先落盤、列出缺漏；重跑只補缺值', async t => {
  const records = await tempRecords(t);
  const oldDate = '2026-10-30', today = '2026-11-02';
  await records.update(oldDate, '2330', { forecast_close: '100' });
  const dates = await retryDates(today, true);
  assert.deepEqual(await retryDates(today, false), [{ date: today, pendingOnly: false }]);
  const partial = async (date, stocks) => stocks.filter(s => s !== '2330').map(s => [s, { actual_close: '101' }]);
  for (const target of dates) await runClose(records, target.date, today, true, target.pendingOnly, partial);
  await records.save();
  const disk = new MonthlyRecords(records.directory);
  const file = join(records.directory, 'summary.md');
  t.mock.method(console, 'log', () => {});
  const previousSummary = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = file;
  t.after(() => { if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = previousSummary; });
  await assert.rejects(checkCloses(disk, dates), /2 筆/);
  const summary = await readFile(file, 'utf8');
  for (const date of [oldDate, today]) assert.ok(summary.includes(date + ' 2330'));
  assert.equal((await disk.get(today, '2317')).actual_close, '101');
  assert.equal(await disk.get(oldDate, '2317'), undefined);
  const remaining = [];
  const all = async (date, stocks) => stocks.map(stock => { remaining.push(stock); return [stock, { actual_close: '102' }]; });
  for (const target of dates) await runClose(disk, target.date, today, true, target.pendingOnly, all);
  await disk.save();
  assert.deepEqual(remaining, ['2330', '2330']);
  await checkCloses(new MonthlyRecords(disk.directory), dates);
  assert.equal((await disk.get(oldDate, '2330')).forecast_close, '100');
});

test('正式預測採用截至昨收的日 K，補跑不覆寫，逾時與資料不齊留空', async t => {
  const records = await tempRecords(t);
  const day = '2026-11-17';
  const early = { date: day, hour: 7, timestamp: day + ' 07:00:02' };
  const late = { date: day, hour: 9, timestamp: day + ' 09:00:01' };
  const input = (await readFile(new URL('../research/history.csv', import.meta.url), 'utf8')).trim().split('\n').slice(1);
  let staleStock = '2312';
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    fetches++;
    assert.equal(url.searchParams.get('end_date'), '2026-11-16');
    const stock = url.searchParams.get('data_id');
    const data = input.map(line => line.split(',')).filter(([date]) => date <= (stock === staleStock ? '2026-11-13' : '2026-11-16')).slice(-24)
      .map(row => ({ date: row[0], stock_id: stock, close: row[1 + symbols.indexOf(stock)] }));
    return Response.json({ msg: 'success', data });
  });
  await assert.rejects(runForecast(records, day, late), /outside/);
  assert.equal(fetches, 0);
  await assert.rejects(runForecast(records, day, early, undefined, () => late), /finished after/);
  assert.equal(await records.get(day, '2330'), undefined);
  await runForecast(records, day, early, undefined, () => early);
  assert.equal(await records.get(day, '2312'), undefined);
  const first = await records.get(day, '2330');
  assert.equal(first.previous_close, '2215.00');
  assert.equal(first.model_version, parameters.version);
  assert.ok(onTimeForecast(first, day));
  assert.equal(onTimeForecast({ ...first, forecast_direction: '' }, day), false);
  staleStock = '';
  await runForecast(records, day, early, undefined, () => ({ ...early, timestamp: day + ' 07:20:00' }));
  await records.save();
  assert.equal((await new MonthlyRecords(records.directory).get(day, '2330')).forecast_at, early.timestamp);
  assert.equal((await records.get(day, '2312')).forecast_at, day + ' 07:20:00');
  const calls = fetches;
  await runForecast(records, day, late);
  assert.equal(fetches, calls);
});

test('晚間補抓延遲跨午夜時對應原交易日與原月份', () => {
  const clock = time => ({ date: '2026-12-01', timestamp: '2026-12-01 ' + time });
  assert.equal(closeScheduleDate(clock('02:45:00'), '45 17 * * *'), '2026-11-30');
  assert.equal(closeScheduleDate(clock('17:00:00'), '0 17 * * *'), '2026-12-01');
  assert.equal(closeScheduleDate(clock('17:44:59'), '45 17 * * *'), '2026-11-30');
  assert.equal(closeScheduleDate(clock('17:45:00'), '45 17 * * *'), '2026-12-01');
  assert.equal(closeScheduleDate(clock('07:00:00'), undefined), '2026-12-01');
});

test('準時率包含全日缺席，價差與方向只計入已配對的實盤紀錄', async t => {
  const records = await tempRecords(t);
  const day = '2026-11-20';
  const row = { previous_close: '10', forecast_close: '10', forecast_direction: '漲', forecast_at: day + ' 07:00:00', model_version: parameters.version };
  for (const stock of symbols) await records.update(day, stock, row);
  await records.update(day, '2330', { actual_close: '11' });
  await records.update('2026-11-23', '2312', { ...row, forecast_at: '2026-11-23 09:05:00' });
  const result = await livePerformance(records, day, '2026-11-24');
  assert.deepEqual([result.days, result.complete, result.timely], [3, 1, 6]);
  assert.deepEqual(result.versions.get(parameters.version), {
    onTime: 6, scored: 1, abs: 1, pct: 10, normalized: 1, correct: 1, classified: 1
  });
});
