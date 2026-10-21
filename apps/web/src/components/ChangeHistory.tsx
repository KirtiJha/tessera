import type { Action } from "@tessera/contract";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { fmtTime } from "../lib/format";
import { PatchView } from "./FileDiffs";
import { Panel } from "./ui";

interface Changes { canSee: boolean; kept: boolean; changes: Action[] }

const short = (path: string, roots: string[]) => {
  for (const r of roots) if (path.startsWith(`${r}/`)) return path.slice(r.length + 1);
  return path;
};

/**
 * What the session's edits and writes changed, file by file, in the order they
 * happened, kept when they happened: still there after a commit, and after the
 * session ends. Only where the organisation keeps edits, and only for people
 * who can act on the session.
 */
export function ChangeHistory({ sessionId, roots, live }: { sessionId: string; roots: string[]; live: boolean }) {
  const [data, setData] = useState<Changes | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [count, setCount] = useState(0);

  useEffect(() => {
    let gone = false;
    const read = () =>
      api
        .get<Changes>(`/api/fleet/sessions/${encodeURIComponent(sessionId)}/changes`)
        .then((r) => !gone && setData(r))
        .catch((e) => !gone && setErr(e instanceof ApiError ? e.message : "Could not load the change history."));
    void read();
    // A live session keeps editing: look again every half minute.
    const t = live ? setInterval(() => void read(), 30_000) : null;
    return () => {
      gone = true;
      if (t) clearInterval(t);
    };
  }, [sessionId, live, count]);

  if (!data || !data.canSee) return err ? <Panel title="Change history"><p className="text-[12.5px] text-rose-400">{err}</p></Panel> : null;
  if (!data.kept && !data.changes.length)
    return (
      <Panel title="Change history">
        <p className="text-[13px] text-fog">
          Edits are not kept, so earlier changes cannot be shown once they are committed. An owner can keep each edit's patch in <Link to="/app/data" className="text-mist underline hover:text-teal-300">Data and compliance</Link>; it starts from the next edit.
        </p>
      </Panel>
    );

  const byFile = new Map<string, Action[]>();
  for (const c of data.changes) {
    const p = c.detail?.path ?? c.summary;
    byFile.set(p, [...(byFile.get(p) ?? []), c]);
  }
  const files = [...byFile.entries()].sort((a, b) => b[1].at(-1)!.ts.localeCompare(a[1].at(-1)!.ts));
  const toggle = (k: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <Panel title={`Change history · ${data.changes.length} edit${data.changes.length === 1 ? "" : "s"}`} action={<button type="button" onClick={() => setCount((n) => n + 1)} className="text-[12px] text-fog hover:text-snow">Refresh</button>}>
      {!files.length ? (
        <p className="text-[13px] text-fog">No edits yet. Each edit and write is kept as it happens, so it stays here after a commit.</p>
      ) : (
        <ul className="space-y-1.5">
          {files.map(([path, edits]) => {
            const isOpen = open.has(path);
            const added = edits.reduce((n, e) => n + (e.detail?.added ?? 0), 0);
            const removed = edits.reduce((n, e) => n + (e.detail?.removed ?? 0), 0);
            return (
              <li key={path} className="rounded-lg border border-line">
                <button type="button" onClick={() => toggle(path)} aria-expanded={isOpen} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[12px] hover:bg-slate-2">
                  <ChevronRight size={12} className={`shrink-0 text-fog transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-mist" title={path}>{short(path, roots)}</span>
                  <span className="shrink-0 font-sans text-[11.5px] text-fog">{edits.length} edit{edits.length === 1 ? "" : "s"}</span>
                  <span className="w-12 shrink-0 text-right text-teal-300">+{added}</span>
                  <span className="w-12 shrink-0 text-right text-rose-400">−{removed}</span>
                </button>
                {isOpen ? (
                  <ol className="space-y-2 border-t border-line px-2.5 py-2">
                    {[...edits].reverse().map((e) => (
                      <li key={e.id}>
                        <div className="mb-1 flex items-center gap-2 text-[11.5px] text-fog">
                          <span className="font-mono text-mist">{e.tool}</span>
                          <span>{fmtTime(e.ts)}</span>
                          <span className="text-teal-300">+{e.detail?.added ?? 0}</span>
                          <span className="text-rose-400">−{e.detail?.removed ?? 0}</span>
                        </div>
                        <div className="overflow-hidden rounded-md border border-line bg-ink-2"><PatchView patch={e.detail?.patch ?? ""} truncated={e.detail?.patchTruncated} note="Cut at 20,000 characters." /></div>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
