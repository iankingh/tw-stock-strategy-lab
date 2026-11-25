import { loadTrend, bindTrend, renderTrend } from './price-trend.js';
import * as calendar from './shared/trading-calendar.js';
import { forecastClosePath } from './shared/forecast-model.js';
import { computeTechnicalIndicators, applyBaselineRule } from './shared/indicators.js';
import { parseCSVToJSON } from './shared/data-parser.js';
import { findPremarketRecord } from './shared/premarket.js';

// ==========================================
// 1. 台灣日期與證交所交易日曆
// ==========================================
const FORECAST_SESSIONS = 44;
const CALENDAR_UNAVAILABLE = '證交所日曆涵蓋的交易日不足，暫停產生模擬。';

function todayInTaipei() {
  return calendar.taipeiClock().date;
}

function collectTradingDates(start, count, direction) {
  const dates = [];
  for (let date = start; dates.length < count; date = calendar.shiftDate(date, direction)) {
    const isOpen = calendar.isTradingDate(date);
    if (isOpen === null) return [];
    if (isOpen) dates.push(date.replaceAll('-', '/'));
  }
  return dates;
}

function futureTradingDates(latestDate) {
  const today = todayInTaipei();
  const latest = latestDate?.replaceAll('/', '-');
  const anchor = latest > today ? latest : today;
  return collectTradingDates(calendar.shiftDate(anchor, 1), FORECAST_SESSIONS, 1);
}

// ==========================================
// 2. 葛蘭碧八大買賣點與預設台股資料庫
// ==========================================
const GRANVILLE_RULES_INFO = {
  B1: {
    id: 'B1',
    type: 'BUY',
    name: '買點 1 (B1)：突破走平/翻揚均線',
    shortLabel: 'B1 突破買點',
    granvilleDesc: '均線從下降逐漸走平並開始翻揚，股價從均線下方帶量突破均線之上，為長線多頭趨勢起點。',
    paTrigger: '等待收盤出現「帶量長紅突破K線」或「看漲吞噬」再進場。'
  },
  B2: {
    id: 'B2',
    type: 'BUY',
    name: '買點 2 (B2)：回測上揚均線不破',
    shortLabel: 'B2 回測買點',
    granvilleDesc: '股價位於上揚均線之上，拉回時在均線附近獲得支撐，隨後再度上漲。',
    paTrigger: '切勿直接掛單接刀！等待均線處收出「長下影線錘頭線 (Hammer)」再扣板機。'
  },
  B3: {
    id: 'B3',
    type: 'BUY',
    name: '買點 3 (B3)：假跌破上揚均線 (洗盤)',
    shortLabel: 'B3 假跌破買點',
    granvilleDesc: '股價急跌短暫跌破依然維持上揚趨勢的均線，但隨即強勢站回均線之上，屬於主力誘空洗盤。',
    paTrigger: '跌破後 1~3 日內出現「破底翻長紅K」或「晨星」強勢站回均線。'
  },
  B4: {
    id: 'B4',
    type: 'BUY',
    name: '買點 4 (B4)：負乖離過大 (搶反彈)',
    shortLabel: 'B4 負乖離搶反彈',
    granvilleDesc: '股價暴跌遠離下彎均線，負乖離率過大且跌出布林通道下軌，隨時會產生向均線靠攏的技術性反彈。',
    paTrigger: '布林下軌外出現「長下影線錘頭線」，屬於逆勢短線單，反彈至均線即獲利。'
  },
  S1: {
    id: 'S1',
    type: 'SELL',
    name: '賣點 1 (S1)：跌破走平/下彎均線',
    shortLabel: 'S1 跌破賣點',
    granvilleDesc: '均線在高檔從上升逐漸走平並開始下彎，股價從均線上方帶量跌破均線，代表多頭結束、空頭趨勢確立。',
    paTrigger: '長黑K棒實體貫穿均線（斷頭鍘刀）或高檔「看跌吞噬」，果斷離場。'
  },
  S2: {
    id: 'S2',
    type: 'SELL',
    name: '賣點 2 (S2)：反彈受阻下彎均線',
    shortLabel: 'S2 反彈受阻賣點',
    granvilleDesc: '股價位於下彎均線之下，跌深反彈至均線附近無法突破再度回落，為空頭市場典型的「逃命波」。',
    paTrigger: '觸碰下彎均線時收出「流星線 (長上影線)」或「墓碑線」。'
  },
  S3: {
    id: 'S3',
    type: 'SELL',
    name: '賣點 3 (S3)：假突破下彎均線 (誘多)',
    shortLabel: 'S3 假突破賣點',
    granvilleDesc: '股價短暫突破仍在下彎的均線，但因均線助跌力道強勁，隨即又跌回均線之下，屬於空頭誘多陷阱。',
    paTrigger: '突破隔日立刻出現「烏雲罩頂」或「長黑吞噬」跌回均線之下。'
  },
  S4: {
    id: 'S4',
    type: 'SELL',
    name: '賣點 4 (S4)：正乖離過大 (短線過熱)',
    shortLabel: 'S4 正乖離過大',
    granvilleDesc: '股價連續急漲遠離上揚的均線，正乖離率過大且衝出布林上軌，隨時面臨獲利回吐拉回修正。',
    paTrigger: '高檔出現「流星線」或「十字變盤線」，持有者分批獲利了結，空手者嚴禁追高。'
  }
};

const STOCK_PRESETS = {
  '3481': {
    code: '3481',
    name: '群創',
    enName: 'Innolux',
    sector: '光電面板景氣循環股',
    basePrice: 16.5,
    peakPrice: 21.5,
    dipPrice: 14.8
  },
  '2312': {
    code: '2312',
    name: '金寶',
    enName: 'Kinpo Electronics',
    sector: '電子代工 / AI 伺服器電源題材',
    basePrice: 28.5,
    peakPrice: 36.8,
    dipPrice: 26.2
  },
  '3231': {
    code: '3231',
    name: '緯創',
    enName: 'Wistron',
    sector: 'AI 伺服器核心指標股',
    basePrice: 102.0,
    peakPrice: 128.0,
    dipPrice: 95.0
  },
  '2330': {
    code: '2330',
    name: '台積電',
    enName: 'TSMC',
    sector: '晶圓代工龍頭 / 權值核心',
    basePrice: 960.0,
    peakPrice: 1160.0,
    dipPrice: 915.0
  },
  '2317': {
    code: '2317',
    name: '鴻海',
    enName: 'Foxconn',
    sector: 'AI 伺服器機櫃 / 電子代工龍頭',
    basePrice: 175.0,
    peakPrice: 222.0,
    dipPrice: 165.0
  },
  '2603': {
    code: '2603',
    name: '長榮',
    enName: 'Evergreen Marine',
    sector: '航運高股息景氣股',
    basePrice: 188.0,
    peakPrice: 242.0,
    dipPrice: 176.0
  }
};

const TW_STOCK_NAME_DICT = {
  '3481': '群創', '2409': '友達', '6116': '彩晶', '2312': '金寶',
  '3231': '緯創', '2330': '台積電', '2317': '鴻海', '2382': '廣達',
  '2454': '聯發科', '2603': '長榮', '2609': '陽明', '2615': '萬海',
  '2303': '聯電', '2881': '富邦金', '2882': '國泰金', '2891': '中信金',
  '0050': '元大台灣50', '0056': '元大高股息', '00878': '國泰永續高股息'
};

// ==========================================
// 3. 全域應用程式狀態 (State)
// ==========================================
const state = {
  selectedStockCode: 'TAIEX',
  stockNames: {},
  liveCandlesMap: {},
  manualPrices: { RECENT_FORECAST: {}, FULL_CYCLE: {} },
  quoteStatus: 'loading',
  quoteRequest: 0,
  chartMode: 'RECENT_FORECAST', // 'RECENT_FORECAST' | 'FULL_CYCLE'
  filters: {
    granville: true,
    bollinger: true,
    macd: true,
    priceAction: true,
    showMA60: true
  },
  maPeriod: 20,
  bbStd: 2.0,
  hoveredIndex: null,
  selectedBarDate: null,
  premarket: null,

  chartData: [],
  currentBarIndex: 55
};

const chartPadLeft = 16;
const chartPadRight = 68;

// 台股慣例為紅漲綠跌。
const colors = {
  up: '#ef4444',
  upBg: 'rgba(239, 68, 68, 0.16)',
  upBorder: '#f87171',
  down: '#10b981',
  downBg: 'rgba(16, 185, 129, 0.16)',
  downBorder: '#34d399',
  ma20: '#f59e0b',
  ma60: '#38bdf8',
  bbBand: '#60a5fa'
};

function isMarketIndex() {
  return state.selectedStockCode === 'TAIEX';
}

function displayLevel(value, currency = false) {
  if (!Number.isFinite(value)) return '—';
  if (isMarketIndex()) return value.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' 點';
  return (currency ? '$' : '') + value.toFixed(2);
}

function getCurrentStock() {
  const code = state.selectedStockCode;
  if (code === 'TAIEX') return { code, name: '台灣加權指數', enName: '', sector: '' };
  const preset = STOCK_PRESETS[code];
  return {
    code,
    name: state.stockNames[code] || preset?.name || TW_STOCK_NAME_DICT[code] || `台股 ${code}`,
    enName: preset?.enName || '',
    sector: preset?.sector || '台股觀測標的'
  };
}

// ==========================================
// 4. K 線形態偵測與技術指標 + 未來 2 個月預測演算法
// ==========================================
function enrichCandlesWithIndicatorsAndForecast(rawCandles, maPeriod, bbStdMult, manualPrice, index = false) {
  const futureDates = rawCandles.length >= maPeriod ? futureTradingDates(rawCandles.at(-1).date) : [];
  const forecastCount = futureDates.length;
  const historyBars = rawCandles.map((c, idx) => ({
    index: idx,
    date: c.date,
    open: Number(c.open.toFixed(2)),
    high: Number(c.high.toFixed(2)),
    low: Number(c.low.toFixed(2)),
    close: Number(c.close.toFixed(2)),
    volume: c.volume,
    rule: null,
    paPattern: null,
    divergence: null,
    source: index ? 'twse' : 'finmind',
    isCurrent: idx === rawCandles.length - 1,
    isForecast: false
  }));

  const lastBar = historyBars[historyBars.length - 1];
  if (manualPrice !== undefined) {
    lastBar.close = manualPrice;
    lastBar.high = Math.max(lastBar.high, manualPrice);
    lastBar.low = Math.min(lastBar.low, manualPrice);
    lastBar.source = 'manual';
  }
  const forecastBars = [];
  const forecastCloses = forecastCount ? forecastClosePath(
    historyBars.map((bar) => bar.close), forecastCount, maPeriod
  ) : [];

  for (let f = 1; f <= forecastCount; f++) {
    const dateStr = futureDates[f - 1];
    let rule = null;
    let paPattern = null;

    if (f === 11) {
      rule = 'B2';
      paPattern = '預設情境點 B2（回測均線示意）';
    } else if (f === 31) {
      rule = 'B3';
      paPattern = '預設情境點 B3（回測支撐示意）';
    } else if (f === 41) {
      rule = 'S4';
      paPattern = '預設情境點 S4（正乖離示意）';
    }

    const prevClose = f === 1 ? lastBar.close : forecastBars[f - 2].close;
    const close = forecastCloses[f - 1];
    const span = close * 0.014;
    let open = Number(((prevClose + close) / 2 + (f % 2 === 0 ? -span * 0.28 : span * 0.28)).toFixed(2));
    let high = Number((Math.max(open, close) + span * 0.75).toFixed(2));
    let low = Number((Math.min(open, close) - span * 0.75).toFixed(2));

    if (rule === 'B2' || rule === 'B3') {
      open = Number((close - close * 0.008).toFixed(2));
      low = Number((open - close * 0.03).toFixed(2));
      high = Number((close + close * 0.004).toFixed(2));
    } else if (rule === 'S4') {
      open = Number((close - close * 0.006).toFixed(2));
      high = Number((close + close * 0.03).toFixed(2));
      low = Number((open - close * 0.005).toFixed(2));
    }

    forecastBars.push({
      index: historyBars.length + f - 1,
      date: dateStr,
      open,
      high,
      low,
      close,
      volume: Math.round((lastBar.volume || 45000) * (f <= 11 ? 0.75 : 1.18)),
      rule,
      paPattern,
      divergence: null,
      source: 'forecast',
      isPresetScenario: rule !== null,
      isCurrent: false,
      isForecast: true
    });
  }

  const allBars = [...historyBars, ...forecastBars];
  computeTechnicalIndicators(allBars, maPeriod, bbStdMult);

  applyBaselineRule(allBars[historyBars.length - 1]);
  return allBars.slice(Math.max(0, historyBars.length - 56)).map((bar, index) => ({ ...bar, index }));
}

function generateDemoDataset(code, maPeriod, bbStdMult, manualPrice) {
  const seedPrice = ((parseInt(code, 10) || 2330) % 85) + 18;
  const latestIndex = code === 'TAIEX' ? state.liveCandlesMap.TAIEX?.at(-1)?.close : null;
  const preset = STOCK_PRESETS[code] || (code === 'TAIEX'
    ? (latestIndex
        ? { basePrice: latestIndex * 0.9, peakPrice: latestIndex, dipPrice: latestIndex * 0.84 }
        : { basePrice: 36000, peakPrice: 40500, dipPrice: 33500 })
    : { basePrice: seedPrice, peakPrice: seedPrice * 1.24, dipPrice: seedPrice * 0.86 });
  const scale = manualPrice ? manualPrice / preset.peakPrice : 1;
  const basePrice = preset.basePrice * scale;
  const peakPrice = preset.peakPrice * scale;
  const dipPrice = preset.dipPrice * scale;
  const historyCount = 56;
  const totalBars = historyCount + FORECAST_SESSIONS;
  const todayIdx = historyCount - 1;
  const warmupCount = 60 - historyCount;
  const pastDates = collectTradingDates(todayInTaipei(), historyCount + warmupCount, -1).reverse();
  if (!pastDates.length) return [];
  const allDates = [...pastDates, ...futureTradingDates()];
  const data = [];

  let seed = parseInt(code, 10) || 3481;
  const seededRandom = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  const range = peakPrice - dipPrice;
  const keyNodes = [
    { idx: 0, val: basePrice * 0.95 },
    { idx: 12, val: basePrice * 0.94 },
    { idx: 18, val: basePrice * 1.02, rule: 'B1', pa: '看漲吞噬長紅K', isForecast: false },
    { idx: 27, val: basePrice + range * 0.48 },
    { idx: 34, val: basePrice + range * 0.28, rule: 'B2', pa: '長下影線錘頭線 (Hammer)', isForecast: false },
    { idx: 42, val: basePrice + range * 0.66 },
    { idx: 47, val: basePrice + range * 0.42, rule: 'B3', pa: '假跌破破底翻紅K', isForecast: false },
    { idx: todayIdx, val: peakPrice, rule: 'S4', pa: '今日現況：高檔正乖離過大', isCurrent: true, isForecast: false },
    { idx: 62, val: peakPrice - range * 0.14, isForecast: true },
    { idx: 68, val: basePrice + range * 0.44, rule: 'S1', pa: '帶量長黑貫穿均線 (趨勢反轉)', isForecast: true, divergence: 'TOP' },
    { idx: 74, val: basePrice + range * 0.22, isForecast: true },
    { idx: 80, val: basePrice + range * 0.39, rule: 'S2', pa: '反彈受阻下彎MA (逃命波)', isForecast: true },
    { idx: 86, val: basePrice + range * 0.35, rule: 'S3', pa: '假突破下彎MA (誘多陷阱)', isForecast: true },
    { idx: 94, val: dipPrice, rule: 'B4', pa: '負乖離過大止跌錘頭 (搶反彈)', isForecast: true, divergence: 'BOTTOM' },
    { idx: 99, val: dipPrice + range * 0.25, isForecast: true }
  ];

  const rawCloses = new Array(totalBars).fill(0);
  const nodeMap = {};
  keyNodes.forEach((n) => { nodeMap[n.idx] = n; });

  for (let k = 0; k < keyNodes.length - 1; k++) {
    const startNode = keyNodes[k];
    const endNode = keyNodes[k + 1];
    const span = endNode.idx - startNode.idx;
    for (let i = startNode.idx; i <= endNode.idx; i++) {
      const t = span === 0 ? 0 : (i - startNode.idx) / span;
      const smoothT = (1 - Math.cos(t * Math.PI)) / 2;
      const noise = (seededRandom() - 0.5) * range * 0.024;
      rawCloses[i] = startNode.val + (endNode.val - startNode.val) * smoothT + (i === startNode.idx || i === endNode.idx ? 0 : noise);
    }
  }

  for (let i = 0; i < allDates.length - warmupCount; i++) {
    const dateStr = allDates[warmupCount + i];
    const close = Number(rawCloses[i].toFixed(2));
    const prevClose = i > 0 ? data[i - 1].close : close * 0.995;
    const node = nodeMap[i];

    let open = Number((prevClose + (seededRandom() - 0.5) * range * 0.015).toFixed(2));
    let high = Number((Math.max(open, close) + seededRandom() * range * 0.024).toFixed(2));
    let low = Number((Math.min(open, close) - seededRandom() * range * 0.024).toFixed(2));

    if (node && node.rule) {
      if (node.rule === 'B2' || node.rule === 'B4') {
        open = Number((close - range * 0.018).toFixed(2));
        low = Number((open - range * 0.062).toFixed(2));
        high = Number((close + range * 0.008).toFixed(2));
      } else if (node.rule === 'B1' || node.rule === 'B3') {
        open = Number((close - range * 0.046).toFixed(2));
        low = Number((open - range * 0.015).toFixed(2));
        high = Number((close + range * 0.012).toFixed(2));
      } else if (node.rule === 'S4' || node.rule === 'S2') {
        open = Number((close + range * 0.015).toFixed(2));
        high = Number((open + range * 0.062).toFixed(2));
        low = Number((close - range * 0.01).toFixed(2));
      } else if (node.rule === 'S1' || node.rule === 'S3') {
        open = Number((close + range * 0.05).toFixed(2));
        high = Number((open + range * 0.012).toFixed(2));
        low = Number((close - range * 0.018).toFixed(2));
      }
    }

    data.push({
      index: i,
      date: dateStr,
      open,
      high,
      low,
      close,
      volume: Math.round(35000 + seededRandom() * 35000),
      rule: node?.rule || null,
      paPattern: node?.pa || null,
      divergence: node?.divergence || null,
      source: i > todayIdx ? 'forecast' : 'demo',
      isManuallyAdjusted: i === todayIdx && manualPrice !== undefined,
      isCurrent: i === todayIdx,
      isForecast: i > todayIdx
    });
  }

  // 以圖外的示範 K 線補足基準日所需的 MA60 交易日筆數。
  const warmupBars = allDates.slice(0, warmupCount).map((date) => {
    const price = data[0].open;
    return { date, open: price, high: price, low: price, close: price };
  });
  computeTechnicalIndicators([...warmupBars, ...data], maPeriod, bbStdMult);
  return data;
}

// ==========================================
// 5. 取得並驗證 FinMind 歷史日 K
// ==========================================
async function loadIndexBars() {
  const response = await fetch('data/taiex.json', { cache: 'no-cache', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('無法載入證交所日 K：HTTP ' + response.status);
  return response.json();
}

async function loadStockBars(params) {
  const response = await fetch(`https://api.finmindtrade.com/api/v4/data?${params}`, {
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.msg !== 'success') throw new Error('FinMind 行情異常');
  return payload.data;
}

async function fetchRealTaiwanStockData(code) {
  const request = ++state.quoteRequest;
  state.quoteStatus = 'loading';
  rebuildAndRenderAll();

  const startDate = calendar.shiftDate(todayInTaipei(), -260);
  const params = new URLSearchParams({ dataset: 'TaiwanStockPrice', data_id: code, start_date: startDate });

  try {
    const index = code === 'TAIEX';
    const rows = index ? await loadIndexBars() : await loadStockBars(params);
    if (!Array.isArray(rows)) throw new Error('行情格式異常');
    if (request !== state.quoteRequest) return;

    const candles = new Map();
    const today = todayInTaipei();
    for (const row of rows) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || (!index && String(row.stock_id) !== code) || row.date > today) continue;
      const open = Number(row.open);
      const high = Number(index ? row.high : row.max);
      const low = Number(index ? row.low : row.min);
      const close = Number(row.close);
      if (![open, high, low, close].every(price => Number.isFinite(price) && price > 0)) continue;
      if (high < Math.max(open, close) || low > Math.min(open, close)) continue;
      const date = calendar.formatToSlashDate(row.date);
      const volume = Number(row.Trading_Volume);
      candles.set(date, {
        date, open, high, low, close, volume: index ? null : (Number.isFinite(volume) ? Math.round(volume / 1000) : 0)
      });
    }
    if (candles.size) {
      for (const bar of state.liveCandlesMap[code] ?? []) {
        if (bar.date >= calendar.formatToSlashDate(startDate) && !candles.has(bar.date)) candles.set(bar.date, bar);
      }
      state.liveCandlesMap[code] = [...candles.values()].sort((a, b) => a.date.localeCompare(b.date));
      delete state.manualPrices.RECENT_FORECAST[code];
      state.quoteStatus = 'ready';
    } else {
      state.quoteStatus = 'not-found';
    }
  } catch {
    if (request !== state.quoteRequest) return;
    state.quoteStatus = 'error';
  }

  state.hoveredIndex = null;
  rebuildAndRenderAll();
}

// ==========================================
// 6. 介面渲染與 SVG 圖表繪製核心
// ==========================================
function rebuildAndRenderAll() {
  const code = state.selectedStockCode;
  const history = state.liveCandlesMap[code];
  const manualPrice = state.manualPrices[state.chartMode][code];
  if (state.chartMode === 'FULL_CYCLE') {
    state.chartData = generateDemoDataset(code, state.maPeriod, state.bbStd, manualPrice);
  } else {
    state.chartData = history?.length
      ? enrichCandlesWithIndicatorsAndForecast(isMarketIndex() ? history.slice(-200) : history, state.maPeriod, state.bbStd, manualPrice, isMarketIndex())
      : [];
  }
  state.currentBarIndex = state.chartData.findIndex((bar) => bar.isCurrent);
  const hasData = state.currentBarIndex !== -1;
  document.getElementById('manual-price-details').hidden = !hasData;
  document.getElementById('mobile-market-home').hidden = isMarketIndex();
  document.getElementById('chart-modes').hidden = false;
  document.getElementById('scenario-panel').hidden = false;
  for (const button of document.querySelectorAll('[data-download]')) {
    button.disabled = !hasData;
  }

  renderPresetButtons();
  renderModeButtons();
  renderRuleJumpButtons();
  renderSummaryBanner();
  document.getElementById('intraday-quote-link').hidden = state.chartMode === 'FULL_CYCLE';
  renderPremarketSummary();
  renderFilterButtons();
  renderChartDataSource();
  if (!state.chartData.some(bar => bar.date === state.selectedBarDate)) state.selectedBarDate = null;
  renderScenarioCards();
  renderBottomMatrix();
  renderChartSelection();
  refreshTrend();
}

function refreshTrend() {
  const code = state.selectedStockCode;
  if (code !== 'TAIEX' && !Object.hasOwn(STOCK_PRESETS, code)) return;
  const request = state.premarket;
  renderTrend(code, todayInTaipei(), request?.code === code ? request.trend : null, state.liveCandlesMap[code] ?? []);
}

function renderChartDataSource() {
  const baseCandle = state.chartData[state.currentBarIndex];
  const isDemo = state.chartMode === 'FULL_CYCLE';
  const lastDate = state.liveCandlesMap[state.selectedStockCode]?.at(-1)?.date;
  const cached = state.quoteStatus === 'error' || state.quoteStatus === 'not-found';
  const provider = isMarketIndex() ? '證交所' : 'FinMind';
  const failure = state.quoteStatus === 'not-found' ? `查無可用的${provider}日 K` : `${provider}日 K 查詢失敗`;
  const badge = document.getElementById('status-badge-text');
  const source = document.getElementById('chart-data-source');
  source.classList.remove('hidden', 'md:block');

  if (isDemo) {
    badge.textContent = '示範模式';
    const demoLabel = baseCandle?.isManuallyAdjusted ? '示範資料 · 已校正基準價' : '全圖為示範資料';
    source.textContent = baseCandle ? demoLabel : CALENDAR_UNAVAILABLE;
    if (baseCandle && !baseCandle.isManuallyAdjusted) source.classList.add('hidden', 'md:block');
    return;
  }

  if (state.quoteStatus === 'loading') {
    badge.textContent = `載入 ${state.selectedStockCode} 日 K 中…`;
  } else if (cached) {
    badge.textContent = lastDate ? `${failure}，顯示快取（${lastDate}）` : failure;
  } else {
    badge.textContent = `${provider} 最近交易日 ${lastDate}`;
  }

  if (!baseCandle) {
    source.textContent = cached
      ? `${failure}。可重新查詢、選擇其他標的，或開啟葛蘭碧全週期示範。`
      : `正在載入 ${provider} 歷史日 K。`;
    return;
  }

  const unitLabel = isMarketIndex() ? '（點）' : '';
  const historyLabel = cached ? `快取的 ${provider} 歷史日 K${unitLabel}` : `${provider} 歷史日 K${unitLabel}`;
  const manualLabel = baseCandle.source === 'manual' ? '，基準價已手動校正' : '';
  const hasForecast = state.chartData.at(-1).isForecast;
  if (state.quoteStatus === 'ready' && !manualLabel && hasForecast) source.classList.add('hidden', 'md:block');
  const forecastLabel = hasForecast
    ? '分隔線右側為未來情境模擬。'
    : getForecastUnavailableMessage();
  source.textContent = `${historyLabel}截至 ${lastDate}${manualLabel}。${forecastLabel}`;
}

function getForecastUnavailableMessage() {
  if (state.chartMode === 'FULL_CYCLE') return CALENDAR_UNAVAILABLE;
  const historyLength = state.liveCandlesMap[state.selectedStockCode]?.length;
  if (!historyLength) return '載入歷史日 K 後可檢視情境。';
  if (historyLength < state.maPeriod) return `至少需要 ${state.maPeriod} 筆日 K 才能產生情境。`;
  return CALENDAR_UNAVAILABLE;
}

function getCandleSourceLabel(candle) {
  const labels = {
    twse: '證交所歷史日 K',
    finmind: 'FinMind 歷史日 K',
    manual: '手動校正資料',
    demo: candle.isManuallyAdjusted ? '手動校正的示範資料' : '示範資料',
    forecast: candle.isPresetScenario ? '未來情境模擬（預設情境點）' : '未來情境模擬'
  };
  const label = labels[candle.source];
  return candle.isCurrent ? `${label}（基準）` : label;
}

function getActiveCandle() {
  const selected = state.chartData.find(bar => bar.date === state.selectedBarDate);
  if (selected) return selected;
  if (state.hoveredIndex !== null && state.chartData[state.hoveredIndex]) {
    return state.chartData[state.hoveredIndex];
  }
  return state.chartData[state.currentBarIndex] || state.chartData[state.chartData.length - 1];
}

function renderPresetButtons() {
  const container = document.getElementById('preset-buttons-container');
  if (!container) return;
  container.innerHTML = [{ code: 'TAIEX', name: '大盤' }, ...Object.values(STOCK_PRESETS)]
    .map((st) => {
      const isSelected = state.selectedStockCode === st.code;
      return `<button
        aria-pressed="${isSelected}" data-stock="${st.code}"
        class="px-2.5 py-1.5 rounded-md text-xs font-semibold transition-all ${
          isSelected ? 'bg-amber-500 text-slate-950 shadow' : 'text-slate-300 hover:text-white hover:bg-slate-800/70'
        }"
      >${st.code === 'TAIEX' ? '大盤' : st.code + ' ' + st.name}</button>`;
    })
    .join('');
}

function renderRuleJumpButtons() {
  const container = document.getElementById('rule-jump-buttons');
  if (!container) return;
  const order = ['B1', 'B2', 'B3', 'B4', 'S1', 'S2', 'S3', 'S4'];
  container.innerHTML = order.map(ruleId => {
    const info = GRANVILLE_RULES_INFO[ruleId];
    const color = info.type === 'BUY' ? colors.upBorder : colors.downBorder;
    return `<button type="button" data-rule-jump="${ruleId}" aria-pressed="false" class="chart-button text-xs font-semibold" style="color:${color}">
      ${info.shortLabel}
    </button>`;
  }).join('');
}

function formatIndicator(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value > 0 ? '+' : ''}${formatIndicator(value)}%` : '—';
}

function dailyChangeColor(changePct) {
  return changePct > 0 ? colors.up : changePct < 0 ? colors.down : '#e2e8f0';
}

function findRecordedClose(rows, today, code) {
  let latest = null;
  for (const row of rows) {
    const price = Number(row.actual_close);
    if (row.stock_id !== code || !/^\d{4}-\d{2}-\d{2}$/.test(row.trade_date) || row.trade_date > today ||
        !Number.isFinite(price) || price <= 0 || (latest && row.trade_date <= latest.date)) continue;
    const previous = Number(row.previous_close);
    latest = { price, date: row.trade_date, source: '每日收盤紀錄', changePct: changeFromPrevious(price, previous) };
  }
  return latest;
}

function changeFromPrevious(price, previous) {
  return Number.isFinite(previous) && previous > 0 ? (price / previous - 1) * 100 : null;
}

function latestCloseForStock(today) {
  const history = state.liveCandlesMap[state.selectedStockCode] ?? [];
  const last = history.findLast(bar => bar.date.replaceAll('/', '-') <= today);
  let latest = last ? {
    date: last.date.replaceAll('/', '-'),
    price: last.close,
    changePct: changeFromPrevious(last.close, history[history.indexOf(last) - 1]?.close),
    source: isMarketIndex() ? '證交所日 K' : 'FinMind 日 K'
  } : null;
  const recorded = state.premarket?.code === state.selectedStockCode ? state.premarket.close : null;
  if (recorded && recorded.date <= today && (!latest || recorded.date > latest.date)) latest = recorded;
  return latest;
}

async function loadPremarket(code) {
  const date = todayInTaipei();
  const closed = calendar.isTradingDate(date) === false;
  const cachedClose = state.premarket?.code === code ? state.premarket.close : null;
  const request = { code, date, status: closed ? 'closed' : 'loading', record: null, close: cachedClose };
  state.premarket = request;
  renderPremarketSummary();

  try {
    const month = date.slice(0, 7);
    const cache = new Map();
    const fetchMonth = async month => {
      const response = await fetch(`data/daily-price-tracking/${month}.csv`, {
        cache: 'no-cache',
        signal: AbortSignal.timeout(8000)
      });
      if (response.status === 404) return [];
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseCSVToJSON(await response.text(), month);
    };
    const fetchRecords = key => {
      if (!cache.has(key)) cache.set(key, fetchMonth(key));
      return cache.get(key);
    };
    if (code === 'TAIEX' || Object.hasOwn(STOCK_PRESETS, code)) {
      loadTrend(code, date, fetchRecords).then(trend => {
        if (state.premarket !== request) return;
        request.trend = trend;
        refreshTrend();
      }).catch(() => {
        if (state.premarket !== request) return;
        request.trend = { rows: [], pathError: true, historyError: true };
        refreshTrend();
      });
    }
    const rows = await fetchRecords(month);
    request.record = closed ? null : findPremarketRecord(rows, date, code);
    const close = findRecordedClose(rows, date, code);
    if (close && (!request.close || close.date >= request.close.date)) request.close = close;
    if (!request.close) {
      const previousMonth = calendar.shiftDate(month + '-01', -1).slice(0, 7);
      const previousRows = await fetchRecords(previousMonth).catch(() => []);
      request.close = findRecordedClose(previousRows, date, code);
    }
    if (!closed) request.status = 'ready';
  } catch {
    if (!closed) request.status = 'error';
  }
  if (state.premarket === request) {
    renderPremarketSummary();
    renderSummaryBanner();
  }
}

function renderPremarketSummary() {
  const panel = document.getElementById('premarket-summary');
  panel.hidden = state.chartMode === 'FULL_CYCLE';
  if (panel.hidden) return;
  const request = state.premarket;
  const date = request?.date ?? todayInTaipei();
  const dateLabel = document.getElementById('premarket-date');
  dateLabel.dateTime = date;
  dateLabel.textContent = date;
  const record = request?.record;
  const status = document.getElementById('premarket-status');
  document.getElementById('premarket-values').hidden = !record;
  status.hidden = Boolean(record);
  if (record) {
    document.getElementById('premarket-price').textContent = displayLevel(record.price, true);
    const direction = document.getElementById('premarket-direction');
    direction.textContent = record.direction;
    direction.style.color = dailyChangeColor(record.direction === '漲' ? 1 : record.direction === '跌' ? -1 : 0);
    const time = document.getElementById('premarket-recorded');
    time.dateTime = `${date}T${record.time}+08:00`;
    time.textContent = `${record.time} 記錄（台灣）`;
  } else {
    const messages = {
      loading: '讀取今日盤前紀錄…',
      ready: calendar.taipeiClock().hour >= 9 ? '今日盤前已截止，缺少當日預測' : '今日尚無盤前預測',
      error: '盤前紀錄讀取失敗，請重新整理',
      closed: '今日休市'
    };
    status.textContent = messages[request?.status ?? 'loading'];
  }
}

function renderSummaryBanner() {
  const stock = getCurrentStock();
  const base = state.chartData[state.currentBarIndex];
  const title = isMarketIndex() ? '台灣加權指數（TAIEX）' : `${stock.code} ${stock.name}`;
  document.getElementById('mobile-stock-title').textContent = title;

  document.getElementById('stock-sector-badge').textContent = stock.sector;
  document.getElementById('stock-title').textContent = title;
  document.getElementById('stock-en-name').textContent = stock.enName;
  const latest = state.chartMode === 'FULL_CYCLE'
    ? (base && { price: base.close, date: base.date.replaceAll('/', '-'), changePct: base.changePct, source: '全週期示範' })
    : latestCloseForStock(todayInTaipei());
  const priceLabel = state.chartMode === 'FULL_CYCLE' ? '示範基準價' : '最新收盤';
  document.getElementById('today-price-label').textContent = latest ? `${priceLabel}（${latest.date}）` : priceLabel;

  const priceEl = document.getElementById('stock-current-price');
  priceEl.textContent = latest ? displayLevel(latest.price, true) : '—';
  priceEl.style.color = dailyChangeColor(latest?.changePct);
  document.getElementById('stock-close-source').textContent = latest?.source ?? '';

  document.getElementById('ma20-label-title').textContent = `生命線 MA${state.maPeriod}`;
  document.getElementById('stock-ma20-val').textContent = displayLevel(base?.ma20);
  document.getElementById('stock-ma60-val').textContent = displayLevel(base?.ma60);
  document.getElementById('stock-ma60-summary').hidden = state.maPeriod === 60;
  document.getElementById('stock-summary-status').textContent = base
    ? `基準日乖離率 ${formatPercent(base.bias20)}`
    : '';
  document.getElementById('stock-strategy-advice').textContent =
    base?.source === 'manual' || base?.isManuallyAdjusted ? '已依校正後的基準價重新計算圖表。' : '';
  document.getElementById('manual-price-input').placeholder = base ? formatIndicator(base.close) : '';
  document.getElementById('legend-ma-period').textContent = `MA${state.maPeriod}`;
  document.getElementById('legend-bb-std').textContent = `${state.bbStd}`;
}

function renderMainChartSVG() {
  const stock = getCurrentStock();
  const chartData = state.chartData;
  const activeCandle = getActiveCandle();
  const currentBarIndex = state.currentBarIndex;

  // 更新圖表頂部 HUD 狀態列
  const hud = document.getElementById('chart-top-hud');
  const svgEl = document.getElementById('main-strategy-svg');
  svgEl.hidden = !activeCandle;
  const navigation = document.getElementById('chart-navigation');
  navigation.hidden = !activeCandle;
  if (activeCandle) {
    navigation.querySelector('[data-day-step="-1"]').disabled = activeCandle.index === 0;
    navigation.querySelector('[data-day-step="1"]').disabled = activeCandle.index === chartData.length - 1;
  }
  if (!activeCandle) {
    hud.replaceChildren();
    svgEl.replaceChildren();
    return;
  }
  const badgeStyle = activeCandle.isForecast
    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
    : 'bg-sky-500/20 text-sky-300 border-sky-500/40';

  hud.innerHTML = `
    <div class="flex flex-wrap items-center gap-2.5">
      <span data-stock-heading class="hidden font-sans font-bold text-white text-sm md:inline"></span>
      <span class="px-2.5 py-1 rounded-md bg-amber-500/20 border border-amber-500/50 text-amber-300 font-bold flex items-center gap-1.5 shadow-sm">
        ${activeCandle.dateWithDay || activeCandle.date}
      </span>
      <span class="px-2 py-0.5 rounded border font-sans text-[11px] font-medium ${badgeStyle}">${getCandleSourceLabel(activeCandle)}</span>
      <span>開 <strong class="text-slate-200">${displayLevel(activeCandle.open)}</strong></span>
      <span>高 <strong class="text-slate-200">${displayLevel(activeCandle.high)}</strong></span>
      <span>低 <strong class="text-slate-200">${displayLevel(activeCandle.low)}</strong></span>
      <span>收 <strong style="color:${dailyChangeColor(activeCandle.changePct)}">${displayLevel(activeCandle.close)} (${formatPercent(activeCandle.changePct)})</strong></span>
    </div>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      ${state.selectedBarDate ? '<span class="text-amber-300">已鎖定日期</span>' : ''}
      ${activeCandle.rule ? `<span class="font-semibold text-slate-100">${GRANVILLE_RULES_INFO[activeCandle.rule].shortLabel}</span>` : ''}
      <span style="color:${colors.ma20}">MA${state.maPeriod}: <strong>${displayLevel(activeCandle.ma20)}</strong></span>
      ${state.maPeriod !== 60 ? `<span style="color:${colors.ma60}">MA60: <strong>${displayLevel(activeCandle.ma60)}</strong></span>` : ''}
      ${state.filters.bollinger ? `<span class="text-blue-400">BB(${state.bbStd}σ): ${activeCandle.bbLower === null ? '—' : `${displayLevel(activeCandle.bbLower)} ～ ${displayLevel(activeCandle.bbUpper)}`}</span>` : ''}
      <span class="text-slate-300">乖離率: <strong class="${Math.abs(activeCandle.bias20) > 5 ? 'text-amber-400' : 'text-slate-200'}">${formatPercent(activeCandle.bias20)}</strong></span>
    </div>
  `;

  hud.querySelector('[data-stock-heading]').textContent = `${stock.code} (${stock.name})`;

  // SVG 座標尺寸計算
  const width = Math.max(240, svgEl.clientWidth);
  const compact = width < 580;
  const mainHeight = compact ? 225 : 355;
  const macdHeight = state.filters.macd ? (compact ? 86 : 116) : 0;
  const bottomAxisHeight = 42;
  const totalHeight = mainHeight + macdHeight + bottomAxisHeight;
  const padLeft = chartPadLeft;
  const padRight = chartPadRight;
  const padTop = 28;
  const padBottom = 20;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = mainHeight - padTop - padBottom;

  svgEl.setAttribute('viewBox', `0 0 ${width} ${totalHeight}`);

  let minPrice = Infinity;
  let maxPrice = -Infinity;
  chartData.forEach((bar) => {
    const prices = [bar.low, bar.high];
    if (state.filters.bollinger) prices.push(bar.bbLower, bar.bbUpper);
    if (state.filters.granville) prices.push(bar.ma20);
    if (state.filters.showMA60) prices.push(bar.ma60);
    const valid = prices.filter(Number.isFinite);
    minPrice = Math.min(minPrice, ...valid);
    maxPrice = Math.max(maxPrice, ...valid);
  });
  const padding = Math.max((maxPrice - minPrice) * 0.13, maxPrice * 0.005, 0.01);
  const yMin = minPrice - padding;
  const yMax = maxPrice + padding;

  const getY = (price) => padTop + plotHeight - ((price - yMin) / (yMax - yMin)) * plotHeight;
  const getX = (idx) => padLeft + ((idx + 0.5) / chartData.length) * plotWidth;

  const yTicks = [];
  for (let i = 0; i <= 6; i++) {
    const val = yMin + ((yMax - yMin) / 6) * i;
    yTicks.push({ value: val.toFixed(isMarketIndex() ? 2 : 1), y: getY(val) });
  }

  const macdTop = mainHeight + 22;
  const macdPlotHeight = macdHeight - 32;
  let maxMacd = 0.01;
  chartData.forEach((d) => {
    maxMacd = Math.max(maxMacd, Math.abs(d.dif), Math.abs(d.dea), Math.abs(d.macdHist));
  });
  maxMacd *= 1.25;
  const macdZeroY = macdTop + macdPlotHeight / 2;
  const getMacdY = (val) => macdZeroY - (val / maxMacd) * (macdPlotHeight / 2);

  // 不重疊 X 軸時間刻度
  const xTicks = [];
  let lastTickX = -999;
  const stepCount = Math.max(1, Math.ceil(chartData.length / (compact ? 3 : 6)));
  for (let i = 0; i < chartData.length; i++) {
    const x = getX(i);
    const isCandidate = i % stepCount === 0 || i === currentBarIndex || i === chartData.length - 1;
    if (isCandidate && x - lastTickX >= (compact ? 65 : 102) && x <= width - padRight - 30 && x >= padLeft + 28) {
      xTicks.push({ index: i, date: chartData[i].date, isToday: i === currentBarIndex, x });
      lastTickX = x;
    }
  }

  const todayX = getX(currentBarIndex) + plotWidth / chartData.length / 2;
  const forecastWidth = Math.max(0, width - padRight - todayX);
  const lastBar = chartData.at(-1);
  const hasForecast = lastBar.isForecast;

  let svgParts = [];

  // Defs
  svgParts.push(`
    <defs>
      <linearGradient id="bbFillGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.16" />
        <stop offset="50%" stop-color="#3b82f6" stop-opacity="0.06" />
        <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.16" />
      </linearGradient>
      <linearGradient id="forecastBgGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.04" />
        <stop offset="100%" stop-color="#f59e0b" stop-opacity="0.12" />
      </linearGradient>
    </defs>
  `);

  // 今日基準與未來 2 個月預測區背景
  if (hasForecast) svgParts.push(`
    <g>
      <rect x="${todayX}" y="20" width="${forecastWidth}" height="${mainHeight - 36}" fill="url(#forecastBgGrad)" />
      <line x1="${todayX}" y1="20" x2="${todayX}" y2="${totalHeight - 34}" stroke="#38bdf8" stroke-width="1.8" stroke-dasharray="5,4" />
      <text x="${width - padRight - 5}" y="14" fill="#fbbf24" font-size="11" font-weight="bold" text-anchor="end">未來情境模擬</text>
    </g>
  `);

  // 水平價格網格線
  yTicks.forEach((t) => {
    svgParts.push(`
      <g>
        <line x1="${padLeft}" y1="${t.y}" x2="${width - padRight}" y2="${t.y}" stroke="#1e293b" stroke-width="1" />
        <text x="${width - padRight + 8}" y="${t.y + 4}" fill="#94a3b8" font-size="11" font-family="monospace">${t.value}</text>
      </g>
    `);
  });
  svgParts.push(`<text x="${width - 12}" y="16" fill="#cbd5e1" font-size="11" font-weight="bold" text-anchor="end">${isMarketIndex() ? '指數（點）' : '股價 (TWD)'}</text>`);

  const indicatorPoints = (key) => chartData.flatMap((bar, index) =>
    Number.isFinite(bar[key]) ? [`${getX(index)},${getY(bar[key])}`] : []
  );

  // 布林通道帶
  if (state.filters.bollinger) {
    const upperPts = indicatorPoints('bbUpper');
    const lowerPts = indicatorPoints('bbLower');
    if (upperPts.length > 1) {
      const polyPts = [...upperPts, ...[...lowerPts].reverse()].join(' ');
      svgParts.push(`
        <g>
          <polygon points="${polyPts}" fill="url(#bbFillGrad)" />
          <polyline fill="none" stroke="${colors.bbBand}" stroke-width="1.2" stroke-opacity="0.7" points="${upperPts.join(' ')}" />
          <polyline fill="none" stroke="${colors.bbBand}" stroke-width="1.2" stroke-opacity="0.7" points="${lowerPts.join(' ')}" />
        </g>
      `);
    }
  }

  if (state.filters.showMA60 && (state.maPeriod !== 60 || !state.filters.granville)) {
    const points = indicatorPoints('ma60');
    if (points.length > 1) {
      svgParts.push(`<polyline fill="none" stroke="${colors.ma60}" stroke-width="1.8" stroke-dasharray="4,3" points="${points.join(' ')}" />`);
    }
  }
  if (state.filters.granville) {
    const points = indicatorPoints('ma20');
    if (points.length > 1) {
      svgParts.push(`<polyline fill="none" stroke="${colors.ma20}" stroke-width="2.8" points="${points.join(' ')}" />`);
    }
  }

  // K 線 (Candlesticks)
  const candleWidth = Math.min(plotWidth / chartData.length * 0.86, Math.max(3.8, (plotWidth / chartData.length) * 0.62));
  chartData.forEach((d, i) => {
    const x = getX(i);
    const up = d.close >= d.open;
    const cColor = up ? colors.up : colors.down;
    const highY = getY(d.high);
    const lowY = getY(d.low);
    const bodyTop = getY(Math.max(d.open, d.close));
    const bodyBottom = getY(Math.min(d.open, d.close));
    const bodyH = Math.max(2.5, bodyBottom - bodyTop);
    const isSelectedRule = d.rule && d.index === activeCandle.index;

    svgParts.push('<g>');
    if (state.filters.priceAction && d.rule) {
      svgParts.push(`
        <circle cx="${x}" cy="${up ? lowY + 4 : highY - 4}" r="${isSelectedRule ? 7 : 4}"
          fill="${up ? colors.upBg : colors.downBg}"
          stroke="${isSelectedRule ? '#fbbf24' : cColor}"
          stroke-width="${isSelectedRule ? '2' : '1'}" />
      `);
    }
    svgParts.push(`
      <line x1="${x}" y1="${highY}" x2="${x}" y2="${lowY}" stroke="${cColor}" stroke-width="1.3" stroke-opacity="${d.isForecast ? 0.8 : 1}" />
      <rect x="${x - candleWidth / 2}" y="${bodyTop}" width="${candleWidth}" height="${bodyH}" fill="${cColor}" fill-opacity="${d.isForecast ? 0.76 : 1}" rx="0.8" />
    </g>`);
  });

  // 葛蘭碧八大買賣點標籤
  if (state.filters.granville) {
    const labels = [];
    const signals = chartData.filter(bar => GRANVILLE_RULES_INFO[bar.rule]);
    signals.sort((a, b) => Number(b.index === activeCandle.index) - Number(a.index === activeCandle.index));
    for (const bar of signals) {
      const isBuy = GRANVILLE_RULES_INFO[bar.rule].type === 'BUY';
      const x = getX(bar.index);
      const anchorY = getY(isBuy ? bar.low : bar.high);
      const offset = isBuy ? 1 : -1;
      const labelX = Math.min(width - padRight - 15, Math.max(padLeft + 15, x));
      const color = bar.index === activeCandle.index ? '#fbbf24' : isBuy ? colors.upBorder : colors.downBorder;
      const labelY = [17, 37, 57].map(distance => anchorY + offset * distance).find(y =>
        y >= 32 && y <= mainHeight - 12 &&
        !labels.some(label => Math.abs(label.x - labelX) < 32 && Math.abs(label.y - y) < 18)
      );
      if (labelY === undefined) {
        svgParts.push(`<circle data-bar-index="${bar.index}" cx="${x}" cy="${anchorY}" r="4" fill="${color}" class="cursor-pointer" />`);
        continue;
      }
      labels.push({ x: labelX, y: labelY });
      svgParts.push(`
        <g data-bar-index="${bar.index}" class="cursor-pointer">
          <line x1="${x}" y1="${anchorY}" x2="${labelX}" y2="${labelY}" stroke="${color}" />
          <rect x="${labelX - 14}" y="${labelY - 8}" width="28" height="16" rx="4" fill="#0f172a" stroke="${color}" />
          <text x="${labelX}" y="${labelY + 4}" fill="#f8fafc" font-size="11" font-family="monospace" text-anchor="middle">${bar.rule}</text>
        </g>
      `);
    }
  }

  // 下方 MACD 面板
  if (state.filters.macd) {
    const barW = (plotWidth / chartData.length) * 0.6;
    const macdBarsHtml = chartData
      .map((d, i) => {
        const x = getX(i);
        const y = getMacdY(d.macdHist);
        const barColor = d.macdHist >= 0 ? colors.up : colors.down;
        return `<rect x="${x - barW / 2}" y="${Math.min(y, macdZeroY)}" width="${barW}" height="${Math.max(1.5, Math.abs(y - macdZeroY))}" fill="${barColor}" fill-opacity="0.65" />`;
      })
      .join('');

    const difPts = chartData.map((d, i) => `${getX(i)},${getMacdY(d.dif)}`).join(' ');
    const deaPts = chartData.map((d, i) => `${getX(i)},${getMacdY(d.dea)}`).join(' ');

    svgParts.push(`
      <g>
        <line x1="${padLeft}" y1="${mainHeight}" x2="${width - padRight}" y2="${mainHeight}" stroke="#334155" stroke-width="1.5" />
        <text x="${padLeft + 6}" y="${macdTop - 4}" fill="#cbd5e1" font-size="10.5" font-weight="bold">
          MACD (12,26,9) · DIF ${isMarketIndex() ? formatIndicator(activeCandle.dif) : activeCandle.dif} / DEA ${isMarketIndex() ? formatIndicator(activeCandle.dea) : activeCandle.dea}
        </text>
        <line x1="${padLeft}" y1="${macdZeroY}" x2="${width - padRight}" y2="${macdZeroY}" stroke="#475569" stroke-width="1" stroke-dasharray="3,3" />
        <text x="${width - padRight + 8}" y="${macdZeroY + 4}" fill="#94a3b8" font-size="10" font-family="monospace">0.00</text>
        ${macdBarsHtml}
        <polyline fill="none" stroke="#e879f9" stroke-width="1.6" points="${difPts}" />
        <polyline fill="none" stroke="#38bdf8" stroke-width="1.5" points="${deaPts}" />
      </g>
    `);
  }

  // 底部不重疊 X 軸時間刻度
  svgParts.push(`<line x1="${padLeft}" y1="${totalHeight - 34}" x2="${width - padRight}" y2="${totalHeight - 34}" stroke="#334155" stroke-width="1" />`);
  const activeX = getX(activeCandle.index);
  const pillWidth = compact ? 104 : 136;
  const clampedPillX = Math.min(width - padRight - pillWidth / 2, Math.max(padLeft + pillWidth / 2, activeX));
  xTicks.forEach((tick) => {
    if (Math.abs(tick.x - clampedPillX) < (compact ? 65 : 107)) return;
    svgParts.push(`
      <g>
        <line x1="${tick.x}" y1="${totalHeight - 34}" x2="${tick.x}" y2="${totalHeight - 28}" stroke="${tick.isToday ? '#38bdf8' : '#64748b'}" stroke-width="${tick.isToday ? '1.8' : '1'}" />
        <text x="${tick.x}" y="${totalHeight - 12}" fill="${tick.isToday ? '#38bdf8' : '#94a3b8'}" font-size="11" font-weight="${tick.isToday ? 'bold' : 'normal'}" font-family="monospace" text-anchor="middle">${tick.date}</text>
      </g>
    `);
  });

  // 互動十字線 + 底部黃金膠囊日期 YYYY/MM/DD (週X)
  const activePriceY = getY(activeCandle.close);
  svgParts.push(`
    <g pointer-events="none">
      <line x1="${activeX}" y1="20" x2="${activeX}" y2="${totalHeight - 34}" stroke="#fbbf24" stroke-width="1.2" stroke-dasharray="3,3" />
      <line x1="${padLeft}" y1="${activePriceY}" x2="${width - padRight}" y2="${activePriceY}" stroke="#fbbf24" stroke-width="1.2" stroke-dasharray="3,3" />
      <rect x="${width - padRight + 2}" y="${activePriceY - 10}" width="64" height="20" rx="4" fill="#f59e0b" />
      <text x="${width - padRight + 34}" y="${activePriceY + 4}" fill="#0f172a" font-size="11" font-weight="bold" font-family="monospace" text-anchor="middle">${activeCandle.close.toFixed(2)}</text>

      <rect x="${clampedPillX - pillWidth / 2 - 4}" y="${totalHeight - 32}" width="${pillWidth + 8}" height="28" rx="6" fill="#0f172a" />
      <rect x="${clampedPillX - pillWidth / 2}" y="${totalHeight - 29}" width="${pillWidth}" height="22" rx="5" fill="#f59e0b" stroke="#fef08a" stroke-width="1.2" />
      <text x="${clampedPillX}" y="${totalHeight - 14}" fill="#0f172a" font-size="11" font-weight="bold" font-family="monospace" text-anchor="middle">${activeCandle.dateWithDay || activeCandle.date}</text>
    </g>
  `);

  svgEl.innerHTML = svgParts.join('');
}

function renderRightSidebar() {
  const c = getActiveCandle();
  const dateLabel = document.getElementById('checklist-date-subtitle');
  const scoreEl = document.getElementById('checklist-score-val');
  const items = document.getElementById('checklist-items-container');
  if (!c) {
    dateLabel.textContent = '';
    scoreEl.textContent = '—';
    scoreEl.className = 'text-xl font-mono font-bold text-slate-400';
    items.replaceChildren();
    return;
  }

  dateLabel.textContent = `${c.dateWithDay || c.date}　${getCandleSourceLabel(c)}　收盤 ${displayLevel(c.close)}${isMarketIndex() ? '' : ' 元'}`;

  const unavailable = { status: 'UNAVAILABLE', title: '資料不足', detail: `至少需要 ${state.maPeriod} 筆日 K。` };
  const bbStatus = c.isSqueeze === null ? unavailable : {
    status: c.isSqueeze ? 'WARN' : 'PASS',
    title: c.isSqueeze ? '布林通道收縮' : '布林通道未達收縮門檻',
    detail: `通道寬度 ${formatIndicator(c.bbBandwidth)}%。`
  };

  let granvilleStatus = unavailable;
  if (c.bias20 !== null) {
    const aboveAverage = c.close >= c.ma20;
    granvilleStatus = {
      status: aboveAverage ? 'PASS' : 'FAIL',
      title: `收盤位於 MA${state.maPeriod} ${aboveAverage ? '上方或持平' : '下方'}`,
      detail: `均線 ${displayLevel(c.ma20)}${isMarketIndex() ? '' : ' 元'}，乖離率 ${formatPercent(c.bias20)}。`
    };
    if (Math.abs(c.bias20) > 5.2) {
      granvilleStatus.status = 'WARN';
      granvilleStatus.title = c.bias20 > 0 ? '正乖離偏大' : '負乖離偏大';
    }
  }

  const macdStatus = c.dif >= 0
    ? { status: c.divergence === 'TOP' ? 'FAIL' : 'PASS', title: c.divergence === 'TOP' ? '警訊：MACD 出現高檔頂背離！' : `MACD 位於零軸之上 (DIF: ${c.dif})`, detail: c.divergence === 'TOP' ? '股價創高但 MACD 未創高，提防趨勢反轉 (S1)。' : '選定日的 DIF 大於或等於零。' }
    : { status: c.divergence === 'BOTTOM' ? 'PASS' : 'WARN', title: c.divergence === 'BOTTOM' ? '訊號：MACD 出現低檔底背離！' : `MACD 位於零軸之下 (DIF: ${c.dif})`, detail: '選定日的 DIF 小於零。' };

  const isBullCandle = c.close >= c.open;
  const paStatus = c.paPattern
    ? { status: c.rule?.startsWith('B') || c.autoPA?.bias === 'BULL' ? 'PASS' : 'WARN', title: c.isPresetScenario ? c.paPattern : `關鍵K線訊號：${c.paPattern}`, detail: c.isPresetScenario ? '情境模型在固定交易日安排的點位。' : '依圖中資料標記的 K 線型態。' }
    : { status: isBullCandle ? 'PASS' : 'WARN', title: isBullCandle ? '一般紅 K 棒' : '一般綠 K 棒', detail: '此根 K 線沒有標記特定型態。' };

  let score = 50;
  if (bbStatus.status === 'PASS') score += 12;
  if (granvilleStatus.status === 'PASS') score += 18;
  if (granvilleStatus.status === 'FAIL') score -= 18;
  if (macdStatus.status === 'PASS') score += 12;
  if (macdStatus.status === 'FAIL') score -= 20;
  if (c.rule === 'B2' || c.rule === 'B3' || c.rule === 'B1') score += 15;
  if (c.rule === 'S4') score -= 12;
  score = Math.min(98, Math.max(25, score));

  scoreEl.className = `text-xl font-mono font-bold ${score >= 75 ? 'text-emerald-400' : score >= 55 ? 'text-amber-400' : 'text-rose-400'}`;
  if (c.ma20 === null) {
    scoreEl.className = 'text-xl font-mono font-bold text-slate-400';
    scoreEl.textContent = '—';
  } else {
    scoreEl.innerHTML = `${score} <span class="text-xs font-normal">/ 100</span>`;
  }

  const steps = [
    { step: '步驟 1. 布林通道 (環境過濾)', item: bbStatus },
    { step: '步驟 2. 葛蘭碧均線位階 (趨勢與乖離)', item: granvilleStatus },
    { step: '步驟 3. MACD 動能確認 (防假突破/背離)', item: macdStatus },
    { step: '步驟 4. Price Action (關鍵K線板機)', item: paStatus }
  ];

  items.innerHTML = steps
    .map(({ step, item }) => {
      const icon = item.status === 'PASS' ? '<span class="text-emerald-400 font-bold">✔</span>' : item.status === 'WARN' ? '<span class="text-amber-400 font-bold">⚠</span>' : item.status === 'FAIL' ? '<span class="text-rose-400 font-bold">✖</span>' : '<span class="text-slate-400">—</span>';
      return `
        <div class="flex items-start gap-2.5 py-2.5">
          <div class="mt-0.5 text-sm">${icon}</div>
          <div class="text-xs">
            <div class="text-[11px] text-slate-400 font-medium">${step}</div>
            <div class="font-bold text-slate-100 mt-0.5">${item.title}</div>
            <div class="text-slate-400 text-[11px] leading-relaxed mt-0.5">${item.detail}</div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderScenarioCards() {
  const future = state.chartData.filter(bar => bar.isForecast);
  const container = document.getElementById('scenario-cards-container');
  const title = document.getElementById('scenario-box-title');
  const demo = state.chartMode === 'FULL_CYCLE';
  title.textContent = demo ? '示範情境點' : '未來情境模擬';
  if (!future.length) {
    container.textContent = getForecastUnavailableMessage();
    return;
  }

  const points = future.filter(bar => bar.rule && (demo || bar.isPresetScenario));
  const period = document.createElement('p');
  period.className = 'text-slate-400';
  period.textContent = `${future[0].date} ～ ${future.at(-1).date}`;
  container.innerHTML = points.map(bar => `
    <button type="button" data-select-bar="${bar.index}" aria-pressed="false"
      class="flex min-h-11 w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700 px-3 py-1.5 text-left hover:border-amber-400">
      <span><span class="font-semibold text-slate-100">${GRANVILLE_RULES_INFO[bar.rule].shortLabel}</span>
      <span class="block font-mono text-slate-400">${bar.date}</span></span>
      <strong class="font-mono text-amber-300">${displayLevel(bar.close, true)}</strong>
    </button>`
  ).join('');
  if (!points.length) container.textContent = '這段期間沒有情境點';
  container.prepend(period);
}

function renderBottomMatrix() {
  const grid = document.getElementById('granville-matrix-grid');
  if (!grid) return;
  grid.innerHTML = Object.values(GRANVILLE_RULES_INFO)
    .map((rule) => {
      const isBuy = rule.type === 'BUY';
      return `
        <button type="button" data-rule-jump="${rule.id}" aria-pressed="false"
          class="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-left hover:border-slate-600">
          <div>
            <div class="flex items-center justify-between mb-1.5">
              <span class="text-xs font-mono font-bold px-2 py-0.5 rounded" style="background-color:${isBuy ? colors.upBg : colors.downBg}; color:${isBuy ? colors.up : colors.down}">
                ${rule.shortLabel}
              </span>
              <span class="text-slate-500 text-xs">➔</span>
            </div>
            <p class="text-xs font-semibold text-slate-200">${rule.name}</p>
            <p class="text-[11px] text-slate-400 mt-1 leading-relaxed">${rule.granvilleDesc}</p>
          </div>
          <div class="mt-2.5 pt-2 border-t border-slate-800/80 text-[11px] text-amber-300/90 font-medium truncate">
            板機：${rule.paTrigger}
          </div>
        </button>
      `;
    })
    .join('');
}

// ==========================================
// 7. 互動控制與檔案匯出
// ==========================================
function showToast(message) {
  const toast = document.getElementById('toast-notification');
  const text = document.getElementById('toast-text');
  text.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 3200);
}

function setStockControls(open) {
  document.getElementById('stock-controls').dataset.open = String(open);
  document.getElementById('stock-controls-toggle').setAttribute('aria-expanded', String(open));
}

function selectStock(code, name) {
  if (name) state.stockNames[code] = name;
  state.selectedStockCode = code;
  const tracked = code === 'TAIEX' || Object.hasOwn(STOCK_PRESETS, code);
  document.getElementById('price-trend').hidden = !tracked;
  const technical = document.getElementById('technical-view');
  technical.open = !tracked;
  technical.querySelector('summary').textContent = '歷史日 K、44 日教學情境與技術分析';
  state.chartMode = 'RECENT_FORECAST';
  state.selectedBarDate = null;
  state.hoveredIndex = null;
  const toggle = document.getElementById('stock-controls-toggle');
  const returningHome = document.activeElement?.id === 'mobile-market-home';
  if (toggle.offsetWidth && (returningHome || document.getElementById('stock-controls').contains(document.activeElement))) toggle.focus();
  setStockControls(false);
  setRuleStatus('');
  loadPremarket(code);
  fetchRealTaiwanStockData(code);
}

function renderModeButtons() {
  const activeClass = 'bg-amber-500 text-slate-950';
  const inactiveClass = 'text-slate-300 hover:text-white';
  for (const [id, mode] of [['mode-btn-forecast', 'RECENT_FORECAST'], ['mode-btn-fullcycle', 'FULL_CYCLE']]) {
    const button = document.getElementById(id);
    const active = state.chartMode === mode;
    button.className = `min-h-8 px-3 rounded text-sm font-semibold ${active ? activeClass : inactiveClass}`;
    button.setAttribute('aria-pressed', String(active));
  }
}

function setChartMode(mode) {
  if (state.chartMode === mode) return;
  state.chartMode = mode;
  if (mode === 'RECENT_FORECAST' && state.premarket?.date !== todayInTaipei()) loadPremarket(state.selectedStockCode);
  state.selectedBarDate = null;
  state.hoveredIndex = null;
  setRuleStatus('');
  rebuildAndRenderAll();
}

function renderFilterButtons() {
  const layers = { granville: 'granville', bollinger: 'bollinger', macd: 'macd', priceAction: 'pa' };
  for (const [key, id] of Object.entries(layers)) {
    const button = document.getElementById(`filter-btn-${id}`);
    button.setAttribute('aria-pressed', String(state.filters[key]));
    button.className = `chart-button ${state.filters[key] ? 'bg-slate-800 font-semibold' : 'text-slate-400'}`;
  }
  const showSeasonLine = state.filters.showMA60 && (state.maPeriod !== 60 || !state.filters.granville);
  document.querySelector('[data-legend="granville"]').hidden = !state.filters.granville;
  document.querySelector('[data-legend="ma60"]').hidden = !showSeasonLine;
  document.querySelector('[data-legend="bollinger"]').hidden = !state.filters.bollinger;
}

function toggleFilter(key) {
  state.filters[key] = !state.filters[key];
  renderFilterButtons();
  renderMainChartSVG();
}

function setRuleStatus(message) {
  const status = document.getElementById('rule-jump-status');
  status.hidden = !message;
  status.textContent = message;
}

function renderChartSelection() {
  const selected = state.chartData.find(bar => bar.date === state.selectedBarDate);
  for (const el of document.querySelectorAll('[data-select-bar]')) {
    el.setAttribute('aria-pressed', String(selected?.index === Number(el.dataset.selectBar)));
  }
  for (const el of document.querySelectorAll('[data-rule-jump]')) {
    el.setAttribute('aria-pressed', String(selected?.rule === el.dataset.ruleJump));
  }
  const active = getActiveCandle();
  document.getElementById('chart-selection-status').textContent = active
    ? `${selected ? '已選取' : '基準日'} ${active.dateWithDay}，收盤 ${formatIndicator(active.close)}`
    : '';
  renderMainChartSVG();
  renderRightSidebar();
}

function selectRule(ruleId, barIndex) {
  const targetBar = barIndex === undefined
    ? state.chartData.find(bar => bar.rule === ruleId)
    : state.chartData[barIndex];
  if (targetBar?.rule !== ruleId) {
    setRuleStatus(`此圖沒有 ${ruleId} 訊號。`);
    return;
  }
  focusBarIndex(targetBar.index, true);
}

function focusBarIndex(idx, jump = false) {
  const bar = state.chartData[idx];
  if (!bar) return;
  setRuleStatus('');
  state.selectedBarDate = bar.date;
  state.hoveredIndex = null;
  renderChartSelection();
  if (jump) {
    document.getElementById('chart-top-hud').scrollIntoView({ block: 'nearest' });
    document.getElementById('main-strategy-svg').focus({ preventScroll: true });
  }
}

function moveChartSelection(step) {
  const candle = getActiveCandle();
  if (candle) focusBarIndex(Math.min(state.chartData.length - 1, Math.max(0, candle.index + step)));
}

function resetChartSelection() {
  setRuleStatus('');
  state.selectedBarDate = null;
  state.hoveredIndex = null;
  renderChartSelection();
}

function updateIndicatorParams() {
  state.maPeriod = Number(document.getElementById('select-ma-period').value);
  state.bbStd = Number(document.getElementById('select-bb-std').value);
  state.hoveredIndex = null;
  setRuleStatus('');
  rebuildAndRenderAll();
}

// 下載 CSV 圖表資料
function exportChartDataCSV() {
  if (!state.chartData.length) return;
  const stock = getCurrentStock();
  const levels = isMarketIndex() ? ['開盤指數(點)', '最高指數(點)', '最低指數(點)', '收盤指數(點)'] : ['開盤價', '最高價', '最低價', '收盤價'];
  const headers = ['日期(YYYY/MM/DD)', '區間類型', ...levels, '漲跌幅(%)', state.maPeriod === 60 ? 'MA60（選定週期）' : `MA${state.maPeriod}`, 'MA60', '布林上軌', '布林下軌', '乖離率(%)', 'MACD(DIF)', 'MACD(DEA)', '葛蘭碧買賣點', '關鍵K線(PA)'];
  const rows = state.chartData.map((d) => [
    d.date,
    getCandleSourceLabel(d),
    d.open,
    d.high,
    d.low,
    d.close,
    d.changePct,
    d.ma20,
    d.ma60,
    d.bbUpper,
    d.bbLower,
    d.bias20,
    d.dif,
    d.dea,
    d.rule || '',
    d.paPattern || ''
  ]);

  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${stock.code}_${stock.name}_葛蘭碧2個月預測報表.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`已匯出 ${stock.code} ${stock.name} 完整 CSV 報表！`);
}

// 下載 JSON 策略資料
function exportStrategyJSON() {
  const base = state.chartData[state.currentBarIndex];
  if (!base) return;
  const stock = getCurrentStock();
  const last = state.chartData.at(-1);
  const history = state.chartData.slice(0, state.currentBarIndex + 1);
  const payload = {
    exportedAt: calendar.taipeiClock().iso,
    todayBaseline: base.date,
    twoMonthForecastEnd: last.isForecast ? last.date : null,
    stock: {
      ...stock,
      unit: isMarketIndex() ? '點' : '元',
      basePrice: history[0].close,
      peakPrice: Math.max(...history.map((bar) => bar.high)),
      dipPrice: Math.min(...history.map((bar) => bar.low)),
      currentPrice: base.close,
      selectedMACurrent: base.selectedMA,
      ma20Current: base.ma20,
      ma60Current: base.ma60
    },
    parameters: { maPeriod: state.maPeriod, bollingerStd: state.bbStd },
    chartData: state.chartData.map((bar) => ({ ...bar, sourceLabel: getCandleSourceLabel(bar) }))
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${stock.code}_strategy_report.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`已匯出 ${stock.code} JSON 策略診斷報告！`);
}

// ==========================================
// 8. 事件綁定與初始化啟動
// ==========================================
window.addEventListener('DOMContentLoaded', () => {
  bindTrend();
  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const data = button.dataset;
    if (data.stock) selectStock(data.stock);
    else if (data.mode) setChartMode(data.mode);
    else if (data.filter) toggleFilter(data.filter);
    else if (data.dayStep) moveChartSelection(Number(data.dayStep));
    else if (data.ruleJump) selectRule(data.ruleJump);
    else if (data.selectBar) focusBarIndex(Number(data.selectBar), true);
    else if ('resetSelection' in data) resetChartSelection();
    else if (data.download === 'csv') exportChartDataCSV();
    else if (data.download === 'json') exportStrategyJSON();
  });
  for (const id of ['select-ma-period', 'select-bb-std']) {
    document.getElementById(id).addEventListener('change', updateIndicatorParams);
  }
  const svgEl = document.getElementById('main-strategy-svg');
  function barIndexAtPointer(event) {
    const marker = event.target.closest('[data-bar-index]');
    if (marker) return Number(marker.dataset.barIndex);
    const bounds = svgEl.getBoundingClientRect();
    const width = svgEl.viewBox.baseVal.width;
    const x = (event.clientX - bounds.left) * width / bounds.width;
    return Math.floor((x - chartPadLeft) / (width - chartPadLeft - chartPadRight) * state.chartData.length);
  }
  svgEl.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || state.selectedBarDate) return;
    const bar = state.chartData[barIndexAtPointer(event)];
    if (bar && state.hoveredIndex !== bar.index) {
      state.hoveredIndex = bar.index;
      renderMainChartSVG();
      renderRightSidebar();
    }
  });
  svgEl.addEventListener('pointerleave', () => {
    if (state.hoveredIndex === null) return;
    state.hoveredIndex = null;
    renderMainChartSVG();
    renderRightSidebar();
  });
  svgEl.addEventListener('click', event => focusBarIndex(barIndexAtPointer(event)));
  svgEl.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home' || event.key === 'Escape') resetChartSelection();
    else moveChartSelection(event.key === 'ArrowLeft' ? -1 : 1);
  });
  let chartWidth = 0;
  new ResizeObserver(([entry]) => {
    const width = entry.contentRect.width;
    if (width === chartWidth) return;
    chartWidth = width;
    if (width) renderMainChartSVG();
  }).observe(svgEl.parentElement);

  const stockToggle = document.getElementById('stock-controls-toggle');
  stockToggle.addEventListener('click', () => setStockControls(stockToggle.getAttribute('aria-expanded') !== 'true'));
  window.addEventListener('focus', () => {
    if (state.chartMode === 'RECENT_FORECAST') loadPremarket(state.selectedStockCode);
  });

  // 綁定台股搜尋表單
  document.getElementById('stock-search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('custom-stock-input');
    const [rawCode, ...name] = input.value.trim().split(/\s+/);
    const code = rawCode.replace(/\.(TW|TWO)$/i, '').toUpperCase();
    if (!/^\d{4,6}[A-Z]?$/.test(code)) {
      input.setCustomValidity('請輸入有效的台股代號，例如 2330 或 00878。');
      input.reportValidity();
      return;
    }
    selectStock(code, name.join(' '));
    input.value = '';
  });
  document.getElementById('custom-stock-input').addEventListener('input', (event) => {
    event.target.setCustomValidity('');
  });

  // 綁定手動校正基準價表單
  document.getElementById('manual-price-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('manual-price-input');
    const price = Number(Number(input.value).toFixed(2));
    if (!Number.isFinite(price) || price <= 0 || state.currentBarIndex === -1) return;

    state.manualPrices[state.chartMode][state.selectedStockCode] = price;
    input.value = '';
    state.hoveredIndex = null;
    setRuleStatus('');
    rebuildAndRenderAll();
    document.getElementById('manual-price-details').open = false;
    document.querySelector('#manual-price-details summary').focus();
    showToast(`基準價已校正為 ${displayLevel(price, true)}。`);
  });

  selectStock(state.selectedStockCode);
});
