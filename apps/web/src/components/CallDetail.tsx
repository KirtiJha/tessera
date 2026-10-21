import type { Action, ActionDetail } from "@tessera/contract";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { PatchView } from "./FileDiffs";

interface Full { action: Action; canSeeCode: boolean; keeps: { toolOutput: boolean; edits: boolean } }

const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Everything kept about one tool call, below its row: the whole command and
 * its description, the path, lines changed, the last lines it printed and what
 * an edit changed. Read from the server when the row opens, since the wall only
 * carries each call's light detail; output and patches only for people who can
 * act on the session, and only where the organisation keeps them.
 */
export function CallDetail({ sessionId, action }: { sessionId: string; action: Action }) {
  const [full, setFull] = useState<Full | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // A running call is fetched again when it ends, for its output.
  useEffect(() => {
    let gone = false;
    api
      .get<Full>(`/api/fleet/sessions/${encodeURIComponent(sessionId)}/actions/${encodeURIComponent(action.id)}`)
      .then((r) => !gone && setFull(r))
      .catch((e) => !gone && setErr(e instanceof ApiError && e.status === 404 ? null : e instanceof ApiError ? e.message : "Could not load this call."));
    return () => {
      gone = true;
    };
  }, [sessionId, action.id, action.status]);

  const d: ActionDetail = { ...action.detail, ...full?.action.detail };
  const keeps = full?.keeps;
  const isEdit = EDITS.has(action.tool);
  const isBash = action.tool === "Bash";
  const notKept = (what: string) => (
    <p className="text-[11.5px] text-fog">
      {what} not kept. An owner can turn it on in <Link to="/app/data" className="text-mist underline hover:text-teal-300">Data and compliance</Link>.
    </p>
  );

  if (action.withheld) return <p className="col-span-2 text-[11.5px] text-amber-400">This call's text was withheld: a web filter on the engineer's network blocks it. Its timing and result are real.</p>;
  return (
    <>
      {d.description ? (
        <>
          <dt className="text-ash">Why</dt>
          <dd>{d.description}</dd>
        </>
      ) : null}
      {d.command ? (
        <>
          <dt className="text-ash">Command</dt>
          <dd><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ink px-2 py-1.5 font-mono text-[11.5px] text-snow">{d.command}</pre></dd>
        </>
      ) : null}
      {d.path || d.pattern || d.url ? (
        <>
          <dt className="text-ash">{d.url ? "URL" : d.pattern ? "Pattern" : "Path"}</dt>
          <dd className="break-all font-mono">{d.url ?? (d.pattern ? `${d.pattern}${d.path ? ` in ${d.path}` : ""}` : d.path)}</dd>
        </>
      ) : null}
      {d.added !== undefined || d.removed !== undefined ? (
        <>
          <dt className="text-ash">Lines</dt>
          <dd><span className="text-teal-300">+{d.added ?? 0}</span> <span className="text-rose-400">−{d.removed ?? 0}</span></dd>
        </>
      ) : null}
      {d.interrupted ? (
        <>
          <dt className="text-ash">Stopped</dt>
          <dd className="text-amber-400">interrupted before it finished</dd>
        </>
      ) : null}
      {d.output ? (
        <>
          <dt className="text-ash">Output</dt>
          <dd>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ink px-2 py-1.5 font-mono text-[11.5px] text-mist">{d.output.tail}</pre>
            <p className="mt-0.5 text-[11px] text-ash">{d.output.truncated ? `Last lines of ${d.output.lines} printed, redacted.` : `${d.output.lines} line${d.output.lines === 1 ? "" : "s"} printed, redacted.`}</p>
          </dd>
        </>
      ) : null}
      {d.patch ? (
        <>
          <dt className="text-ash">Change</dt>
          <dd className="overflow-hidden rounded-md border border-line bg-ink-2"><PatchView patch={d.patch} truncated={d.patchTruncated} note="Cut at 20,000 characters." /></dd>
        </>
      ) : null}
      {full && full.canSeeCode && action.status !== "running" ? (
        <dd className="col-span-2">
          {isBash && !d.output && !keeps?.toolOutput ? notKept("Command output is") : null}
          {isEdit && !d.patch && !keeps?.edits ? notKept("What edits change is") : null}
        </dd>
      ) : null}
      {err ? <dd className="col-span-2 text-[11.5px] text-rose-400">{err}</dd> : null}
    </>
  );
}
