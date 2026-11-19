import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCSVToJSON, formatJSONToCSV } from '../shared/data-parser.js';
import { findPremarketRecord, onTimeForecast } from '../shared/premarket.js';
import { livePerformance } from '../scripts/live-performance.mjs';
import { MonthlyRecords } from '../scripts/price-tracking-records.mjs';

test('排程寫入的九欄在瀏覽器讀回相同價格、獨立方向與台灣時間', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shared-records-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const disk = new MonthlyRecords(dir);
  const day = '2026-11-19';
  for (const [id, price, version] of [['2330', 2175, 'daily-v2-fixture'], ['TAIEX', 40194.91, 'taiex-v1-fixture']]) {
    await disk.update(day, id, { forecast_close: price, forecast_at: day + ' 07:24:17',
      previous_close: price, forecast_direction: '漲', model_version: version });
  }
  await disk.save();
  const csv = await readFile(join(dir, '2026-11.csv'), 'utf8');
  const browserRows = parseCSVToJSON(csv, '2026-11');
  for (const row of browserRows) {
    assert.deepEqual(row, await disk.get(day, row.stock_id));
    assert.equal(row.forecast_close, row.previous_close);
    assert.deepEqual(findPremarketRecord(browserRows, day, row.stock_id), { price: row.previous_close, time: '07:24:17', direction: '漲' });
    for (const patch of [{ previous_close: null }, { forecast_direction: null }, { forecast_at: day + ' 09:00:00' }]) {
      const incomplete = { ...row, ...patch };
      assert.equal(onTimeForecast(incomplete, day), false);
      assert.equal(findPremarketRecord([incomplete], day, row.stock_id), null);
    }
  }
  assert.match(csv, /2330,2175\.00,/);
  assert.equal(formatJSONToCSV(browserRows), csv);
});

test('CSV 支援 BOM、引號內換行與舊時間格式，缺值留白、代號保留前導零', () => {
  const src = '\uFEFF交易日,股票代號,預測收盤價,預測時間,實際收盤價,收盤價取得時間,策略版本\r\n' +
    '2026-11-18,"0050",98.125,2026-11-18T07:24:17+08:00,-,null,"v1, ""archive""\nfixture"\r\n';
  const [row] = parseCSVToJSON(src);
  assert.equal(row.model_version, 'v1, "archive"\nfixture');
  assert.equal(row.stock_id, '0050');
  assert.equal(row.actual_close, null);
  assert.equal(row.actual_recorded_at, null);
  assert.equal(row.forecast_close, 98.125);
  assert.equal(findPremarketRecord([row], row.trade_date, row.stock_id).direction, '—');
  assert.deepEqual(parseCSVToJSON(formatJSONToCSV([row])), [row]);
});

test('解析與寫回皆攔下重複或錯月，未知表頭及破損引號拒絕匯入', () => {
  const header = 'trade_date,stock_id,forecast_close,forecast_at\n';
  const line = '2026-11-18,0050,33,2026-11-18 08:59:59\n';
  const [row] = parseCSVToJSON(header + line);
  assert.throws(() => parseCSVToJSON(header + line + line), /duplicate/);
  assert.throws(() => formatJSONToCSV([row, row]), /duplicate/);
  assert.throws(() => parseCSVToJSON(header + line, '2026-12'), /Invalid/);
  assert.throws(() => formatJSONToCSV([row], '2026-12'), /Invalid/);
  assert.throws(() => parseCSVToJSON(header.replace('stock_id', 'other') + line), /header/);
  assert.throws(() => parseCSVToJSON(header + line.replace('0050', '"0050')), /quote/);
});

test('只有價格的歷史預測照計價差，方向命中率只取實際有分類的紀錄', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'legacy-performance-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const records = new MonthlyRecords(dir);
  const day = '2026-11-19';
  await records.update(day, '2330', { forecast_close: 100, forecast_at: day + ' 08:00:00', actual_close: 102 });
  await records.update(day, '2317', { forecast_close: 100, previous_close: 100, forecast_direction: '漲',
    forecast_at: day + ' 07:00:00', actual_close: 102, model_version: 'daily-v2-fixture' });
  await records.save();
  const result = await livePerformance(new MonthlyRecords(dir), day, day, ['2330', '2317']);
  const old = result.versions.get('未記版本');
  const current = result.versions.get('daily-v2-fixture');
  assert.deepEqual([old.scored, old.abs, old.classified], [1, 2, 0]);
  assert.deepEqual([current.scored, current.abs, current.correct, current.classified], [1, 2, 1, 1]);
});
