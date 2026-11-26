import { firstPathDate, matchesDaily } from '../shared/five-day.js';
import { readEdition } from './published-paths.mjs';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { onTimeForecast } from '../shared/premarket.js';
import { trackingSymbols } from './daily-price-tracking.mjs';
import { isTradingDate, shiftDate, taipeiClock } from './price-tracking-market.mjs';
import { MonthlyRecords } from './price-tracking-records.mjs';

const data = fileURLToPath(new URL('../data/', import.meta.url));
const initialDay = '2026-11-26';
const firstSlotAudit = '2026-11-26';
const slots = [
  ['0 7 * * *', '07:00', '盤前預測'], ['20 7 * * *', '07:20', '盤前補跑'],
  ['15 9 * * *', '09:15', '盤前稽核'], ['0 17 * * *', '17:00', '收盤'],
  ['45 17 * * *', '17:45', '收盤補抓']
];
const failures = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const local = iso => taipeiClock(new Date(iso)).timestamp;
const readOptional = file => readFile(file, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return '';
  throw error;
});

export class Journal {
  constructor(directory) {
    this.directory = directory;
    this.months = new Map();
    this.added = [];
    this.newGaps = 0;
  }

  async month(day) {
    const month = day.slice(0, 7);
    const file = join(this.directory, month + '.md');
    if (!this.months.has(month)) {
      const header = '# ' + month + ' 行情異常紀錄\n\n時間均為台灣時間。\n\n| 交易日或執行日 | 工作 | 狀態 | 證據時間 | 詳情 |\n| --- | --- | --- | --- | --- |\n';
      this.months.set(month, await readOptional(file) || header);
    }
    return this.months.get(month);
  }

  async has(day, key) {
    return (await this.month(day)).includes('<!-- ' + day + '/' + key + ' -->');
  }

  async add(day, key, task, status, at, details) {
    const marker = '<!-- ' + day + '/' + key + ' -->';
    const existing = await this.month(day);
    if (existing.includes(marker)) return false;
    const line = '| ' + [day, task, status, at, details].map(s => s.replaceAll('|', '｜').replace(/\s+/g, ' ').trim()).join(' | ') + ' | ' + marker;
    this.months.set(day.slice(0, 7), existing + line + '\n');
    this.added.push(line);
    return true;
  }

  async save() {
    await mkdir(this.directory, { recursive: true });
    for (const [month, content] of this.months) await writeFile(join(this.directory, month + '.md'), content);
  }
}

export async function auditDay(day, now, runs, records, journal) {
  if (!await isTradingDate(day)) return;
  const affected = new Set();
  for (const [cron, time, label] of slots) {
    const planned = Date.parse(day + 'T' + time + ':00+08:00');
    const deadline = planned + 15 * 60000;
    if (+now < deadline) continue;
    // GitHub 只提供 cron 字串；每個時段比對自該次至隔日同一時段前建立的 run。
    const run = runs.find(r => r.event === 'schedule' && r.display_title === '排程 ' + cron &&
      Date.parse(r.created_at) >= planned && Date.parse(r.created_at) < planned + 86400000);
    const previouslyMissing = await journal.has(day, 'slot-' + time + '-missing');
    if (!run || Date.parse(run.created_at) > deadline || previouslyMissing || failures.has(run.conclusion)) {
      if (time !== '09:15') affected.add(time < '09:00' ? 'forecast' : 'close');
    }
    if (!run) {
      const added = await journal.add(day, 'slot-' + time + '-missing', time + ' ' + label, '查無排程紀錄', local(now), '稽核時未找到對應的 GitHub 工作。');
      if (added) journal.newGaps++;
    } else if (Date.parse(run.created_at) > deadline) {
      await journal.add(day, 'slot-' + time + '-late', time + ' ' + label, '延遲建立', local(run.created_at), '[查看工作](' + run.html_url + ')');
    } else if (previouslyMissing) {
      await journal.add(day, 'slot-' + time + '-found', time + ' ' + label, '已查到工作', local(run.created_at), '[查看工作](' + run.html_url + ')');
    }
  }

  const checks = [['forecast', '盤前預測', '09:00:00'], ['close', '收盤資料', '18:00:00']];
  const edition = day >= firstPathDate ? await readEdition(records, day) : {};
  if (day >= firstPathDate) checks.push(['path', '五日預估', '09:00:00']);
  for (const [kind, name, cutoff] of checks) {
    const deadline = day + ' ' + cutoff;
    if (local(now) < deadline) continue;
    const missingAtDeadline = [];
    const recorded = [];
    for (const stock of trackingSymbols(day)) {
      const row = await records.get(day, stock);
      const path = edition[stock];
      const stamp = kind === 'path' ? path?.generated_at : kind === 'forecast' ? row?.forecast_at : row?.actual_recorded_at;
      const valid = kind === 'path' ? matchesDaily(path, row) : kind === 'forecast' ? onTimeForecast(row, day) : Number(row?.actual_close) > 0;
      if (valid && stamp) recorded.push(stamp);
      if (!valid || !stamp || stamp > deadline) missingAtDeadline.push(stock);
    }
    if (missingAtDeadline.length) {
      const added = await journal.add(day, kind + '-missing', name, '期限內缺資料', local(now), cutoff + ' 截止時缺 ' + missingAtDeadline.join('、') + '。');
      if (added && recorded.length < trackingSymbols(day).length) journal.newGaps++;
    }
    const firstEdition = kind === 'path' && day === firstPathDate;
    if (recorded.length === trackingSymbols(day).length && (firstEdition || missingAtDeadline.length || affected.has(kind === 'path' ? 'forecast' : kind) || await journal.has(day, kind + '-missing'))) {
      await journal.add(day, kind + '-complete', name, '資料已齊', recorded.sort().at(-1), kind === 'path' ? `已核對 ${recorded.length} 個標的、${recorded.length * 5} 個目標價及首日 CSV。` : '依每月 CSV 的實際取得時間核對。');
    }
  }
}

function github(route) {
  const raw = execFileSync('gh', ['api', '--paginate', '--slurp', 'repos/' + process.env.GITHUB_REPOSITORY + '/actions/' + route], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
  });
  return JSON.parse(raw);
}

export function recordedReason(log) {
  const lines = log.split(/\r?\n/);
  for (const line of lines.reverse()) {
    const match = line.match(/\d\d:\d\d:\d\d(?:\.\d+)?Z (?:行情工作失敗：(.{1,400})|(\d{4}-\d\d-\d\d: \d+ forecasts missing; job started at [^\n]{1,180}|缺漏標的：[\d、TAIEX]+。|尚缺 \d+ 筆收盤價))$/);
    if (match) return (match[1] || match[2]).replace(/[<>[\]`]/g, '');
  }
  return '';
}

export async function auditFailure(run, journal, getJobs, reasonFor = () => '') {
  if (!failures.has(run.conclusion)) return;
  const at = local(run.updated_at);
  const attempt = run.run_attempt || 1;
  const key = 'run-' + run.id + '-' + attempt;
  if (await journal.has(at.slice(0, 10), key)) return;
  const jobs = await getJobs(run.id, attempt);
  const details = jobs.filter(job => failures.has(job.conclusion)).map(job => {
    const steps = (job.steps || []).filter(step => failures.has(step.conclusion));
    return [job.name, ...steps.map(step => step.name)].join(' / ');
  });
  const reason = await reasonFor(run.id, attempt);
  if (reason) details.push(reason);
  const url = run.html_url + '/attempts/' + attempt;
  await journal.add(at.slice(0, 10), key, run.display_title || run.name, run.conclusion, at,
    details.join('、') + ' [第 ' + attempt + ' 次執行](' + url + ')');
}

async function main() {
  const now = new Date();
  const today = taipeiClock(now).date;
  const directory = join(data, 'tracking-incidents');
  const progress = join(directory, 'last-check.txt');
  const last = (await readOptional(progress)).trim() || initialDay;
  // 平常重查七天，也涵蓋整個稽核停擺期間。
  const weekAgo = shiftDate(today, -7);
  const earliest = last < weekAgo ? last : weekAgo;
  const start = earliest < initialDay ? initialDay : earliest;
  const runs = [];
  for (let day = start; day <= today; day = shiftDate(day, 7)) {
    const since = new Date(day + 'T00:00:00+08:00');
    const until = new Date(Math.min(+now, +since + 7 * 86400000 - 1000));
    const range = encodeURIComponent(since.toISOString().slice(0, 19) + 'Z..' + until.toISOString().slice(0, 19) + 'Z');
    for (const workflow of ['daily-price-tracking.yml', 'premarket-recovery.yml']) {
      const pages = github('workflows/' + workflow + '/runs?branch=main&per_page=100&created=' + range);
      runs.push(...pages.flatMap(page => page.workflow_runs));
    }
  }
  runs.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const journal = new Journal(directory);
  const getJobs = (id, attempt) => github('runs/' + id + '/attempts/' + attempt + '/jobs?per_page=100').flatMap(page => page.jobs);
  const reasonFor = (id, attempt) => {
    try {
      const log = execFileSync('gh', ['run', 'view', String(id), '--attempt', String(attempt), '--repo', process.env.GITHUB_REPOSITORY, '--log-failed'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      return recordedReason(log);
    } catch {
      return ''; // 過期或尚未就緒的日誌仍可由 jobs API 保留失敗步驟。
    }
  };
  // 補看重跑前的失敗，成功重跑也不能抹掉前一次的結果。
  for (const run of runs) {
    for (let attempt = 1; attempt < run.run_attempt; attempt++) {
      const [previous] = github('runs/' + run.id + '/attempts/' + attempt);
      await auditFailure(previous, journal, getJobs, reasonFor);
    }
    await auditFailure(run, journal, getJobs, reasonFor);
  }
  // 舊工作可能在回查範圍外被重新執行。
  if (process.env.GITHUB_EVENT_NAME === 'workflow_run') {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    await auditFailure(event.workflow_run, journal, getJobs, reasonFor);
  }
  const records = new MonthlyRecords(join(data, 'daily-price-tracking'));
  for (let day = start; day <= today; day = shiftDate(day, 1)) {
    if (day >= firstSlotAudit) await auditDay(day, now, runs, records, journal);
  }
  await journal.save();
  await writeFile(progress, today + '\n');
  const message = '台灣時間 ' + local(now) + '，新增 ' + journal.added.length + ' 筆異常或補齊紀錄。';
  console.log(message);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'new_gaps=' + journal.newGaps + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, message + ' [查看紀錄](https://github.com/' + process.env.GITHUB_REPOSITORY + '/tree/main/data/tracking-incidents)\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
