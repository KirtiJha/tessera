import type { SessionView } from "@tessera/contract";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { FileDiffs } from "./FileDiffs";
import { Panel } from "./ui";

const lines = (files: SessionView["filesChanged"]) => ({ added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) });

/**
 * Every repository a session has worked in, each with its uncommitted files
 * and their diffs. A session started in one folder and told to work on another
 * repo is still one Claude Code session: one conversation, one bill. This shows
 * where its work went.
 */
export function WorkedIn({ s, live, canAct }: { s: SessionView; live: boolean; canAct: boolean }) {
  const repos = [...s.workedIn].sort((a, b) => Number(b.current) - Number(a.current));
  const [open, setOpen] = useState<Set<string>>(() => new Set(repos.filter((r) => r.current || r.filesChanged.length).map((r) => r.dir)));
  const all = lines(repos.flatMap((r) => r.filesChanged));
  const toggle = (dir: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });

  return (
    <Panel
      title={`Worked in · ${repos.length} repositories`}
      action={<span className="text-[12px] text-fog"><span className="text-teal-300">+{all.added}</span> <span className="text-rose-400">−{all.removed}</span> lines, uncommitted</span>}
    >
      <ul className="space-y-2">
        {repos.map((r) => {
          const isOpen = open.has(r.dir);
          const l = lines(r.filesChanged);
          const name = r.repo ?? r.dir.split("/").filter(Boolean).pop() ?? r.dir;
          return (
            <li key={r.dir} className="rounded-lg border border-line">
              <button type="button" onClick={() => toggle(r.dir)} aria-expanded={isOpen} className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-2.5 py-2 text-left hover:bg-slate-2">
                <ChevronRight size={13} className={`shrink-0 text-fog transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden="true" />
                <span className="font-medium text-snow">{name}</span>
                {r.current ? <span className="rounded-md bg-teal-400/15 px-1.5 py-0.5 text-[11px] font-medium text-teal-300">working here now</span> : null}
                {r.branch ? <span className="font-mono text-[12px] text-fog">{r.branch}</span> : null}
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ash" title={r.dir}>{r.dir}</span>
                <span className="shrink-0 text-[12px] text-fog">
                  {r.filesChanged.length ? <>{r.filesChanged.length} file{r.filesChanged.length === 1 ? "" : "s"} <span className="text-teal-300">+{l.added}</span> <span className="text-rose-400">−{l.removed}</span></> : "no changes"}
                </span>
              </button>
              {isOpen ? (
                <div className="border-t border-line px-2.5 py-2">
                  {r.filesChanged.length ? (
                    <FileDiffs sessionId={s.id} files={r.filesChanged} live={live} canAct={canAct} host={s.machine?.hostname ?? null} dir={r.current ? null : r.dir} />
                  ) : (
                    <p className="text-[13px] text-fog">No uncommitted changes: committed, or nothing written yet.</p>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
