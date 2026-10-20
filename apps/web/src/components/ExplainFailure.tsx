import { Sparkles } from "lucide-react";
import { useState } from "react";
import { api, ApiError } from "../lib/api";

interface Explanation { text: string; model: string; at: string; cached: boolean }

/**
 * Ask Claude what went wrong with a failed tool call or agent, from the
 * redacted error the reporter sent. Shown only where the organisation turned
 * it on; the answer says it came from a model and can be wrong.
 */
export function ExplainFailure({ sessionId, target }: { sessionId: string; target: { kind: "agent" | "action"; id: string } }) {
  const [busy, setBusy] = useState(false);
  const [e, setE] = useState<Explanation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ask = async () => {
    setBusy(true);
    setErr(null);
    try {
      setE(await api.post<Explanation>(`/api/fleet/sessions/${encodeURIComponent(sessionId)}/explain`, target));
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : "Could not get an explanation.");
    } finally {
      setBusy(false);
    }
  };
  if (e)
    return (
      <div className="mt-2 rounded-lg border border-violet-400/30 bg-violet-400/5 p-2.5 text-[12.5px]" aria-live="polite">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-violet-400"><Sparkles size={12} aria-hidden="true" /> Explained by {e.model}</div>
        <p className="whitespace-pre-wrap text-snow">{e.text}</p>
        <p className="mt-1 text-[11px] text-fog">A model's reading of the error text only; it can be wrong. Check before acting on it.</p>
      </div>
    );
  return (
    <div className="mt-2">
      <button type="button" onClick={() => void ask()} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md border border-violet-400/40 px-2 py-1 text-[12px] text-violet-400 hover:bg-violet-400/10 disabled:opacity-60">
        <Sparkles size={12} aria-hidden="true" /> {busy ? "Asking Claude…" : "Explain this failure"}
      </button>
      {err ? <p className="mt-1 text-[12px] text-rose-400">{err}</p> : null}
    </div>
  );
}
