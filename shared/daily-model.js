// 百分點報酬；每次傳入截至前一交易日的收盤序列。
/** @typedef {import('./types.js').Direction} Direction */
/** @type {Direction[]} */
export const directions = ['跌', '平', '漲'];

/** @param {unknown} value @returns {value is Direction} */
export function isDirection(value) {
  return directions.some(label => label === value);
}

/** @param {number} change @returns {Direction} */
export function direction(change) {
  return directions[Math.sign(change) + 1];
}

/** @param {number[]} closes @returns {number[]} */
export function features(closes) {
  const window = closes.slice(-21);
  if (window.length !== 21 || window.some(p => !Number.isFinite(p) || p <= 0)) {
    throw new Error('Daily forecast needs 21 positive closes');
  }
  const last = window[20];
  /** @param {number} n */
  const trailingReturn = n => 100 * (last / window[20 - n] - 1);
  const returns = window.slice(1).map((p, i) => 100 * (p / window[i] - 1));
  const mean = returns.reduce((sum, r) => sum + r, 0) / 20;
  const volatility = Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / 20);
  return [trailingReturn(1), trailingReturn(5), trailingReturn(20), volatility];
}

/** @param {number[]} input @param {number[]} center @param {number[]} scale @param {number[]} weights */
function linearScore(input, center, scale, weights) {
  return input.reduce((sum, value, i) => sum + (value - center[i]) / scale[i] * weights[i + 1], weights[0]);
}

/** @typedef {{priceMethod:'previous'|'scenario'} | {priceMethod:'ridge',center:number[],scale:number[],ridge:number[]}} PriceModel */
/** @param {PriceModel} model @param {number[]} input @param {number} previous */
export function predictClose(model, input, previous) {
  const change = model.priceMethod === 'ridge' ? linearScore(input, model.center, model.scale, model.ridge) : 0;
  return Number((previous * (1 + change / 100)).toFixed(2));
}

/**
 * @param {{center:number[], scale:number[], majority:Direction} &
 *   ({priceMethod:'ridge',ridge:number[]} | {priceMethod:'previous'|'scenario'}) &
 *   ({directionMethod:'softmax',softmax:number[][]} | {directionMethod:'persistence'|'majority'})} model
 * @param {number[]} input
 * @param {number} previous
 * @returns {{close:number, direction:Direction}}
 */
export function predictDaily(model, input, previous) {
  let label = model.majority;
  if (model.directionMethod === 'persistence') label = direction(input[0]);
  if (model.directionMethod === 'softmax') {
    const scores = model.softmax.map(weights => linearScore(input, model.center, model.scale, weights));
    label = directions[scores.indexOf(Math.max(...scores))];
  }
  return { close: predictClose(model, input, previous), direction: label };
}
