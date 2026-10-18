export function Sparkline({ values, color = "var(--color-teal-400)", height = 36, width = 160 }: { values: number[]; color?: string; height?: number; width?: number }) {
  const max = Math.max(1, ...values);
  const n = values.length;
  const pts = values.map((v, i) => `${(i / Math.max(1, n - 1)) * width},${height - (v / max) * (height - 2) - 1}`).join(" ");
  const area = `0,${height} ${pts} ${width},${height}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" className="block w-full">
      <polygon points={area} fill={color} opacity={0.12} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
