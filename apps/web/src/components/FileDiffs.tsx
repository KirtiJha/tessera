import type { ChangedFile, DiffFile, DiffView } from "@tessera/contract";
import { ChevronRight, FileDiff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { fmtTime } from "../lib/format";
import { Button } from "./ui";

type Row = { kind: "add" | "del" | "ctx" | "hunk" | "note"; text: string; old: number | null; new: number | null };

/** A unified diff as rows with old and new line numbers. File headers are dropped: the row above names the file. */
export function diffRows(diff: string): Row[] {
  const rows: Row[] = [];
  let o = 0;
  let n = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("new file mode") || line.startsWith("deleted file mode") || line.startsWith("similarity index") || line.startsWith("rename ")) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      rows.push({ kind: "hunk", text: line, old: null, new: null });
    } else if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1), old: null, new: n++ });
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1), old: o++, new: null });
    else if (line.startsWith("\\")) rows.push({ kind: "note", text: line.slice(2), old: null, new: null });
    else if (line.length || rows.length) rows.push({ kind: "ctx", text: line.startsWith(" ") ? line.slice(1) : line, old: o++, new: n++ });
  }
  while (rows.length && rows.at(-1)!.kind === "ctx" && !rows.at(-1)!.text) rows.pop();
  return rows;
}

const TONE: Record<Row["kind"], string> = {
  add: "bg-teal-400/10 text-snow",
  del: "bg-rose-400/10 text-snow",
  ctx: "text-mist",
  hunk: "bg-slate-2 text-fog",
  note: "text-ash italic",
};

/** A unified diff as a numbered, coloured table: a file's live diff, or one edit's patch from the change history. */
export function PatchView({ patch, truncated = false, note }: { patch: string; truncated?: boolean; note?: string }) {
  const rows = diffRows(patch);
  return (
    <div className="max-h-[480px] overflow-auto">
      <table className="w-full border-collapse font-mono text-[12px] leading-[1.55]">
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={TONE[r.kind]}>
              <td className="w-10 select-none border-r border-line px-1.5 text-right align-top text-ash">{r.old ?? ""}</td>
              <td className="w-10 select-none border-r border-line px-1.5 text-right align-top text-ash">{r.new ?? ""}</td>
              <td className="w-4 select-none pl-1.5 align-top text-fog">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</td>
              <td className="whitespace-pre pr-3 align-top">{r.text || " "}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {truncated ? <p className="border-t border-line px-3 py-1.5 text-[12px] text-amber-400">{note ?? "Cut at 20,000 characters. The rest is on the engineer's machine."}</p> : null}
    </div>
  );
}

function DiffBlock({ file }: { file: DiffFile }) {
  if (file.binary) return <p className="px-3 py-2 text-[12.5px] text-fog">Binary, or too large to show.</p>;
  if (!file.diff) return <p className="px-3 py-2 text-[12.5px] text-fog">{file.truncated ? "Left out: the diff reached its size limit before this file." : "No line changes (a mode or rename only)."}</p>;
  return <PatchView patch={file.diff} truncated={file.truncated} />;
}

const STATUS_TONE = (st: ChangedFile["status"]) => (st === "deleted" ? "text-rose-400" : st === "added" || st === "untracked" ? "text-teal-300" : "text-fog");

/**
 * The files a session has changed, each opening to its diff. A diff is asked
 * of the engineer's machine when someone opens a file: it is not collected
 * otherwise, and the server keeps it in memory for 15 minutes.
 */
export function FileDiffs({ sessionId, files, live, canAct, host, dir = null }: { sessionId: string; files: ChangedFile[]; live: boolean; canAct: boolean; host: string | null; dir?: string | null }) {
  const [held, setView] = useState<DiffView | null>(null);
  // The server holds one diff per session; one for another repository is not this one's.
  const view = held && held.dir === dir ? held : null;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const path = `/api/fleet/sessions/${encodeURIComponent(sessionId)}/diff`;

  const read = useCallback(async () => {
    try {
      const v = await api.get<DiffView>(path);
      setView(v);
      if (v.status === "pending") poll.current = setTimeout(() => void read(), 1500);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 403)) setErr(e instanceof ApiError ? e.message : "Could not read the diff.");
    }
  }, [path]);

  useEffect(() => {
    if (canAct) void read();
    return () => {
      if (poll.current) clearTimeout(poll.current);
    };
  }, [canAct, read]);

  const ask = async () => {
    setErr(null);
    try {
      await api.post(path, dir ? { dir } : {});
      setView((v) => ({ dir, status: "pending", requestedAt: new Date().toISOString(), requestedBy: null, receivedAt: null, files: v?.dir === dir ? v.files : [], omitted: 0, error: null }));
      if (poll.current) clearTimeout(poll.current);
      poll.current = setTimeout(() => void read(), 1200);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not ask for the diff.");
    }
  };

  const canAsk = live && canAct;
  const toggle = (p: string) => {
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
    if (canAsk && (!view || view.status === "none" || (view.status === "error" && !view.files.length))) void ask();
  };

  const byPath = new Map((view?.files ?? []).map((f) => [f.path, f]));
  const max = Math.max(1, ...files.map((g) => g.added + g.removed));
  const pending = view?.status === "pending";

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-fog">
        {pending ? <span className="text-mist">Asking {host ?? "the machine"} for the diff…</span> : view?.status === "ready" ? <span>From {host ?? "the machine"} at {fmtTime(view.receivedAt!)}{view.requestedBy ? `, asked by ${view.requestedBy}` : ""}. Held 15 minutes, never stored.</span> : canAsk ? <span>Open a file to see its diff, fetched from {host ?? "the machine"} when you ask.</span> : canAct ? <span>Diffs come from the engineer's machine, so they are available while the session is live.</span> : <span>Only the session's owner, their team's approvers and admins can see its diff.</span>}
        {canAsk ? <Button size="sm" className="ml-auto" loading={pending} onClick={() => void ask()}><FileDiff size={13} /> {view?.status === "ready" ? "Refresh diffs" : "Show diffs"}</Button> : null}
      </div>
      {view?.status === "error" && view.error ? <p className="mb-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[12.5px] text-amber-400">{view.error}</p> : null}
      {err ? <p className="mb-2 text-[12.5px] text-rose-400">{err}</p> : null}
      <ul className="max-h-[640px] space-y-1 overflow-auto font-mono text-[12px]">
        {files.map((f) => {
          const isOpen = open.has(f.path);
          const d = byPath.get(f.path);
          return (
            <li key={f.path}>
              <button onClick={() => toggle(f.path)} disabled={!canAct} aria-expanded={isOpen} className="flex w-full items-center gap-3 rounded-md px-1 py-0.5 text-left text-mist hover:bg-slate-2 disabled:cursor-default disabled:hover:bg-transparent">
                <ChevronRight size={12} className={`shrink-0 text-fog transition-transform ${isOpen ? "rotate-90" : ""} ${canAct ? "" : "invisible"}`} />
                <span className={`w-16 shrink-0 ${STATUS_TONE(f.status)}`}>{f.status}</span>
                <span className="truncate" title={f.path}>{f.path}</span>
                <span className="ml-auto flex h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-slate-3" aria-hidden="true">
                  <span className="bg-teal-400" style={{ width: `${(f.added / max) * 100}%` }} />
                  <span className="bg-rose-400" style={{ width: `${(f.removed / max) * 100}%` }} />
                </span>
                <span className="w-12 shrink-0 text-right text-teal-300">+{f.added}</span>
                <span className="w-12 shrink-0 text-right text-rose-400">−{f.removed}</span>
              </button>
              {isOpen ? (
                <div className="my-1.5 overflow-hidden rounded-lg border border-line bg-ink-2">
                  {d ? <DiffBlock file={d} /> : <p className="px-3 py-2 text-[12.5px] text-fog">{pending ? "Waiting for the machine…" : view?.status === "ready" ? "Not in the diff the machine sent: changed since, or past the 40-file limit. Refresh to ask again." : canAsk ? "Fetching…" : "Not available."}</p>}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {view?.omitted ? <p className="mt-2 text-[12px] text-fog">{view.omitted} more changed file{view.omitted === 1 ? "" : "s"} not sent: the machine sends the 40 biggest changes.</p> : null}
    </div>
  );
}
