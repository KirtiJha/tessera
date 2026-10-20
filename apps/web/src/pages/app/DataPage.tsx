import { AlertTriangle, Download, Lock, ShieldOff, Unlock } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Field, Input, Modal, Panel, Select, Spinner, TagInput, Textarea, useConfirm, useToast } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { ago, fmtDate } from "../../lib/format";

interface Settings {
  excerpts: boolean;
  explainFailures: boolean;
  dlp: { emails: boolean; cards: boolean; nationalIds: boolean; ibans: boolean; terms: string[] };
  retainSamplesDays: number | null;
  retainEventsDays: number | null;
  retainSessionsDays: number | null;
  legalHold: { reason: string; by: string; since: string } | null;
}
interface Data {
  canEdit: boolean;
  settings: Settings;
  defaults: { retainSamplesDays: number; retainEventsDays: number; retainSessionsDays: number };
  /** The server has a Claude API key, so failures can be explained once an owner allows it. */
  explainAvailable?: boolean;
  stored: { sessions: number; events: number; audit: number; oldest: string | null };
  stream: { host: string; headerName: string | null; format: string; enabled: boolean; lastSentAt: string | null; lastError: string | null; pending: number } | null;
}
interface Person { id: string; name: string; email: string; role: string; status: string }

const FORMATS: [string, string, string][] = [
  ["splunk_hec", "Splunk HTTP Event Collector", "URL ending /services/collector/event; header Authorization = Splunk <token>"],
  ["json_array", "Datadog logs or a JSON array", "https://http-intake.logs.datadoghq.com/api/v2/logs; header DD-API-KEY"],
  ["ndjson", "Newline-delimited JSON", "Elastic, Vector, Fluent Bit, S3 via a collector, or your own endpoint"],
];

function Toggle({ checked, onChange, disabled, title, body }: { checked: boolean; onChange: (v: boolean) => void; disabled: boolean; title: string; body: string }) {
  return (
    <label className={`flex items-start gap-2.5 text-[13.5px] ${disabled ? "" : "cursor-pointer"}`}>
      <input type="checkbox" className="mt-1" disabled={disabled} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span><span className="font-medium text-snow">{title}</span><span className="block text-[12.5px] text-fog">{body}</span></span>
    </label>
  );
}

/** How Tessera keeps data: what is stored, for how long, holds, audit export and streaming, and a person's data. */
export function DataPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [d, setD] = useState<Data | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [hold, setHold] = useState("");
  const [range, setRange] = useState({ from: "", to: "" });
  const [st, setSt] = useState({ url: "", format: "splunk_hec", headerName: "Authorization", headerValue: "", fromStart: false });
  const [person, setPerson] = useState("");
  const [erase, setErase] = useState<Person | null>(null);
  const [confirmText, setConfirmText] = useState("");

  const load = useCallback(async () => {
    const [r, u] = await Promise.all([api.get<Data>("/api/admin/data"), api.get<{ users: Person[] }>("/api/admin/users")]);
    setD(r);
    setS(r.settings);
    setPeople(u.users);
    if (r.stream) setSt((x) => ({ ...x, format: r.stream!.format, headerName: r.stream!.headerName ?? "" }));
  }, []);
  useEffect(() => void load(), [load]);

  const run = async (label: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(label);
    try {
      await fn();
      toast(ok);
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "That did not work.", "error");
    }
    setBusy(null);
  };

  if (!d || !s) return <div className="flex h-64 items-center justify-center"><Spinner /></div>;
  const ro = !d.canEdit;
  const dirty = JSON.stringify(s) !== JSON.stringify(d.settings);
  const qs = new URLSearchParams(Object.entries(range).filter(([, v]) => v)).toString();
  const days = (k: "retainSamplesDays" | "retainEventsDays" | "retainSessionsDays", label: string, what: string) => (
    <Field label={label} hint={`${what}. Server default ${d.defaults[k]} days.`}>
      <Input type="number" min={1} max={3650} disabled={ro} value={s[k] ?? ""} placeholder={String(d.defaults[k])} onChange={(e) => setS({ ...s, [k]: e.target.value ? Number(e.target.value) : null })} />
    </Field>
  );

  return (
    <div className="mx-auto max-w-4xl p-3 sm:p-5">
      <h1 className="font-display text-[26px] font-semibold tracking-tight">Data and compliance</h1>
      <p className="mt-1 text-[14px] text-fog">What Tessera keeps about your sessions, for how long, and how it leaves. Holding {d.stored.sessions.toLocaleString()} sessions, {d.stored.events.toLocaleString()} events and {d.stored.audit.toLocaleString()} audit entries{d.stored.oldest ? `, the oldest from ${fmtDate(d.stored.oldest)}` : ""}.</p>
      {ro ? <p className="mt-3 rounded-lg border border-line-2 bg-slate-2 px-3 py-2 text-[13px] text-mist">Only an owner can change these settings. Admins can export.</p> : null}

      {s.legalHold ? (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-amber-400/40 bg-amber-400/10 p-4 text-[13.5px]">
          <Lock size={18} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="flex-1"><div className="font-medium text-snow">Legal hold is on</div><div className="text-mist">{s.legalHold.reason} · set by {s.legalHold.by} {ago(s.legalHold.since)} ago. Nothing is pruned or erased while it is on.</div></div>
          {!ro ? <Button size="sm" loading={busy === "release"} onClick={() => void confirm({ title: "Release the legal hold?", body: "Retention starts deleting old data again.", action: "Release" }).then((ok) => { if (ok) void run("release", () => api.post("/api/admin/data/legal-hold", { on: false }), "Hold released."); })}><Unlock size={14} /> Release</Button> : null}
        </div>
      ) : null}

      <Panel title="What Tessera keeps" className="mt-5">
        <div className="space-y-4">
          <Toggle disabled={ro} checked={!s.excerpts} onChange={(v) => setS({ ...s, excerpts: !v })} title="Metadata only" body="Drop prompt text, agent task and answer excerpts, and session names taken from prompts before they are stored, and collect no diffs from engineers' machines. Tool prompts waiting on a person are kept so they can be answered." />
          <Toggle disabled={ro || !d!.explainAvailable || !s.excerpts} checked={s.explainFailures && s.excerpts} onChange={(v) => setS({ ...s, explainFailures: v })} title="Explain failures with Claude" body={d!.explainAvailable ? "Offer \"Explain this failure\" on failed tool calls and agents. The failure's error output, already redacted on the engineer's machine and with the removals below applied, is sent to the Claude API, which answers in three lines. Off by default; each use is in the audit log." : "Needs a Claude API key on the server (ANTHROPIC_API_KEY). Ask whoever runs Tessera to set it; then an owner can turn this on."} />
          <div>
            <div className="mb-2 text-[13px] font-medium text-mist">Remove before storing</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Toggle disabled={ro} checked={s.dlp.emails} onChange={(v) => setS({ ...s, dlp: { ...s.dlp, emails: v } })} title="Email addresses" body="Replaced with [email]." />
              <Toggle disabled={ro} checked={s.dlp.cards} onChange={(v) => setS({ ...s, dlp: { ...s.dlp, cards: v } })} title="Payment card numbers" body="Luhn-checked, so order numbers stay." />
              <Toggle disabled={ro} checked={s.dlp.nationalIds} onChange={(v) => setS({ ...s, dlp: { ...s.dlp, nationalIds: v } })} title="US Social Security numbers" body="Replaced with [id-number]." />
              <Toggle disabled={ro} checked={s.dlp.ibans} onChange={(v) => setS({ ...s, dlp: { ...s.dlp, ibans: v } })} title="IBANs" body="Checksum-verified bank account numbers." />
            </div>
          </div>
          <Field label="Words and names to remove" hint="Customer names, project code names. Matched anywhere, ignoring case. Secrets (keys, tokens, passwords) are always removed, on the machine and again here.">
            <TagInput mono={false} value={s.dlp.terms} onChange={(terms) => !ro && setS({ ...s, dlp: { ...s.dlp, terms } })} placeholder="Project Falcon" />
          </Field>
        </div>
      </Panel>

      <Panel title="How long" className="mt-4">
        <div className="grid gap-4 sm:grid-cols-3">
          {days("retainSamplesDays", "Per-minute samples", "Cost and token curves")}
          {days("retainEventsDays", "Events and policy decisions", "Activity lines")}
          {days("retainSessionsDays", "Sessions", "With their agents, prompts and daily spend")}
        </div>
        <p className="mt-3 text-[12.5px] text-fog">The audit log is never pruned, so its hash chain always verifies from the first entry. Daily spend outlives the samples it is rolled up from.</p>
      </Panel>

      {!ro ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {!s.legalHold ? (
            <div className="flex flex-1 items-center gap-2">
              <Input value={hold} onChange={(e) => setHold(e.target.value)} placeholder="Reason for a legal hold (matter or ticket)" className="h-9 max-w-sm text-[13px]" />
              <Button size="sm" disabled={!hold.trim()} loading={busy === "hold"} onClick={() => void run("hold", () => api.post("/api/admin/data/legal-hold", { on: true, reason: hold }), "Legal hold on. Nothing will be pruned or erased.").then(() => setHold(""))}><Lock size={14} /> Place legal hold</Button>
            </div>
          ) : <div className="flex-1" />}
          <Button variant="primary" disabled={!dirty} loading={busy === "save"} onClick={() => void run("save", () => api.put("/api/admin/data/settings", s), "Saved. New reports follow it straight away.")}>Save</Button>
        </div>
      ) : null}

      <Panel title="Audit log" className="mt-4">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="From"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className="h-9 w-40" /></Field>
          <Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} className="h-9 w-40" /></Field>
          <a href={`/api/admin/data/audit/export?format=jsonl${qs ? `&${qs}` : ""}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-2 bg-slate-2 px-3 text-[13px] font-medium text-snow hover:bg-slate-3"><Download size={14} /> JSON lines</a>
          <a href={`/api/admin/data/audit/export?format=csv${qs ? `&${qs}` : ""}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-2 bg-slate-2 px-3 text-[13px] font-medium text-snow hover:bg-slate-3"><Download size={14} /> CSV</a>
        </div>
        <div className="mt-5 border-t border-line pt-4">
          <div className="text-[13.5px] font-medium text-snow">Stream to your SIEM</div>
          <p className="mt-0.5 text-[12.5px] text-fog">Every new entry is sent within about 15 seconds, in order, with its hash and the previous one, so the chain can be checked on your side too. A failed delivery is retried from where it stopped.</p>
          {d.stream ? (
            <div className={`mt-3 rounded-lg border px-3 py-2 text-[12.5px] ${d.stream.lastError ? "border-rose-600/50 text-rose-400" : "border-line text-mist"}`}>
              {d.stream.enabled ? "On" : "Off"} · {FORMATS.find((f) => f[0] === d.stream!.format)?.[1]} · {d.stream.lastError ? `last error: ${d.stream.lastError}` : d.stream.lastSentAt ? `last delivery ${ago(d.stream.lastSentAt)} ago` : "nothing sent yet"}{d.stream.pending ? ` · ${d.stream.pending} waiting` : ""}
            </div>
          ) : null}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Format" hint={FORMATS.find((f) => f[0] === st.format)?.[2]}>
              <Select disabled={ro} value={st.format} onChange={(e) => setSt({ ...st, format: e.target.value, headerName: e.target.value === "splunk_hec" ? "Authorization" : e.target.value === "json_array" ? "DD-API-KEY" : st.headerName })}>{FORMATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
            </Field>
            <Field label="URL" hint={d.stream ? `Saved for ${d.stream.host}, stored encrypted. Leave empty to keep it.` : "Stored encrypted."}><Input disabled={ro} value={st.url} onChange={(e) => setSt({ ...st, url: e.target.value })} placeholder={d.stream ? `https://${d.stream.host}/…` : "https://splunk.example.com:8088/services/collector/event"} /></Field>
            <Field label="Header name" hint="Optional."><Input disabled={ro} value={st.headerName} onChange={(e) => setSt({ ...st, headerName: e.target.value })} /></Field>
            <Field label="Header value" hint={d.stream?.headerName ? "Stored encrypted. Leave empty to keep it." : "Stored encrypted."}><Input disabled={ro} type="password" autoComplete="off" value={st.headerValue} onChange={(e) => setSt({ ...st, headerValue: e.target.value })} placeholder={d.stream?.headerName ? "••••••••" : "Splunk 00000000-…"} /></Field>
          </div>
          {!ro ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="mr-auto flex items-center gap-2 text-[12.5px] text-mist"><input type="checkbox" checked={st.fromStart} onChange={(e) => setSt({ ...st, fromStart: e.target.checked })} /> Send the whole log from the first entry</label>
              {d.stream ? <Button size="sm" onClick={() => void run("test", async () => { const r = await api.post<{ ok: boolean; error: string | null }>("/api/admin/data/audit/stream/test"); if (!r.ok) throw new ApiError(400, `The destination answered: ${r.error}`); }, "Test entry delivered.")}>Send a test</Button> : null}
              {d.stream ? <Button size="sm" onClick={() => void confirm({ title: "Stop streaming the audit log?", action: "Stop streaming", tone: "danger" }).then((ok) => { if (ok) void run("del", () => api.del("/api/admin/data/audit/stream"), "Streaming stopped."); })}>Remove</Button> : null}
              <Button size="sm" variant="primary" disabled={!st.url && !d.stream} loading={busy === "stream"} onClick={() => void run("stream", () => api.put("/api/admin/data/audit/stream", { url: st.url.trim() || undefined, format: st.format, headerName: st.headerName.trim() || null, headerValue: st.headerValue || undefined, fromStart: st.fromStart }), "Streaming saved.")}>Save destination</Button>
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel title="A person's data" className="mt-4">
        <p className="text-[13px] text-mist">For access and erasure requests. The export holds everything Tessera keeps about the person. Erasure deletes their sessions with everything under them, their devices and keys, and replaces their name and email; the audit log keeps its entries as the record of what happened.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select aria-label="Person" value={person} onChange={(e) => setPerson(e.target.value)} className="h-9 max-w-sm text-[13px]">
            <option value="">Choose a person…</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.email}</option>)}
          </Select>
          <a aria-disabled={!person} href={person ? `/api/admin/data/people/${person}/export` : undefined} className={`inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-2 bg-slate-2 px-3 text-[13px] font-medium text-snow ${person ? "hover:bg-slate-3" : "pointer-events-none opacity-50"}`}><Download size={14} /> Export</a>
          {!ro ? <Button size="sm" variant="danger" disabled={!person || !!s.legalHold} title={s.legalHold ? "Not while a legal hold is on" : undefined} onClick={() => { setErase(people.find((p) => p.id === person) ?? null); setConfirmText(""); }}><ShieldOff size={14} /> Erase…</Button> : null}
        </div>
      </Panel>

      <Modal open={!!erase} onClose={() => setErase(null)} title={`Erase ${erase?.name ?? ""}`}>
        <div className="flex gap-3 rounded-lg border border-rose-600/50 bg-rose-600/10 p-3 text-[13px] text-mist"><AlertTriangle size={18} className="shrink-0 text-rose-400" /> This cannot be undone. Their sessions, devices and API keys are deleted, and their account is kept only as "Erased person" so the audit log still reads.</div>
        <Field label={`Type ${erase?.email ?? ""} to confirm`}><Textarea rows={1} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} className="mt-1 font-mono text-[13px]" /></Field>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setErase(null)}>Cancel</Button>
          <Button variant="danger" disabled={confirmText.trim().toLowerCase() !== erase?.email.toLowerCase()} loading={busy === "erase"} onClick={() => { const who = erase!; setErase(null); void run("erase", () => api.post(`/api/admin/data/people/${who.id}/erase`, { confirm: confirmText }), `${who.name}'s data was erased.`).then(() => setPerson("")); }}>Erase</Button>
        </div>
      </Modal>
    </div>
  );
}
