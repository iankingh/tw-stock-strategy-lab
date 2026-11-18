// 百分點報酬；每次傳入截至前一交易日的收盤序列。
export const directions = ['跌', '平', '漲'];

export function direction(change) {
  return directions[Math.sign(change) + 1];
}

export function features(closes) {
  const window = closes.slice(-21);
  if (window.length !== 21 || window.some(p => !Number.isFinite(p) || p <= 0)) {
    throw new Error('Daily forecast needs 21 positive closes');
  }
  const last = window.at(-1);
  const trailingReturn = n => 100 * (last / window[20 - n] - 1);
  const returns = window.slice(1).map((p, i) => 100 * (p / window[i] - 1));
  const mean = returns.reduce((sum, r) => sum + r, 0) / 20;
  const volatility = Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / 20);
  return [trailingReturn(1), trailingReturn(5), trailingReturn(20), volatility];
}

export function predictDaily(model, input, previous) {
  const x = input.map((value, i) => (value - model.center[i]) / model.scale[i]);
  const score = weights => x.reduce((sum, value, i) => sum + value * weights[i + 1], weights[0]);
  const changePct = model.priceMethod === 'ridge' ? score(model.ridge) : 0;
  let label = model.majority;
  if (model.directionMethod === 'persistence') label = direction(input[0]);
  if (model.directionMethod === 'softmax') {
    const scores = model.softmax.map(score);
    label = directions[scores.indexOf(Math.max(...scores))];
  }
  return { close: Number((previous * (1 + changePct / 100)).toFixed(2)), direction: label };
}
