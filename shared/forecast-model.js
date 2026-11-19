export const defaultMAPeriod = 20;
export const version = 'workstation-ma20-v1';

/** @param {number[]} closes @param {number} tradingDays @param {number} [maPeriod] @returns {number[]} */
export function forecastClosePath(closes, tradingDays, maPeriod = defaultMAPeriod) {
  const recent = closes.slice(-maPeriod);
  const lastClose = recent[recent.length - 1];
  const average = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  const bias = ((lastClose - average) / average) * 100;
  const pullbackTarget = bias > 2.2 ? average * 1.012 : lastClose * 0.975;
  const midBounceTarget = Math.max(lastClose * 1.045, average * 1.08);
  const midDipTarget = Math.max(pullbackTarget * 1.025, average * 1.03);
  const peakTarget = Math.max(lastClose * 1.12, average * 1.16);

  return Array.from({ length: tradingDays }, (_, index) => {
    const day = index + 1;
    let close;
    if (day <= 11) {
      close = lastClose + (pullbackTarget - lastClose) * Math.sin((day / 11 * Math.PI) / 2);
    } else if (day <= 24) {
      close = pullbackTarget + (midBounceTarget - pullbackTarget) * ((1 - Math.cos((day - 11) / 13 * Math.PI)) / 2);
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
