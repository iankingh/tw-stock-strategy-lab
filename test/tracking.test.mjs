import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonthlyRecords } from '../scripts/price-tracking-records.mjs';
import { onTimeForecast, runForecast, runClose, retryDates, checkCloses, closeScheduleDate, recoveryTask, standbyTask, waitForCollection } from '../scripts/daily-price-tracking.mjs';
import { findPremarketRecord } from '../shared/premarket.js';
import { taipeiClock } from '../shared/trading-calendar.js';
import { datedTWSEPrices, symbols } from '../scripts/price-tracking-market.mjs';
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
  assert.deepEqual([old.forecast_close, old.forecast_at, old.previous_close, old.forecast_direction], [41, '2026-10-30 07:00:00', 40, null]);
  const recent = await disk.get('2026-11-02', '2330');
  assert.deepEqual([recent.forecast_close, recent.forecast_direction, recent.previous_close], [42, null, null]);
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
  assert.equal((await disk.get(today, '2317')).actual_close, 101);
  assert.equal(await disk.get(oldDate, '2317'), undefined);
  const remaining = [];
  const all = async (date, stocks) => stocks.map(stock => { remaining.push(stock); return [stock, { actual_close: '102' }]; });
  for (const target of dates) await runClose(disk, target.date, today, true, target.pendingOnly, all);
  await disk.save();
  assert.deepEqual(remaining, ['2330', '2330']);
  await checkCloses(new MonthlyRecords(disk.directory), dates);
  assert.equal((await disk.get(oldDate, '2330')).forecast_close, 100);
});

test('正式預測採用截至昨收的日 K，補跑不覆寫，逾時與資料不齊留空', async t => {
  const records = await tempRecords(t);
  const day = '2026-11-17';
  const clock = time => taipeiClock(new Date(`${day}T${time}+08:00`));
  const early = clock('06:27:24');
  const late = clock('09:00:00');
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
  await assert.rejects(runForecast(records, day, late), /09:00:00 啟動.*未開始抓取行情/);
  assert.equal(fetches, 0);
  await assert.rejects(runForecast(records, day, clock('08:59:59'), undefined, () => late), /09:00:00 才完成.*預測留白/);
  assert.equal(await records.get(day, '2330'), undefined);
  const file = join(records.directory, 'summary.md');
  const previousSummary = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = file;
  t.after(() => { if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = previousSummary; });
  await assert.rejects(runForecast(records, day, early, undefined, () => early), /盤前預測待補：2312$/);
  assert.match(await readFile(file, 'utf8'), /2312（FinMind）：needs 21 daily records through 2026-11-16/);
  const disk = new MonthlyRecords(records.directory);
  assert.equal(await disk.get(day, '2312'), undefined);
  const first = await disk.get(day, '2330');
  assert.equal(first.previous_close, 2215);
  assert.equal(first.model_version, parameters.version);
  assert.ok(onTimeForecast(first, day));
  assert.equal(onTimeForecast({ ...first, forecast_direction: '' }, day), false);
  staleStock = '';
  const beforeRetry = fetches;
  await runForecast(disk, day, clock('07:20:00'), undefined, () => clock('07:20:00'));
  assert.equal(fetches - beforeRetry, 1);
  assert.deepEqual(await new MonthlyRecords(records.directory).get(day, '2330'), first);
  assert.equal((await disk.get(day, '2312')).forecast_at, day + ' 07:20:00');
  const calls = fetches;
  await runForecast(disk, day, late);
  assert.equal(fetches, calls);
});

test('OpenAPI 落後一日，用同交易日收盤表補六檔，避免逐檔月報 HTTP 307', async t => {
  const records = await tempRecords(t);
  const date = '2026-11-23';
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push(url.pathname);
    if (url.pathname.endsWith('/STOCK_DAY_ALL')) {
      return Response.json([{ Code: '2330', Date: '1151120', ClosingPrice: '9' }]);
    }
    if (!url.pathname.endsWith('/MI_INDEX')) return new Response(null, { status: 307 });
    assert.equal(url.searchParams.get('date'), '20261123');
    return Response.json({ stat: 'OK', date: '20261123', tables: [
      { fields: ['指數', '收盤指數'], data: [] },
      { fields: ['收盤價', '證券代號'], data: symbols.map(stock => ['2,030.00', stock]) }
    ] });
  });
  await runClose(records, date, date, false);
  await records.save();
  assert.deepEqual(requests, ['/v1/exchangeReport/STOCK_DAY_ALL', '/rwd/zh/afterTrading/MI_INDEX']);
  const disk = new MonthlyRecords(records.directory);
  for (const stock of symbols) assert.equal((await disk.get(date, stock)).actual_close, 2030);
  await checkCloses(disk, await retryDates(date, false));
});

test('全市場收盤表拒收錯日、缺欄及無效價格，未報價的個股可由月報補足', async t => {
  const date = '2026-11-23';
  const fields = ['證券代號', '收盤價'];
  let report = { stat: 'OK', date: '20261120', tables: [{ fields, data: [['2312', '99']] }] };
  const months = [];
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.pathname.endsWith('/MI_INDEX')) return Response.json(report);
    months.push(url.searchParams.get('stockNo'));
    return Response.json({ stat: 'OK', fields: ['日期','收盤價'], data: [['115/11/23','21.20']] });
  });
  await assert.rejects(datedTWSEPrices(date), /2026-11-23/);
  report = { ...report, date: '20261123', tables: [] };
  await assert.rejects(datedTWSEPrices(date), /缺少/);
  report.tables = [{ fields, data: symbols.map(stock => [stock, stock === '2312' ? '--' : '40']) }];
  const records = await tempRecords(t);
  await runClose(records, date, '2026-11-24', false);
  assert.deepEqual(months, ['2312']);
  assert.equal((await records.get(date, '2312')).actual_close, 21.2);
  await checkCloses(records, await retryDates(date, false));
});

test('兩條證交所路徑均失敗時，摘要留存股票與 HTTP 錯誤，再補抓可用同日 FinMind', async t => {
  const records = await tempRecords(t);
  const date = '2026-11-23';
  for (const id of [...symbols, 'TAIEX'].filter(id => id !== '3481')) {
    await records.update(date, id, { actual_close: 100 });
  }
  const logs = [];
  t.mock.method(console, 'log', message => logs.push(message));
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.hostname === 'api.finmindtrade.com') {
      return Response.json({ msg: 'success', data: [{ date, stock_id: '3481', close: 30.25 }] });
    }
    return new Response(null, { status: 307 });
  });
  const dates = await retryDates(date, false);
  await runClose(records, date, '2026-11-24', false);
  await assert.rejects(checkCloses(records, dates), /尚缺 1 筆/);
  assert.match(logs.join('\n'), /3481 證交所個股月報：.*HTTP 307/);
  await runClose(records, date, '2026-11-24', true);
  await records.save();
  const disk = new MonthlyRecords(records.directory);
  await checkCloses(disk, dates);
  assert.equal((await disk.get(date, '3481')).actual_close, 30.25);
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

test('11 月 20 日備援、正式寫入與網頁讀取共用 06:00 含至 09:00 不含的界線', async t => {
  const day = '2026-11-20';
  const all = [...symbols, 'TAIEX'];
  for (const [time, eligible] of [['05:59:59', false], ['06:00:00', true], ['06:27:24', true], ['08:59:59', true], ['09:00:00', false]]) {
    const records = await tempRecords(t);
    const now = taipeiClock(new Date(`${day}T${time}+08:00`));
    const task = await recoveryTask(records, now);
    assert.deepEqual(task, { mode: eligible ? 'forecast' : 'retry', date: eligible ? day : '2026-11-19', missing: all });
    const values = { previous_close: 100, forecast_close: 100, forecast_direction: '漲', model_version: 'daily-test' };
    const row = { ...values, trade_date: day, stock_id: '2330', forecast_at: now.timestamp };
    assert.equal(onTimeForecast(row, day), eligible);
    assert.deepEqual(findPremarketRecord([row], day, '2330'), eligible ? { price: 100, time, direction: '漲' } : null);
    const collect = t.mock.fn(async (_, targets) => targets.map(id => [id, {
      ...values, model_version: id === 'TAIEX' ? 'taiex-v1-test' : values.model_version
    }]));
    const attempt = runForecast(records, day, now, collect, () => now);
    if (eligible) {
      await attempt;
      assert.deepEqual(collect.mock.calls[0].arguments[1], all);
      assert.equal((await records.get(day, 'TAIEX')).forecast_at, now.timestamp);
      assert.equal(await recoveryTask(records, now), null);
    } else {
      await assert.rejects(attempt, /未開始抓取行情/);
      assert.equal(collect.mock.callCount(), 0);
      assert.equal(await records.get(day, 'TAIEX'), undefined);
    }
  }
});

test('11 月 23 日 04:49:54 備援等到 06:00，即使下一輪排程 09:58 才到仍可交付', async t => {
  const date = '2026-11-23';
  const at = (time, day = date) => taipeiClock(new Date(`${day}T${time}+08:00`));
  const records = await tempRecords(t);
  let now = at('04:49:54');
  assert.deepEqual(await standbyTask(now), { mode: 'forecast', date });
  assert.equal((await recoveryTask(records, now)).date, '2026-11-20');
  const delay = async ms => { assert.equal(ms, 4_206_000); now = at('06:00:00'); };
  await waitForCollection(date, 'forecast', () => now, delay);
  const task = await recoveryTask(records, now);
  assert.deepEqual(task, { mode: 'forecast', date, missing: [...symbols, 'TAIEX'] });
  await runForecast(records, date, now, async (_, targets) => targets.map(id => [id, {
    previous_close: 10, forecast_close: 10, forecast_direction: '漲',
    model_version: id === 'TAIEX' ? 'taiex-v1-test' : 'daily-test'
  }]), () => now);
  const saved = new MonthlyRecords(records.directory);
  for (const id of task.missing) assert.equal((await saved.get(date, id)).forecast_at, now.timestamp);
  await runForecast(saved, date, at('09:58:11'), () => assert.fail('已有七筆時不可重抓'));
});

test('清晨待命遵守交易日及兩小時上限，晚起時仍由寫入工作檢查截止', async t => {
  const date = '2026-11-23';
  const at = (time, day = date) => taipeiClock(new Date(`${day}T${time}+08:00`));
  for (const time of ['03:59:59', '06:00:00', '09:58:11']) assert.equal(await standbyTask(at(time)), null);
  for (const time of ['04:00:00', '05:59:59']) assert.deepEqual(await standbyTask(at(time)), { mode: 'forecast', date });
  assert.equal(await standbyTask(at('04:49:54', '2026-11-22')), null);
  const never = () => assert.fail('此情境不可等待');
  await assert.rejects(waitForCollection(date, 'forecast', () => at('03:59:59'), never), /尚未進入/);
  await assert.rejects(waitForCollection(date, 'forecast', () => at('06:01:00', '2026-11-24'), never), /無法為/);
  const late = at('09:58:11');
  await waitForCollection(date, 'forecast', () => late, never);
  const records = await tempRecords(t);
  await assert.rejects(runForecast(records, date, late, never), /未開始抓取行情/);
  assert.equal(await records.get(date, 'TAIEX'), undefined);
});

test('11 月 23 日 16:58:04 備援先查上個交易日，到 17:00 補齊當日七筆收盤', async t => {
  const date = '2026-11-23';
  const at = time => taipeiClock(new Date(`${date}T${time}+08:00`));
  const records = await tempRecords(t);
  let now = at('16:58:04');
  const task = await standbyTask(now);
  assert.deepEqual(task, { mode: 'retry', date });
  assert.equal((await recoveryTask(records, now)).date, '2026-11-20');
  await waitForCollection(task.date, task.mode, () => now, async ms => {
    assert.equal(ms, 116_000);
    now = at('17:00:00');
  });
  const targets = [...symbols, 'TAIEX'];
  assert.deepEqual(await recoveryTask(records, now), { mode: 'retry', date, missing: targets });
  await runClose(records, task.date, now.date, true, false, async (day, missing) => {
    assert.equal(day, date);
    assert.deepEqual(missing, targets);
    return missing.map(id => [id, { actual_close: 100, actual_recorded_at: now.timestamp }]);
  });
  await records.save();
  const disk = new MonthlyRecords(records.directory);
  await checkCloses(disk, await retryDates(date, false));
  for (const id of targets) {
    const row = await disk.get(date, id);
    assert.equal(row.actual_recorded_at, now.timestamp);
    assert.equal(row.forecast_close, null);
  }
  assert.equal(await recoveryTask(disk, now), null);
});

test('下午待命限於交易日的兩小時內，跨月甦醒仍可補原交易日收盤', async () => {
  const date = '2026-11-30';
  const at = (time, day = date) => taipeiClock(new Date(`${day}T${time}+08:00`));
  const never = () => assert.fail('此情境不可等待');
  for (const time of ['15:00:00', '16:59:59']) assert.deepEqual(await standbyTask(at(time)), { mode: 'retry', date });
  for (const time of ['14:59:59', '17:00:00']) assert.equal(await standbyTask(at(time)), null);
  assert.equal(await standbyTask(at('16:58:04', '2026-11-29')), null);
  await assert.rejects(waitForCollection(date, 'retry', () => at('14:59:59'), never), /尚未進入/);
  await waitForCollection(date, 'retry', () => at('00:02:00', '2026-12-01'), never);
});

test('夜間排程延到盤前時只補當天缺檔，休市及全數完成均跳過', async t => {
  const records = await tempRecords(t);
  const date = '2026-11-19';
  const check = (hour, day = date) => recoveryTask(records, { date: day, hour }, date);
  assert.equal(await check(7, '2026-11-21'), null);
  assert.equal(await check(8, '2026-12-25'), null);
  assert.deepEqual((await check(7)).missing, [...symbols, 'TAIEX']);
  for (const stock of symbols) await records.update(date, stock, { forecast_close: 100, forecast_at: date + ' 07:00:00' });
  await records.update('2026-11-18', 'TAIEX', { forecast_close: '39000' });
  assert.deepEqual(await check(8), { mode: 'forecast', date, missing: ['TAIEX'] });
  await records.update(date, 'TAIEX', { forecast_close: 40194.91, previous_close: 40194.91, forecast_at: date + ' 07:10:00', forecast_direction: '漲', model_version: 'taiex-v1-test' });
  assert.equal(await check(8), null);
});

test('收盤備援從 17 時起檢查，跨月及休市追前一交易日，包含大盤且補齊後跳過', async t => {
  const records = await tempRecords(t);
  const date = '2026-11-30';
  const check = async (day, hour) => (await recoveryTask(records, { date: day, hour }, date))?.date ?? null;
  assert.equal(await check(date, 16), '2026-11-27');
  assert.equal(await check(date, 17), date);
  for (const stock of symbols) await records.update(date, stock, { actual_close: '100' });
  assert.equal(await check('2026-12-01', 0), date);
  await records.update(date, 'TAIEX', { actual_close: '0' });
  assert.equal(await check('2026-12-01', 5), date);
  await records.update(date, 'TAIEX', { actual_close: '39000' });
  assert.equal(await check('2026-12-01', 5), null);
  assert.equal(await check(date, 23), null);
  assert.equal(await check('2026-12-26', 18), '2026-12-24');
});
