import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const columnTitles = {
  trade_date: '交易日',
  stock_id: '股票代號',
  forecast_close: '預測收盤價',
  forecast_at: '預測時間',
  actual_close: '實際收盤價',
  actual_recorded_at: '收盤價取得時間',
  model_version: '策略版本'
};
const columns = Object.keys(columnTitles);
const header = Object.values(columnTitles).join(',');
const legacyColumns = [
  'trade_date', 'stock_id', 'forecast_close', 'forecast_at', 'history_through',
  'previous_close', 'model_version', 'actual_close', 'actual_recorded_at', 'actual_source'
];
const legacyHeader = legacyColumns.join(',');

function toDisplayTime(value) {
  return value.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})\+08:00$/, '$1 $2');
}

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
      return '';
    });
    const rows = new Map();
    if (text) {
      const [first, ...lines] = text.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
      if (first !== header && first !== legacyHeader) throw new Error(`Unexpected CSV header in ${filename}`);
      const inputColumns = first === legacyHeader ? legacyColumns : columns;
      const fieldPositions = columns.map((column) => inputColumns.indexOf(column));

      for (const line of lines) {
        const fields = line.split(',');
        const [date, stock] = fields;
        const key = `${date}:${stock}`;
        if (fields.length !== inputColumns.length || !date.startsWith(`${month}-`) || rows.has(key)) {
          throw new Error(`Invalid or duplicate row in ${filename}: ${key}`);
        }
        const row = Object.fromEntries(columns.map((column, index) => [column, fields[fieldPositions[index]]]));
        for (const column of ['forecast_at', 'actual_recorded_at']) {
          const converted = toDisplayTime(row[column]);
          if (converted !== row[column]) this.changed.add(month);
          row[column] = converted;
        }
        rows.set(key, row);
      }
      if (first === legacyHeader) this.changed.add(month);
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
    if (oldRow && Object.entries(values).every(([column, value]) => oldRow[column] === String(value))) return;
    const row = { ...oldRow, trade_date: date, stock_id: stock };
    for (const [column, value] of Object.entries(values)) row[column] = String(value);
    rows.set(key, row);
    this.changed.add(month);
  }

  async save() {
    if (!this.changed.size) return;
    await mkdir(this.directory, { recursive: true });
    for (const month of this.changed) {
      const filename = join(this.directory, `${month}.csv`);
      const sorted = [...this.months.get(month).entries()].sort(([a], [b]) => a.localeCompare(b));
      const lines = sorted.map(([, row]) => columns.map((column) => row[column] ?? '').join(','));
      await writeFile(`${filename}.tmp`, `${[header, ...lines].join('\n')}\n`);
      await rename(`${filename}.tmp`, filename);
    }
    this.changed.clear();
  }
}
