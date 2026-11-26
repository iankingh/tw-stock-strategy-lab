export const defaultMAPeriod = 20;
export const version = 'workstation-ma20-v2';

/** @param {number[]} closes @param {number} tradingDays @param {number} [maPeriod] @returns {number[]} */
export function forecastClosePath(closes, tradingDays, maPeriod = defaultMAPeriod) {
  const recent = closes.slice(-maPeriod);
  const lastClose = recent[recent.length - 1];
  const average = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  const half = Math.max(1, Math.floor(recent.length / 2));
  const earlyAverage = recent.slice(0, half).reduce((sum, value) => sum + value, 0) / half;
  const bias = ((lastClose - average) / average) * 100;
  const maRising = average >= earlyAverage;

  // 第一段（1–11 日）：正乖離過大拉回均線、負乖離過大向均線反彈（B4）、均線附近順均線斜率。
  let stage1Target;
  if (bias > 2.2) {
    stage1Target = average * 1.012;
  } else if (bias < -2.2) {
    stage1Target = average * 0.988;
  } else {
    stage1Target = maRising ? lastClose * 1.025 : lastClose * 0.975;
  }

  const midBounceTarget = Math.max(lastClose * 1.045, average * 1.08, stage1Target * 1.02);
  const midDipTarget = Math.max(Math.min(stage1Target, lastClose) * 1.025, average * 1.03);
  const peakTarget = Math.max(lastClose * 1.12, average * 1.16, midBounceTarget * 1.04);

  return Array.from({ length: tradingDays }, (_, index) => {
    const day = index + 1;
    let close;
    if (day <= 11) {
      close = lastClose + (stage1Target - lastClose) * Math.sin((day / 11 * Math.PI) / 2);
    } else if (day <= 24) {
      close = stage1Target + (midBounceTarget - stage1Target) * ((1 - Math.cos((day - 11) / 13 * Math.PI)) / 2);
    } else if (day <= 31) {
      close = midBounceTarget + (midDipTarget - midBounceTarget) * Math.sin(((day - 24) / 7 * Math.PI) / 2);
    } else if (day <= 41) {
      close = midDipTarget + (peakTarget - midDipTarget) * ((1 - Math.cos((day - 31) / 10 * Math.PI)) / 2);
    } else {
      close = peakTarget * (1 - 0.015 * ((day - 41) / 3));
    }
    return Number(close.toFixed(2));
  });
}
