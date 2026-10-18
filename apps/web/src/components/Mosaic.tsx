import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";

type TileState = "off" | "running" | "waiting" | "done";

/**
 * The hero mosaic: a wall of tiles that plays one sequence on load. Tiles come
 * alive as sessions start, one tile turns amber because it waits on you, and a
 * notice card arrives beside it. It is brand motion, not data.
 */
export function Mosaic({ cols = 12, rows = 7 }: { cols?: number; rows?: number }) {
  const reduce = useReducedMotion();
  const total = cols * rows;
  const order = useMemo(() => {
    // Deterministic pseudo-random order so every load plays the same sequence.
    const idx = Array.from({ length: total }, (_, i) => i);
    let seed = 7;
    for (let i = idx.length - 1; i > 0; i--) {
      seed = (seed * 9301 + 49297) % 233280;
      const j = Math.floor((seed / 233280) * (i + 1));
      [idx[i], idx[j]] = [idx[j]!, idx[i]!];
    }
    return idx;
  }, [total]);
  const waitingTile = Math.floor(rows / 2) * cols + Math.floor(cols * 0.62);
  const [states, setStates] = useState<TileState[]>(() => Array(total).fill(reduce ? "running" : "off"));
  const [notice, setNotice] = useState(!!reduce);

  useEffect(() => {
    if (reduce) {
      setStates((s) => s.map((_, i) => (i === waitingTile ? "waiting" : "running")));
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    order.forEach((tile, n) => {
      timers.push(setTimeout(() => setStates((s) => s.map((v, i) => (i === tile ? "running" : v))), 350 + n * 22));
    });
    timers.push(setTimeout(() => setStates((s) => s.map((v, i) => (i === waitingTile ? "waiting" : v))), 350 + total * 22 + 500));
    timers.push(setTimeout(() => setNotice(true), 350 + total * 22 + 1100));
    // A few tiles finish over time, so the wall keeps a pulse.
    const finish = [3, 17, 41, 58, 70].filter((i) => i !== waitingTile && i < total);
    finish.forEach((tile, k) => timers.push(setTimeout(() => setStates((s) => s.map((v, i) => (i === tile ? "done" : v))), 4000 + k * 900)));
    return () => timers.forEach(clearTimeout);
  }, [order, reduce, total, waitingTile]);

  const fill = (st: TileState) =>
    st === "off" ? "transparent" : st === "running" ? "rgba(15,118,110,0.85)" : st === "waiting" ? "var(--color-amber-400)" : "rgba(15,118,110,0.25)";

  return (
    <div className="relative select-none" aria-hidden="true">
      <div className="grid gap-[6px]" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {states.map((st, i) => (
          <motion.div
            key={i}
            className="aspect-square rounded-[6px] border"
            animate={{ backgroundColor: fill(st), borderColor: st === "off" ? "rgba(16,20,24,0.12)" : st === "waiting" ? "var(--color-amber-400)" : "rgba(15,118,110,0.0)", scale: st === "waiting" ? 1.06 : 1 }}
            transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}
            style={st === "waiting" ? { boxShadow: "0 0 0 6px rgba(245,165,36,0.18)" } : undefined}
          />
        ))}
      </div>
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.96 }}
        animate={notice ? { opacity: 1, y: 0, scale: 1 } : {}}
        transition={{ duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }}
        className="absolute rounded-xl border border-amber-400/60 bg-[#101418] px-4 py-3 text-left text-snow shadow-[0_24px_48px_-24px_rgba(0,0,0,0.6)]"
        style={{ left: `${((waitingTile % cols) / cols) * 100 + 100 / cols + 1.5}%`, top: `${(Math.floor(waitingTile / cols) / rows) * 100 - 6}%`, minWidth: 220 }}
      >
        <div className="flex items-center gap-2 text-[11px] font-medium text-amber-400">
          <span className="inline-block h-2 w-2 rounded-sm bg-amber-400" />
          Waiting on you
        </div>
        <div className="mt-1 text-[14px] font-semibold leading-tight">payments-api · feat/refunds</div>
        <div className="mt-0.5 text-[12px] text-mist">Allow <span className="font-mono text-[11px]">Bash(pnpm test)</span>?</div>
        <div className="mt-2.5 flex gap-1.5">
          <span className="rounded-md bg-teal-400 px-2 py-1 text-[11px] font-semibold text-ink">Allow once</span>
          <span className="rounded-md border border-line-2 px-2 py-1 text-[11px] font-medium text-mist">Deny</span>
        </div>
      </motion.div>
    </div>
  );
}
