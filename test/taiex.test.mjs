import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activationDate, barsThrough, parseMonth, updateArchive } from '../scripts/taiex.mjs';
import { MonthlyRecords } from '../scripts/price-tracking-records.mjs';
import { onTimeForecast, runForecast, runClose, checkCloses, trackingSymbols } from '../scripts/daily-price-tracking.mjs';
import { livePerformance } from '../scripts/live-performance.mjs';
import { symbols } from '../scripts/price-tracking-market.mjs';
import { defaultMAPeriod, forecastClosePath, version as forecastVersion } from '../shared/forecast-model.js';

const fields = ['日期', '開盤指數', '最高指數', '最低指數', '收盤指數'];
test('證交所月報依欄名解析，跨月補抓保留較新行情，舊快照不混入預測', async t => {
  const data = [['115/11/18', '40,720.09', '40,938.20', '39,260.99', '40,194.91']];
  assert.deepEqual(parseMonth({ stat: 'OK', fields, data }, '2026-11')[0], {
    date: '2026-11-18', open: 40720.09, high: 40938.2, low: 39260.99, close: 40194.91
  });
  assert.throws(() => parseMonth({ stat: 'OK', fields, data }, '2026-10'));
  assert.throws(() => parseMonth({ stat: 'OK', fields, data: [['115/11/18','12','10','9','11']] }, '2026-11'));
  assert.equal((await barsThrough('2026-11-17', false)).at(-1).close, 40092.11);
  const months = [];
  t.mock.method(globalThis, 'fetch', async url => {
    months.push(url.searchParams.get('date'));
    return Response.json({ stat: 'OK', fields, data: months.length === 1 ? [['115/10/30','100','102','99','101']] : [] });
  });
  const result = await updateArchive('2026-10-30', '2026-11-02', false);
  assert.deepEqual(months, ['20261001', '20261101']);
  assert.equal(result.find(bar => bar.date === '2026-10-30').close, 101);
  assert.ok(result.some(bar => bar.date === '2026-11-18' && bar.close === 40194.91));
});

test('啟用日起大盤獨立計分，逾時留白、重跑保留預測、收盤稽核含大盤', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'taiex-test-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const records = new MonthlyRecords(dir);
  const day = '2026-11-18';
  const before = '2026-11-17';
  assert.deepEqual(trackingSymbols(before, day), symbols);
  assert.ok(trackingSymbols(day, day).includes('TAIEX'));
  assert.equal(await activationDate('2026-11-20', 9), '2026-11-23');
  assert.equal(await activationDate('2026-11-21', 7), '2026-11-23');
  for (const stock of symbols) await records.update(day, stock, { forecast_close: '1', actual_close: '1', forecast_at: day + ' 07:00:00' });
  const early = { date: day, hour: 7, timestamp: day + ' 07:05:01' };
  const late = { date: day, hour: 9, timestamp: day + ' 09:00:01' };
  await assert.rejects(runForecast(records, day, late, undefined, () => late, day), /未開始抓取行情/);
  assert.equal(await records.get(day, 'TAIEX'), undefined);
  await runForecast(records, day, early, undefined, () => early, day);
  const row = await records.get(day, 'TAIEX');
  const taiexCloses = (await barsThrough('2026-11-17', false)).slice(-21).map(bar => bar.close);
  assert.equal(row.previous_close, 40092.11);
  assert.equal(row.forecast_close, forecastClosePath(taiexCloses, 1, defaultMAPeriod)[0]);
  assert.equal(row.forecast_at, early.timestamp);
  assert.equal(row.model_version, forecastVersion);
  assert.equal(onTimeForecast(row, day), true);
  assert.equal(onTimeForecast({ ...row, forecast_direction: '' }, day), false);
  await runForecast(records, day, late, undefined, () => late, day);
  const dates = [{ date: day, pendingOnly: false }];
  await assert.rejects(checkCloses(records, dates, day), /1 筆/);
  await runClose(records, day, '2026-11-19', false, false, undefined, day);
  await records.save();
  const disk = new MonthlyRecords(dir);
  assert.equal((await disk.get(day, 'TAIEX')).actual_close, 40194.91);
  assert.equal((await disk.get(day, 'TAIEX')).forecast_at, early.timestamp);
  await checkCloses(disk, dates, day);
  const result = await livePerformance(disk, day, '2026-11-19', ['TAIEX']);
  assert.deepEqual([result.days, result.complete, result.timely], [2, 1, 1]);
  assert.equal(result.versions.get(row.model_version).scored, 1);
});
