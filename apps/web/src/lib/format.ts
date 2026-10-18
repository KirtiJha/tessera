export function fmtUsd(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "—";
  if (v > 0 && v < 0.01 && digits <= 2) return "<$0.01";
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

export function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function ago(iso: string, now = Date.now()): string {
  const d = now - Date.parse(iso);
  if (d < 5000) return "just now";
  return `${fmtDuration(d)} ago`;
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function modelShort(model: string | null): string {
  if (!model) return "—";
  const m = model.toLowerCase();
  const fam = m.includes("opus") ? "Opus" : m.includes("sonnet") ? "Sonnet" : m.includes("haiku") ? "Haiku" : m.includes("fable") ? "Fable" : m.includes("mythos") ? "Mythos" : null;
  const ver = /-(\d)[-.](\d)/.exec(m);
  if (fam) return ver ? `${fam} ${ver[1]}.${ver[2]}` : fam;
  return model.length > 18 ? `${model.slice(0, 16)}…` : model;
}

export function shortPath(p: string | null): string {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}
