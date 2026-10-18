import { Plus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, Field, Input, Modal, Panel, useToast } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { fmtDate } from "../../lib/format";

// ---- Model prices ---------------------------------------------------------------
interface Price { prefix: string; label: string; input: number; output: number; cacheRead: number; cacheWrite: number; updatedAt?: string }

export function Prices() {
  const toast = useToast();
  const [data, setData] = useState<{ asOf: string; builtin: Price[]; overrides: Price[] } | null>(null);
  const [edit, setEdit] = useState<Price | null>(null);
  const load = useCallback(() => api.get<{ asOf: string; builtin: Price[]; overrides: Price[] }>("/api/admin/prices").then(setData), []);
  useEffect(() => void load(), [load]);
  const save = async () => {
    if (!edit) return;
    try {
      await api.put("/api/admin/prices", edit);
      setEdit(null);
      toast("Price saved. Every figure now uses it.");
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not save.", "error");
    }
  };
  const overridden = new Set(data?.overrides.map((o) => o.prefix.toLowerCase()));
  const Row = ({ p, custom }: { p: Price; custom: boolean }) => (
    <tr className="text-mist">
      <td className="py-2 font-medium text-snow">{p.label}{custom ? <span className="ml-2 rounded bg-teal-700/40 px-1.5 text-[10.5px] text-teal-300">yours</span> : overridden.has(p.prefix.toLowerCase()) ? <span className="ml-2 rounded bg-slate-3 px-1.5 text-[10.5px] text-fog">overridden</span> : null}</td>
      <td className="py-2 font-mono text-[12px]">{p.prefix}</td>
      <td className="py-2 text-right">{p.input}</td><td className="py-2 text-right">{p.output}</td><td className="py-2 text-right">{p.cacheRead}</td><td className="py-2 text-right">{p.cacheWrite}</td>
      <td className="py-2 text-right"><button onClick={() => setEdit({ ...p })} className="text-teal-300 hover:underline">{custom ? "Edit" : "Override"}</button>{custom ? <button onClick={() => void api.del(`/api/admin/prices/${encodeURIComponent(p.prefix)}`).then(load)} className="ml-3 text-fog hover:text-rose-400">Remove</button> : null}</td>
    </tr>
  );
  return (
    <div className="mx-auto max-w-5xl p-5">
      <h1 className="font-display text-[26px] font-semibold tracking-tight">Model prices</h1>
      <p className="mt-1 text-[14px] text-fog">USD per million tokens. Built-in list prices as of {data?.asOf}; override any with your contracted rate, or add a model Tessera does not know. Changes reprice everything at once.</p>
      <Panel title="Prices" className="mt-5" action={<Button size="sm" variant="primary" onClick={() => setEdit({ prefix: "", label: "", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })}><Plus size={14} /> Add a model</Button>}>
        <table className="w-full text-[13px]">
          <thead className="text-left text-[11.5px] text-fog"><tr><th className="pb-2 font-medium">Model</th><th className="pb-2 font-medium">Matches ids starting with</th><th className="pb-2 text-right font-medium">Input</th><th className="pb-2 text-right font-medium">Output</th><th className="pb-2 text-right font-medium">Cache read</th><th className="pb-2 text-right font-medium">Cache write</th><th /></tr></thead>
          <tbody className="divide-y divide-line">
            {data?.overrides.map((p) => <Row key={`o-${p.prefix}`} p={p} custom />)}
            {data?.builtin.filter((p) => !overridden.has(p.prefix.toLowerCase())).map((p) => <Row key={p.prefix} p={p} custom={false} />)}
          </tbody>
        </table>
      </Panel>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.label ? `Price for ${edit.label}` : "Add a model"}>
        {edit ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Label"><Input value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} /></Field>
              <Field label="Model id prefix" hint="e.g. claude-sonnet-4-5"><Input value={edit.prefix} onChange={(e) => setEdit({ ...edit, prefix: e.target.value })} /></Field>
            </div>
            <div className="grid grid-cols-4 gap-3">
              {(["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => <Field key={k} label={k}><Input type="number" step="0.0001" min={0} value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: Number(e.target.value) })} /></Field>)}
            </div>
            <div className="flex justify-end gap-2"><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" disabled={!edit.prefix.trim() || !edit.label.trim()} onClick={() => void save()}>Save</Button></div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

// ---- Audit --------------------------------------------------------------------------
interface Entry { id: number; actorName: string; action: string; targetType: string | null; targetId: string | null; detail: Record<string, unknown>; ip: string | null; createdAt: string; hash: string }

export function Audit() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; brokenAt: number | null } | null>(null);
  const [more, setMore] = useState(true);
  const load = useCallback(async (before?: number) => {
    const r = await api.get<{ entries: Entry[] }>(`/api/admin/audit?limit=50${before ? `&before=${before}` : ""}`);
    setEntries((e) => (before ? [...e, ...r.entries] : r.entries));
    setMore(r.entries.length === 50);
  }, []);
  useEffect(() => void load(), [load]);
  return (
    <div className="mx-auto max-w-5xl p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-semibold tracking-tight">Audit log</h1>
          <p className="mt-1 text-[14px] text-fog">Every change and every action on a session, append-only, each entry hashed with the one before it.</p>
        </div>
        <div className="flex items-center gap-3">
          {verify ? <span className={`text-[13px] ${verify.ok ? "text-teal-300" : "text-rose-400"}`}>{verify.ok ? `Chain intact · ${verify.checked} entries` : `Chain broken at entry ${verify.brokenAt}`}</span> : null}
          <Button size="sm" onClick={() => void api.get<typeof verify>("/api/admin/audit/verify").then(setVerify)}>Verify chain</Button>
        </div>
      </div>
      <div className="mt-5 overflow-hidden rounded-xl border border-line">
        <table className="w-full text-[13px]">
          <thead className="bg-slate-1 text-left text-[11.5px] text-fog"><tr><th className="px-4 py-2.5 font-medium">When</th><th className="px-3 py-2.5 font-medium">Who</th><th className="px-3 py-2.5 font-medium">Action</th><th className="px-3 py-2.5 font-medium">Target</th><th className="px-3 py-2.5 font-medium">Detail</th><th className="px-4 py-2.5 font-medium">Hash</th></tr></thead>
          <tbody className="divide-y divide-line">
            {entries.map((e) => (
              <tr key={e.id} className="text-mist">
                <td className="px-4 py-2 whitespace-nowrap">{fmtDate(e.createdAt)}</td>
                <td className="px-3 py-2 text-snow">{e.actorName}</td>
                <td className="px-3 py-2 font-mono text-[12px]">{e.action}</td>
                <td className="px-3 py-2 font-mono text-[11.5px] text-fog">{e.targetType ? `${e.targetType} ${e.targetId?.slice(0, 12) ?? ""}` : ""}</td>
                <td className="max-w-[320px] truncate px-3 py-2 font-mono text-[11.5px] text-fog" title={JSON.stringify(e.detail)}>{Object.keys(e.detail).length ? JSON.stringify(e.detail) : ""}</td>
                <td className="px-4 py-2 font-mono text-[11px] text-ash">{e.hash.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more ? <div className="mt-3"><Button size="sm" onClick={() => void load(entries.at(-1)?.id)}>Load older</Button></div> : null}
    </div>
  );
}

// ---- Account --------------------------------------------------------------------------
export function Account() {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/api/auth/password", { current, next });
      setCurrent("");
      setNext("");
      toast("Password changed. Other browsers were signed out.");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not change the password.", "error");
    }
  };
  return (
    <div className="mx-auto max-w-lg p-5">
      <h1 className="font-display text-[26px] font-semibold tracking-tight">Account</h1>
      <Panel title="Change password" className="mt-5">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Current password"><Input type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" /></Field>
          <Field label="New password" hint="At least 10 characters."><Input type="password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field>
          <Button type="submit" variant="primary">Change password</Button>
        </form>
      </Panel>
    </div>
  );
}
