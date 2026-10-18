import { Plus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, Empty, Field, Input, Modal, Panel, Select, useToast } from "../../components/ui";
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

// ---- Notifications ----------------------------------------------------------------
interface Channel { id: string; kind: string; name: string; events: string[]; enabled: boolean; lastSentAt: string | null; lastError: string | null }
const EVENTS: [string, string][] = [["session.waiting", "A session waits on someone"], ["agent.failed", "An agent fails"], ["context.blowout", "A context window overflows"], ["budget.breach", "A budget limit is reached"], ["session.stale", "A session goes silent"]];

export function Notifications() {
  const toast = useToast();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ kind: "slack_webhook", name: "", url: "", events: EVENTS.slice(0, 4).map((e) => e[0]) });
  const load = useCallback(() => api.get<{ channels: Channel[] }>("/api/admin/channels").then((r) => setChannels(r.channels)), []);
  useEffect(() => void load(), [load]);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/api/admin/channels", f);
      setOpen(false);
      setF({ ...f, name: "", url: "" });
      toast("Channel added.");
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not add the channel.", "error");
    }
  };
  const test = async (c: Channel) => {
    const r = await api.post<{ error: string | null }>(`/api/admin/channels/${c.id}/test`);
    toast(r.error ? `The channel answered with an error: ${r.error}` : "Test sent.", r.error ? "error" : "ok");
    await load();
  };
  return (
    <div className="mx-auto max-w-4xl p-5">
      <h1 className="font-display text-[26px] font-semibold tracking-tight">Notifications</h1>
      <p className="mt-1 text-[14px] text-fog">Push what matters to Slack or any webhook. Each event is sent once per channel; the URL is stored encrypted.</p>
      <Panel title="Channels" className="mt-5" action={<Button size="sm" variant="primary" onClick={() => setOpen(true)}><Plus size={14} /> Add a channel</Button>}>
        {!channels ? null : channels.length === 0 ? <Empty title="No channels" body="Add a Slack incoming webhook or a plain https webhook to get told when a session waits, an agent fails or a budget is hit." /> : (
          <ul className="divide-y divide-line">
            {channels.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 py-3 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-snow">{c.name} <span className="text-fog">· {c.kind === "slack_webhook" ? "Slack" : "Webhook"}</span></div>
                  <div className="text-[12px] text-fog">{c.events.map((e) => EVENTS.find((x) => x[0] === e)?.[1] ?? e).join(" · ")}</div>
                  <div className="text-[12px] text-fog">{c.lastError ? <span className="text-rose-400">last error: {c.lastError}</span> : c.lastSentAt ? `last sent ${fmtDate(c.lastSentAt)}` : "nothing sent yet"}</div>
                </div>
                <label className="flex items-center gap-1.5 text-mist"><input type="checkbox" checked={c.enabled} onChange={(e) => void api.patch(`/api/admin/channels/${c.id}`, { enabled: e.target.checked }).then(load)} /> enabled</label>
                <Button size="sm" onClick={() => void test(c)}>Send a test</Button>
                <button onClick={() => { if (confirm("Delete this channel?")) void api.del(`/api/admin/channels/${c.id}`).then(load); }} className="text-fog hover:text-rose-400">Delete</button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Modal open={open} onClose={() => setOpen(false)} title="Add a channel">
        <form onSubmit={add} className="space-y-4">
          <Field label="Type"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="slack_webhook">Slack incoming webhook</option><option value="webhook">Plain webhook (JSON POST)</option></Select></Field>
          <Field label="Name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="#agents-alerts" /></Field>
          <Field label="URL" hint="https only. Stored encrypted."><Input required type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://hooks.slack.com/services/…" /></Field>
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-mist">Send when</div>
            <div className="space-y-1.5">{EVENTS.map(([k, label]) => <label key={k} className="flex items-center gap-2 text-[13.5px]"><input type="checkbox" checked={f.events.includes(k)} onChange={(e) => setF({ ...f, events: e.target.checked ? [...f.events, k] : f.events.filter((x) => x !== k) })} /> {label}</label>)}</div>
          </div>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" variant="primary">Add channel</Button></div>
        </form>
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
