export function round(value: number, precision = 4): number {
  return Number(value.toFixed(precision));
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function selectNth(values: number[], nth: number): number {
  let left = 0;
  let right = values.length - 1;
  while (left < right) {
    const pivot = values[Math.floor((left + right) / 2)] ?? 0;
    let low = left;
    let high = right;
    while (low <= high) {
      while ((values[low] ?? 0) < pivot) low += 1;
      while ((values[high] ?? 0) > pivot) high -= 1;
      if (low <= high) {
        [values[low], values[high]] = [values[high] ?? 0, values[low] ?? 0];
        low += 1;
        high -= 1;
      }
    }
    if (nth <= high) right = high;
    else if (nth >= low) left = low;
    else break;
  }
  return values[nth] ?? 0;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const selected = [...values];
  const middle = Math.floor(selected.length / 2);
  const upper = selectNth(selected, middle);
  return selected.length % 2 ? upper : (selectNth(selected, middle - 1) + upper) / 2;
}

export function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
}

export function range(values: number[]): number {
  return values.length ? Math.max(...values) - Math.min(...values) : 0;
}
