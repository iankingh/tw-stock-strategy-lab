import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, auditDay, auditFailure, recordedReason } from '../scripts/tracking-incidents.mjs';
import { trackingSymbols } from '../scripts/daily-price-tracking.mjs';
import { MonthlyRecords } from '../scripts/price-tracking-records.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tracking-audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, records: new MonthlyRecords(dir), journal: new Journal(dir) };
}
const url = 'https://github.com/iankingh/tw-stock-strategy-lab/actions/runs/123';
const day = '2026-11-30';
const crons = ['0 7', '20 7', '15 9', '0 17', '45 17'];
function scheduled(cron, stamp) {
  return { event: 'schedule', display_title: '排程 ' + cron + ' * * *', created_at: stamp + '+08:00', html_url: url };
}
function onTimeRuns() {
  return crons.map(cron => {
    const [m, h] = cron.split(' ');
    return scheduled(cron, day + 'T' + h.padStart(2, '0') + ':' + m.padStart(2, '0') + ':02');
  });
}

test('稽核忽略休市與寬限期，完整交易日不新增異常', async t => {
  const { records, journal } = await fixture(t);
  await auditDay('2026-11-28', new Date('2026-11-30T22:00:00+08:00'), [], records, journal);
  await auditDay(day, new Date(day + 'T07:14:59+08:00'), [], records, journal);
  assert.equal(journal.added.length, 0);
  for (const stock of trackingSymbols(day)) {
    await records.update(day, stock, { forecast_close: '1', forecast_at: day + ' 07:00:01', actual_close: '2',
      actual_recorded_at: day + ' 17:01:00', model_version: stock === 'TAIEX' ? 'taiex-v1-test' : 'daily-v2-test', previous_close: '1', forecast_direction: '漲' });
  }
  await auditDay(day, new Date(day + 'T18:00:00+08:00'), onTimeRuns(), records, journal);
  assert.equal(journal.added.length, 0);
});

test('主排程失聯、跨月晚到與補齊分列，手動成功不會掩蓋缺席，重查不重複', async t => {
  const { dir, records, journal } = await fixture(t);
  const runs = onTimeRuns().slice(0, 3);
  runs.push({ ...onTimeRuns()[3], event: 'workflow_dispatch' });
  await auditDay(day, new Date(day + 'T18:30:00+08:00'), runs, records, journal);
  assert.ok(journal.added.some(line => line.includes('17:00 收盤 | 查無排程紀錄')));
  assert.ok(journal.added.some(line => line.includes('期限內缺資料') && line.includes('TAIEX')));
  await journal.save();
  for (const stock of trackingSymbols(day)) await records.update(day, stock, { actual_close: '2', actual_recorded_at: '2026-12-01 01:20:00' });
  const later = scheduled('0 17', '2026-12-01T01:19:30');
  const next = new Journal(dir);
  const reconcile = () => auditDay(day, new Date('2026-12-01T01:30:00+08:00'), [...runs, later], records, next);
  await reconcile();
  await reconcile();
  assert.equal(next.added.length, 2);
  assert.match(next.added.join('\n'), /延遲建立/);
  assert.match(next.added.join('\n'), /資料已齊/);
  await next.save();
  assert.match(await readFile(join(dir, '2026-11.md'), 'utf8'), /查無排程紀錄/);
});

test('每個失敗嘗試保留失敗步驟與原因，成功重跑不覆寫', async t => {
  const { journal } = await fixture(t);
  const run = { id: 123, updated_at: '2026-11-19T10:00:00Z', conclusion: 'failure', run_attempt: 1, html_url: url, name: '收盤' };
  const jobs = () => [{ name: 'record', conclusion: 'failure', steps: [{ name: '取得價格', conclusion: 'failure' }] }];
  const reason = () => recordedReason('other output\nrecord\t取得價格\t2026-11-19T10:00:00.123Z 行情工作失敗：尚缺 1 筆收盤價\n');
  await auditFailure(run, journal, jobs, reason);
  await auditFailure(run, journal, () => assert.fail());
  await auditFailure({ ...run, conclusion: 'success', run_attempt: 2 }, journal, jobs);
  assert.equal(journal.added.length, 1);
  assert.match(journal.added[0], /record \/ 取得價格、尚缺 1 筆收盤價/);
  assert.equal(recordedReason('2026-11-19T10:00:00Z other output'), '');
});
