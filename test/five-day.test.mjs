import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathCalendar, matchesDaily } from '../shared/five-day.js';
import { taipeiClock } from '../shared/trading-calendar.js';
import { parseCSVToJSON } from '../shared/data-parser.js';
import { historyDates, trendPoints } from '../price-trend.js';
import { readEdition, forecastGaps } from '../scripts/published-paths.mjs';
import { runForecast, recoveryTask, trackingSymbols } from '../scripts/daily-price-tracking.mjs';
import { auditDay, Journal } from '../scripts/tracking-incidents.mjs';
import { MonthlyRecords } from '../scripts/price-tracking-records.mjs';
import params from '../scripts/five-day-parameters.json' with { type: 'json' };

const day = '2026-11-25';
const clock = time => taipeiClock(new Date(day + 'T' + time + '+08:00'));
const targets = trackingSymbols(day);
const collect = async (_, ids) => ids.map(code => [code, {
  forecast_close: 100, previous_close: 100, forecast_direction: '漲', history_through: '2026-11-24',
  priceMethod: 'previous', input: [0,0,0,0], complete_window: true,
  model_version: code === 'TAIEX' ? 'taiex-v1-test' : 'daily-test'
}]);
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'edition-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  return new MonthlyRecords(dir);
}

test('目標日跨月、休市，歷史視窗涵蓋 56 個交易日', () => {
  assert.deepEqual(pathCalendar(day), {previous:'2026-11-24', dates:[day,'2026-11-26','2026-11-27','2026-11-30','2026-12-01']});
  assert.deepEqual(pathCalendar('2026-12-24').dates, ['2026-12-24','2026-12-28','2026-12-29','2026-12-30','2026-12-31']);
  assert.throws(() => pathCalendar('2026-12-25'));
  assert.equal(historyDates('2026-11-24').length, 56);
});

test('已發布的 11/24 台積電預估、方向與實收同時可讀，11/23 保留缺口', async () => {
  const rows = parseCSVToJSON(await readFile(new URL('../data/daily-price-tracking/2026-11.csv', import.meta.url), 'utf8'));
  const points = trendPoints('2026-11-24','2330',[],rows,null);
  assert.deepEqual(points.at(-1), {date:'2026-11-24',actual:2230,daily:2030,direction:'漲',path:null});
  assert.equal(points.at(-2).actual, 2030);
  assert.equal(points.at(-2).daily, null);
});

test('盤前部分失敗可只補五日線，首日沿用既有 CSV，七檔重跑都保留原時間', async t => {
  const records = await fixture(t);
  const at = clock('06:01:00');
  const partial = async (date, ids) => (await collect(date,ids)).map(([id, values]) =>
    [id, {...values, complete_window:id !== '2330'}]);
  await assert.rejects(runForecast(records,day,at,partial,()=>at), /五日預估待補：2330/);
  const first = await readEdition(records,day);
  assert.equal(Object.keys(first).length, 6);
  const original = await records.get(day,'2330');
  assert.deepEqual(await forecastGaps(records,day,targets), {daily:[],paths:['2330']});
  assert.deepEqual((await recoveryTask(records,at)).missing,['2330']);
  const later = clock('07:20:10');
  await runForecast(records,day,later,async (date,ids) => {
    assert.deepEqual(ids,['2330']);
    const result = await collect(date,ids);
    result[0][1].forecast_close = 101;
    return result;
  },()=>later);
  const disk = new MonthlyRecords(records.directory);
  const complete = await readEdition(disk,day);
  assert.deepEqual(complete.TAIEX,first.TAIEX);
  assert.deepEqual(await disk.get(day,'2330'),original);
  assert.equal(complete['2330'].generated_at,later.timestamp);
  for (const stock of targets) {
    assert.ok(matchesDaily(complete[stock],await disk.get(day,stock)));
    assert.equal(complete[stock].model_version,params.version);
  }
  assert.deepEqual(complete['2330'].targets.map(t=>t.close),[100,100,100,100,100]);
  const broken = structuredClone(complete['2330']);
  broken.targets[2].date = broken.targets[1].date;
  assert.equal(matchesDaily(broken,original),false);
  assert.equal(await recoveryTask(disk,later),null);
  await runForecast(disk,day,later,()=>assert.fail('不可重算已發布資料'),()=>later);
  await writeFile(join(disk.directory, 'paths/latest.json'), '{}');
  await runForecast(disk,day,later,()=>assert.fail('修復索引不可重算'),()=>later);
  assert.deepEqual(await readEdition(disk,day),complete);
  const journal = new Journal(join(disk.directory, 'incidents'));
  await auditDay(day,new Date(day + 'T09:01:00+08:00'),[],disk,journal);
  assert.ok(journal.added.some(line => line.includes('五日預估 | 資料已齊') && line.includes('35 個目標價')));

});

test('08:59 開始但 09:00 完成時，單日與五日皆不寫入', async t => {
  const records = await fixture(t);
  await assert.rejects(runForecast(records,day,clock('08:59:59'),collect,()=>clock('09:00:00')),/預測留白/);
  assert.deepEqual(await readEdition(records,day),{});
  assert.equal(await records.get(day,'2330'),undefined);
});
