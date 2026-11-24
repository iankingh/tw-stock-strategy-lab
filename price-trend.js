import { firstPathDate, matchesDaily } from './shared/five-day.js';
import { onTimeForecast } from './shared/premarket.js';
import { isTradingDate, shiftDate, taipeiClock, validDate } from './shared/trading-calendar.js';

export function historyDates(today) {
  const days = [];
  for (let day = today; days.length < 56; day = shiftDate(day, -1)) {
    const open = isTradingDate(day);
    if (open === null) break;
    if (open) days.push(day);
  }
  return days.reverse();
}

async function archiveJSON(name) {
  const res = await fetch('data/daily-price-tracking/paths/' + name + '.json', { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

export async function loadTrend(code, today, fetchRecords) {
  const months = [...new Set(historyDates(today).map(d => d.slice(0, 7)))];
  async function latestPath() {
    const index = await archiveJSON('latest');
    const date = index[code];
    if (!date) return null;
    if (!validDate(date) || date > today) throw new Error('發布日期異常');
    const [edition, rows] = await Promise.all([archiveJSON(date), fetchRecords(date.slice(0, 7))]);
    const row = rows.find(r => r.trade_date === date && r.stock_id === code);
    if (!matchesDaily(edition[code], row)) throw new Error('發布檔與當日紀錄不符');
    return edition[code];
  }
  const [history, edition] = await Promise.all([
    Promise.allSettled(months.map(fetchRecords)),
    latestPath().then(path => ({ path, pathError: false })).catch(() => ({ path: null, pathError: true }))
  ]);
  const rows = history.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  return {
    rows: rows.filter(row => row.stock_id === code),
    historyError: history.some(result => result.status === 'rejected'),
    ...edition
  };
}

export function trendPoints(date, code, candles, rows, path) {
  const days = historyDates(date);
  const actuals = new Map(candles.map(bar => [bar.date.replaceAll('/', '-'), bar.close]));
  const records = new Map(rows.filter(r => r.stock_id === code).map(r => [r.trade_date, r]));
  const future = new Map(path?.targets.map(t => [t.date, t.close]) ?? []);
  const dates = [...new Set([...days, ...[...future.keys()].filter(d => d > date)])].sort();
  return dates.map(day => {
    const row = records.get(day);
    const valid = onTimeForecast(row, day);
    return { date: day, actual: row?.actual_close ?? actuals.get(day) ?? null,
      daily: valid ? row.forecast_close : null, direction: valid ? row.forecast_direction : null, path: future.get(day) ?? null };
  });
}

const el = id => document.getElementById(id);
let points = [], selected, context, currentCode;
let plotLayout;
const number = value => value.toLocaleString('zh-TW', {minimumFractionDigits:2,maximumFractionDigits:2});
const level = value => value == null ? '—' : number(value) + (currentCode === 'TAIEX' ? ' 點' : ' 元');

function draw() {
  const svg = el('trend-plot');
  const w = Math.max(260, svg.clientWidth), h = svg.clientHeight || 200;
  svg.setAttribute('viewBox', [0,0,w,h].join(' '));
  const values = points.flatMap(p => [p.actual,p.daily,p.path]).filter(Number.isFinite);
  if (!values.length) { svg.replaceChildren(); plotLayout = null; return; }
  const right = w - 76, left = 11, bottom = h - 25;
  const min = Math.min(...values), max = Math.max(...values);
  const margin = Math.max((max-min)*0.08, max*0.002, 0.01);
  const low = min-margin, high = max+margin;
  const x = i => left + i * (right-left) / Math.max(1,points.length-1);
  const y = v => 12 + (high-v)/(high-low)*(bottom-12);
  plotLayout = {left, right};
  const svgParts = [];
  for (let i = 0; i <= 3; i++) {
    const val = low + (high-low)*i/3, yy = y(val);
    svgParts.push('<path stroke="#2b3545" d="M'+left+' '+yy+' H'+right+'"/><text x="'+(right+7)+'" y="'+(yy+4)+'">'+number(val)+'</text>');
  }
  for (const i of [0,Math.floor(points.length/2),points.length-1]) {
    svgParts.push('<text x="'+x(i)+'" y="'+(h-5)+'" text-anchor="'+(i === 0 ? 'start' : 'middle')+'">'+points[i].date.slice(5)+'</text>');
  }
  const cursor = points.findIndex(p => p.date === selected);
  if (cursor >= 0) svgParts.push('<path stroke="#94a3b8" stroke-dasharray="2 4" d="M'+x(cursor)+' 8 V'+bottom+'"/>');
  for (const [key,color] of [['actual','#7dd3fc'],['daily','#fbbf24'],['path','#c4b5fd']]) {
    let line = '', connected = false;
    const dots = [];
    for (const [i,p] of points.entries()) {
      if (!Number.isFinite(p[key])) { connected = false; continue; }
      line += (connected ? 'L':'M') + x(i) + ' ' + y(p[key]) + ' ';
      connected = true;
      const radius = key === 'path' ? 4 : key === 'daily' ? 2.7 : i === cursor ? 3 : 1.2;
      dots.push('<circle cx="'+x(i)+'" cy="'+y(p[key])+'" r="'+radius+'" stroke="'+color+'" fill="'+(key === 'path' ? 'none' : color)+'"/>');
    }
    svgParts.push('<path fill="none" stroke="'+color+'" stroke-width="2" '+(key === 'daily' ? 'stroke-dasharray="4 3"' : '')+' d="'+line+'"/>',...dots);
  }
  svg.innerHTML = '<g fill="#aebbd0" font-family="monospace" font-size="10">'+svgParts.join('')+'</g>';
}

function select(date) {
  const row = points.find(p => p.date === date);
  if (!row) return;
  selected = date;
  el('trend-date').value = date;
  const details = ['實收 ' + level(row.actual), '盤前 ' + level(row.daily)];
  if (row.direction) details.push('方向 ' + row.direction);
  if (row.actual != null && row.daily != null) details.push('價差（實收減預估）' + level(row.actual-row.daily));
  if (row.path != null) details.push('五日預估 ' + level(row.path));
  el('trend-readout').textContent = details.join('　');
  draw();
}

export function renderTrend(code, today, data, candles) {
  const changed = context !== code + today;
  context = code + today;
  currentCode = code;
  const path = data?.path;
  points = trendPoints(today, code, candles, data?.rows ?? [], path);
  const selector = el('trend-date');
  selector.replaceChildren(...points.map(p => new Option(p.date, p.date)));
  el('trend-history-status').textContent = data?.historyError ? '部分月份讀取失敗，重新整理可再次查詢。' :
    !data ? '讀取歷來盤前紀錄…' : !points.some(p=>p.actual != null || p.daily != null) ? '此期間尚無收盤紀錄。' : '';
  if (points.length) select(!changed && points.some(p => p.date === selected) ? selected : points.findLast(p=>p.date <= today)?.date ?? points.at(-1).date);
  else { selected = null; el('trend-readout').textContent = '交易日曆尚未涵蓋此期間。'; draw(); }
  el('path-edition').hidden = !path;
  const clock = taipeiClock();
  el('path-status').textContent = data?.pathError ? '五日發布紀錄讀取失敗，請重新整理。' : !data ? '讀取盤前發布紀錄…' :
    isTradingDate(today) === false ? '今日休市。' : today < firstPathDate ? '首個五日預估發布日為 ' + firstPathDate + '。' :
    path?.trade_date === today ? '今日盤前已發布' : clock.hour >= 9 ? '今日已截止，缺少五日預估。' : '今日尚無五日預估。';
  if (!path) return;
  el('path-meta').textContent = '發布 ' + path.generated_at + '（台灣） · 行情截至 ' + path.history_through;
  const trs = path.targets.map(t => {
    const tr = document.createElement('tr');
    for (const value of [t.date, level(t.close), t.method === 'ridge' ? '正則化迴歸' : '基準收盤']) {
      const td = tr.insertCell();
      td.textContent = value;
    }
    return tr;
  });
  el('path-targets').replaceChildren(...trs);
}

export function bindTrend() {
  const svg = el('trend-plot');
  el('trend-date').addEventListener('change', event => select(event.target.value));
  svg.addEventListener('click', event => {
    if (!plotLayout) return;
    const pos = event.clientX - svg.getBoundingClientRect().left;
    const i = Math.round((pos-plotLayout.left)/(plotLayout.right-plotLayout.left)*(points.length-1));
    select(points[Math.max(0,Math.min(points.length-1,i))].date);
  });
  svg.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const i = points.findIndex(p => p.date === selected) + (event.key === 'ArrowRight' ? 1 : -1);
    if (points[i]) select(points[i].date);
  });
  new ResizeObserver(draw).observe(svg);
}
