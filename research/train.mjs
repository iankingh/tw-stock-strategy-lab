import { directions } from '../scripts/daily-model.mjs';

// 全批次梯度下降；四個標準化特徵，截距不懲罰。兩個任務固定 L2=0.1。
export function train(samples) {
  const n = samples.length;
  if (n < 200) throw new Error('Insufficient training history');
  const average = fn => samples.reduce((sum, row) => sum + fn(row), 0) / n;
  const center = [0, 1, 2, 3].map(i => average(row => row.input[i]));
  const scale = center.map((mean, i) => Math.sqrt(average(row => (row.input[i] - mean) ** 2)) || 1);
  const counts = directions.map(d => samples.filter(row => row.label === d).length);
  const design = samples.map(row => [1, ...row.input.map((value, j) => (value - center[j]) / scale[j])]);
  const weights = Array.from({ length: 4 }, () => Array(5).fill(0));
  for (let iteration = 0; iteration < 400; iteration++) {
    const gradients = weights.map(w => w.map(() => 0));
    for (let i = 0; i < n; i++) {
      const x = design[i];
      const [prediction, ...logits] = weights.map(w => w.reduce((sum, v, j) => sum + v * x[j], 0));
      const largest = Math.max(...logits);
      const exp = logits.map(v => Math.exp(v - largest));
      const total = exp.reduce((sum, value) => sum + value, 0);
      const errors = [prediction - samples[i].returnPct, ...exp.map((v, k) => v / total - Number(samples[i].label === directions[k]))];
      for (let k = 0; k < weights.length; k++) {
        for (let j = 0; j < x.length; j++) gradients[k][j] += errors[k] * x[j];
      }
    }
    for (let k = 0; k < weights.length; k++) {
      for (let j = 0; j < weights[k].length; j++) {
        const penalty = j === 0 ? 0 : 0.1 * weights[k][j];
        weights[k][j] -= 0.1 * (gradients[k][j] / n + penalty);
      }
    }
  }
  return { majority: directions[counts.indexOf(Math.max(...counts))], center, scale, ridge: weights[0], softmax: weights.slice(1) };
}
