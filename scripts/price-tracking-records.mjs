import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatJSONToCSV, normalizeRecord, parseCSVToJSON } from '../shared/data-parser.js';

export class MonthlyRecords {
  constructor(directory) {
    this.directory = directory;
    this.months = new Map();
    this.changed = new Set();
  }

  async load(month) {
    if (this.months.has(month)) return this.months.get(month);
    const filename = join(this.directory, `${month}.csv`);
    const text = await readFile(filename, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    const rows = new Map();
    if (text !== null) {
      for (const row of parseCSVToJSON(text, month)) rows.set(row.trade_date + ':' + row.stock_id, row);
    }
    this.months.set(month, rows);
    return rows;
  }

  async get(date, stock) {
    const month = date.slice(0, 7);
    const rows = await this.load(month);
    return rows.get(`${date}:${stock}`);
  }

  async update(date, stock, values) {
    const month = date.slice(0, 7);
    const rows = await this.load(month);
    const key = `${date}:${stock}`;
    const oldRow = rows.get(key);
    const row = normalizeRecord({ ...oldRow, ...values, trade_date: date, stock_id: stock });
    if (oldRow && Object.keys(row).every(key => oldRow[key] === row[key])) return;
    rows.set(key, row);
    this.changed.add(month);
  }

  async save() {
    if (!this.changed.size) return;
    await mkdir(this.directory, { recursive: true });
    for (const month of this.changed) {
      const filename = join(this.directory, `${month}.csv`);
      const sorted = [...this.months.get(month).entries()].sort(([a], [b]) => a.localeCompare(b));
      await writeFile(filename + '.tmp', formatJSONToCSV(sorted.map(([, row]) => row), month));
      await rename(`${filename}.tmp`, filename);
    }
    this.changed.clear();
  }
}
