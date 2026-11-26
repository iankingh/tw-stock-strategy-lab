import { getDateWithWeekday } from './trading-calendar.js';

/** @typedef {import('./types.js').DailyCandle} DailyCandle */
/**
 * @typedef {DailyCandle & {
 *   source?:string, rule?:string|null, paPattern?:string|null, dateWithDay?:string, changePct?:number,
 *   ma20?:number|null, ma60?:number|null, selectedMA?:number|null, selectedBiasPct?:number|null,
 *   bbUpper?:number|null, bbLower?:number|null, bbBandwidth?:number|null, isSqueeze?:boolean|null,
 *   dif?:number, dea?:number, macdHist?:number, bias20?:number|null, autoPA?:{name:string,bias:string}|null
 * }} ChartCandle
 */
/** @param {DailyCandle} curr @param {DailyCandle|null} prev */
function detectCandlestickPattern(curr, prev) {
  if (!curr) return null;
  const body = Math.abs(curr.close - curr.open);
  const totalRange = Math.max(0.01, curr.high - curr.low);
  const lowerShadow = Math.min(curr.open, curr.close) - curr.low;
  const upperShadow = curr.high - Math.max(curr.open, curr.close);
  const isBull = curr.close >= curr.open;

  if (lowerShadow >= body * 1.75 && lowerShadow >= totalRange * 0.48) {
    return { name: '長下影線錘頭線 (Hammer)', bias: 'BULL' };
  }
  if (upperShadow >= body * 1.75 && upperShadow >= totalRange * 0.48) {
    return { name: '長上影線流星線 (Shooting Star)', bias: 'BEAR' };
  }
  if (prev && curr.close > curr.open && prev.close < prev.open && curr.close >= prev.open && curr.open <= prev.close) {
    return { name: '看漲吞噬紅K (Bullish Engulfing)', bias: 'BULL' };
  }
  if (prev && curr.close < curr.open && prev.close > prev.open && curr.open >= prev.close && curr.close <= prev.open) {
    return { name: '看跌吞噬黑K (Bearish Engulfing)', bias: 'BEAR' };
  }
  if (body <= totalRange * 0.14) {
    return { name: '十字變盤線 (Doji)', bias: 'NEUTRAL' };
  }
  if (isBull && body >= totalRange * 0.72) {
    return { name: '實體長紅K棒 (Marubozu)', bias: 'BULL' };
  }
  return null;
}

/** @param {ChartCandle[]} bars @param {number} maPeriod @param {number} bbStdMult @returns {void} */
export function computeTechnicalIndicators(bars, maPeriod, bbStdMult) {
  if (!bars.length) return;
  let ema12 = bars[0].close;
  let ema26 = bars[0].close;
  let dea = 0;
  /** @type {number|null} */
  let previousMA = null;

  for (let i = 0; i < bars.length; i++) {
    const prevBar = i > 0 ? bars[i - 1] : null;
    const changePct = prevBar ? ((bars[i].close - prevBar.close) / prevBar.close) * 100 : 0;

    const selectedWindow = i + 1 >= maPeriod ? bars.slice(i + 1 - maPeriod, i + 1) : [];
    const ma20 = selectedWindow.length ? selectedWindow.reduce((sum, bar) => sum + bar.close, 0) / maPeriod : null;
    const ma60 = i + 1 >= 60 ? bars.slice(i - 59, i + 1).reduce((sum, bar) => sum + bar.close, 0) / 60 : null;

    const variance = ma20 === null ? null : selectedWindow.reduce((sum, bar) => sum + (bar.close - ma20) ** 2, 0) / maPeriod;
    const spread = variance === null ? null : bbStdMult * Math.sqrt(variance);
    const bbBandwidth = spread === null || ma20 === null ? null : (2 * spread / ma20) * 100;

    ema12 = bars[i].close * (2 / 13) + ema12 * (11 / 13);
    ema26 = bars[i].close * (2 / 27) + ema26 * (25 / 27);
    const dif = ema12 - ema26;
    dea = dif * (2 / 10) + dea * (8 / 10);
    const macdHist = (dif - dea) * 2;
    const bias20 = ma20 === null ? null : ((bars[i].close - ma20) / ma20) * 100;
    const autoPA = detectCandlestickPattern(bars[i], prevBar);

    bars[i].dateWithDay = getDateWithWeekday(bars[i].date);
    bars[i].changePct = Number(changePct.toFixed(2));
    bars[i].ma20 = ma20 === null ? null : Number(ma20.toFixed(2));
    bars[i].ma60 = ma60 === null ? null : Number(ma60.toFixed(2));
    bars[i].bbUpper = spread === null || ma20 === null ? null : Number((ma20 + spread).toFixed(2));
    bars[i].bbLower = spread === null || ma20 === null ? null : Number((ma20 - spread).toFixed(2));
    bars[i].bbBandwidth = bbBandwidth === null ? null : Number(bbBandwidth.toFixed(2));
    bars[i].isSqueeze = bbBandwidth === null ? null : bbBandwidth < 5.2;
    bars[i].dif = Number(dif.toFixed(3));
    bars[i].dea = Number(dea.toFixed(3));
    bars[i].macdHist = Number(macdHist.toFixed(3));
    bars[i].bias20 = bias20 === null ? null : Number(bias20.toFixed(2));
    bars[i].selectedMA = bars[i].ma20;
    bars[i].selectedBiasPct = bars[i].bias20;
    const historical = bars[i].source === 'finmind' || bars[i].source === 'manual' || bars[i].source === 'twse';
    if (historical && ma20 !== null && previousMA !== null && prevBar && i >= 2) {
      const pullback = prevBar.close < bars[i - 2].close && prevBar.close >= previousMA && prevBar.close <= previousMA * 1.022;
      if (ma20 > previousMA && pullback && bars[i].close > prevBar.close && bars[i].close >= ma20) {
        bars[i].rule = 'B2';
      }
    }
    previousMA = ma20;
    bars[i].autoPA = autoPA;
    if (!bars[i].paPattern && autoPA) {
      bars[i].paPattern = autoPA.name;
    }
  }
}

/** @param {ChartCandle} currentBar @returns {void} */
export function applyBaselineRule(currentBar) {
  if (!currentBar.rule && currentBar.bias20 != null) {
    if (currentBar.bias20 >= 4.5) currentBar.rule = 'S4';
    else if (currentBar.bias20 <= -4.5) currentBar.rule = 'B4';
  }
}
