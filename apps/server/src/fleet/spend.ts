/**
 * When a day's spend is out of line: more than three standard deviations above
 * the mean of the two weeks before it, at least $5 above that mean, and only
 * once a week of those two had spend (the first busy day after a quiet spell
 * is not an anomaly). Analytics marks these days; the spend alert sends them.
 */
export function outlier(window: number[], value: number): { mean: number; sd: number } | null {
  if (window.filter((v) => v > 0).length < 7) return null;
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const sd = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length);
  return value > mean + 3 * sd && value - mean >= 5 ? { mean, sd } : null;
}

/** The days in a series (oldest first, one per day) whose spend is an outlier against the two weeks before. */
export function anomalies(daily: { day: string; costUsd: number }[]): Set<string> {
  const out = new Set<string>();
  for (let i = 7; i < daily.length; i++) {
    const w = daily.slice(Math.max(0, i - 14), i).map((d) => d.costUsd);
    if (outlier(w, daily[i]!.costUsd)) out.add(daily[i]!.day);
  }
  return out;
}
