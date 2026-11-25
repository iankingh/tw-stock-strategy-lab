import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstPathDate, pathCalendar, matchesDaily } from '../shared/five-day.js';
import { taipeiClock } from '../shared/trading-calendar.js';
import { parseCSVToJSON } from '../shared/data-parser.js';
import { readEdition, forecastGaps } from '../scripts/published-paths.mjs';
import { runForecast, recoveryTask, standbyTask, trackingSymbols } from '../scripts/daily-price-tracking.mjs';
import { auditDay, Journal } from '../scripts/tracking-incidents.mjs';
import { MonthlyRecords } from '../scripts/price-tracking-records.mjs';
import { version as forecastVersion } from '../shared/forecast-model.js';

const day = '2026-11-26';
const clock = time => taipeiClock(new Date(day + 'T' + time + '+08:00'));
const targets = trackingSymbols(day);
const collect = async (_, ids) => ids.map(code => [code, {
  forecast_close: 100, previous_close: 100, forecast_direction: '漲', history_through: '2026-11-25',
  priceMethod: 'scenario', path_closes: [100, 99.5, 99, 98.5, 98], complete_window: true,
  model_version: forecastVersion
}]);
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'edition-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new MonthlyRecords(dir);
}

test('目標日跨月、休市與空月檔解析正常，2026-11-26 盤前備援不回補前日收盤', async t => {
  assert.deepEqual(pathCalendar(day), { previous: '2026-11-25', dates: [day, '2026-11-27', '2026-11-30', '2026-12-01', '2026-12-02'] });
  assert.deepEqual(pathCalendar('2026-12-24').dates, ['2026-12-24', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31']);
  assert.throws(() => pathCalendar('2026-12-25'));
  const rows = parseCSVToJSON(await readFile(new URL('../data/daily-price-tracking/2026-11.csv', import.meta.url), 'utf8'), '2026-11');
  assert.ok(Array.isArray(rows));
  const records = await fixture(t);
  assert.equal(await recoveryTask(records, clock('04:43:00'), undefined, firstPathDate), null);
  assert.deepEqual(await standbyTask(clock('04:43:00')), { date: day, mode: 'forecast' });
  assert.deepEqual(await recoveryTask(records, clock('06:00:00'), undefined, firstPathDate), { mode: 'forecast', date: day, missing: targets });
});

test('盤前部分失敗可只補五日線，首日沿用既有 CSV，七檔重跑都保留原時間', async t => {
  const records = await fixture(t);
  const at = clock('06:01:00');
  const partial = async (date, ids) => (await collect(date, ids)).map(([id, values]) =>
    [id, { ...values, complete_window: id !== '2330' }]);
  await assert.rejects(runForecast(records, day, at, partial, () => at), /五日預估待補：2330/);
  const first = await readEdition(records, day);
  assert.equal(Object.keys(first).length, 6);
  const original = await records.get(day, '2330');
  assert.deepEqual(await forecastGaps(records, day, targets), { daily: [], paths: ['2330'] });
  assert.deepEqual((await recoveryTask(records, at)).missing, ['2330']);
  const later = clock('07:20:10');
  await runForecast(records, day, later, async (date, ids) => {
    assert.deepEqual(ids, ['2330']);
    const result = await collect(date, ids);
    result[0][1].forecast_close = 101;
    return result;
  }, () => later);
  const disk = new MonthlyRecords(records.directory);
  const complete = await readEdition(disk, day);
  assert.deepEqual(complete.TAIEX, first.TAIEX);
  assert.deepEqual(await disk.get(day, '2330'), original);
  assert.equal(complete['2330'].generated_at, later.timestamp);
  for (const stock of targets) {
    assert.ok(matchesDaily(complete[stock], await disk.get(day, stock)));
    assert.equal(complete[stock].model_version, forecastVersion);
  }
  assert.deepEqual(complete['2330'].targets.map(t => t.close), [100, 99.5, 99, 98.5, 98]);
  assert.ok(complete['2330'].targets.every(t => t.method === 'scenario'));
  const legacy = structuredClone(complete['2330']);
  legacy.targets[0].method = 'previous';
  legacy.targets[1].method = 'ridge';
  assert.equal(matchesDaily(legacy, original), true);
  const broken = structuredClone(complete['2330']);
  broken.targets[2].date = broken.targets[1].date;
  assert.equal(matchesDaily(broken, original), false);
  assert.equal(await recoveryTask(disk, later), null);
  await runForecast(disk, day, later, () => assert.fail('不可重算已發布資料'), () => later);
  await writeFile(join(disk.directory, 'paths/latest.json'), '{}');
  await runForecast(disk, day, later, () => assert.fail('修復索引不可重算'), () => later);
  assert.deepEqual(await readEdition(disk, day), complete);
  const journal = new Journal(join(disk.directory, 'incidents'));
  await auditDay(day, new Date(day + 'T09:01:00+08:00'), [], disk, journal);
  assert.ok(journal.added.some(line => line.includes('五日預估 | 資料已齊') && line.includes('35 個目標價')));
});

test('08:59 開始但 09:00 完成時，單日與五日皆不寫入', async t => {
  const records = await fixture(t);
  await assert.rejects(runForecast(records, day, clock('08:59:59'), collect, () => clock('09:00:00')), /預測留白/);
  assert.deepEqual(await readEdition(records, day), {});
  assert.equal(await records.get(day, '2330'), undefined);
});
