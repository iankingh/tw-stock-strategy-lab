import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { firstPathDate, matchesDaily } from '../shared/five-day.js';
import { onTimeForecast } from '../shared/premarket.js';

async function optionalJSON(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export function readEdition(records, date) {
  return optionalJSON(join(records.directory, 'paths', date + '.json'));
}

export async function forecastGaps(records, date, symbols, edition) {
  const daily = [], paths = [];
  const active = date >= firstPathDate;
  if (active && !edition) edition = await readEdition(records, date);
  const latest = active ? await optionalJSON(join(records.directory, 'paths', 'latest.json')) : {};
  for (const code of symbols) {
    const row = await records.get(date, code);
    if (!onTimeForecast(row, date)) daily.push(code);
    if (active && (!matchesDaily(edition[code], row) || !latest[code] || latest[code] < date)) paths.push(code);
  }
  return { daily, paths };
}

async function atomicJSON(file, value) {
  const temp = file + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n');
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

// 工作流程共用單一寫入佇列；發布日檔與逐檔索引隨月 CSV 一起提交。
export async function saveEdition(records, date, edition) {
  const dir = join(records.directory, 'paths');
  await mkdir(dir, { recursive: true });
  const indexFile = join(dir, 'latest.json');
  const index = await optionalJSON(indexFile);
  for (const code of Object.keys(edition)) {
    if (!index[code] || index[code] < date) index[code] = date;
  }
  await atomicJSON(join(dir, date + '.json'), edition);
  await atomicJSON(indexFile, index);
}
