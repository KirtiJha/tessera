import type { SessionKind } from "../lib/fleet";

const TEE = [0, 1, 2, 4, 7];

const STATUS: Record<SessionKind | "ok", string> = {
  ok: "var(--color-teal-400)",
  running: "var(--color-teal-400)",
  waiting: "var(--color-amber-400)",
  background: "var(--color-violet-400)",
  stale: "var(--color-fog)",
  done: "var(--color-fog)",
};

/** The Tessera mark: nine tiles, five form a T. The centre tile carries live state. */
export function Mark({ size = 28, tone = "var(--color-teal-400)", status = "ok", className }: { size?: number; tone?: string; status?: SessionKind | "ok"; className?: string }) {
  const s = 34;
  const g = 5;
  return (
    <svg width={size} height={size} viewBox="0 0 112 112" className={className} aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => {
        const on = TEE.includes(i);
        const centre = i === 4;
        const fill = centre ? STATUS[status] : on ? tone : "none";
        return (
          <rect
            key={i}
            x={(i % 3) * (s + g)}
            y={Math.floor(i / 3) * (s + g)}
            width={s}
            height={s}
            rx={7}
            fill={fill}
            stroke={on ? fill : tone}
            strokeWidth={on ? 0 : 2.5}
            opacity={on ? 1 : 0.55}
            style={centre ? { transition: "fill 400ms var(--ease-tile)" } : undefined}
          />
        );
      })}
    </svg>
  );
}

export function Wordmark({ className = "", tone }: { className?: string; tone?: string }) {
  return (
    <span className={`font-display font-semibold tracking-[-0.03em] ${className}`} style={tone ? { color: tone } : undefined}>
      tessera
    </span>
  );
}

export function Lockup({ size = 28, status = "ok", className = "", textClass = "text-[22px]" }: { size?: number; status?: SessionKind | "ok"; className?: string; textClass?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <Mark size={size} status={status} />
      <Wordmark className={textClass} />
    </span>
  );
}
