import { AnimatePresence, motion } from "framer-motion";
import { BellRing, Check, Copy, Hash, Plus, Siren, Webhook, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, Empty, Field, Input, Modal, Panel, Select, useToast } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { fmtDate } from "../../lib/format";

type Kind = "slack_app" | "slack_webhook" | "teams_webhook" | "pagerduty" | "webhook";
interface Channel { id: string; kind: Kind; name: string; events: string[]; enabled: boolean; delaySeconds: number; slackChannel: string | null; signed: boolean | null; lastSentAt: string | null; lastError: string | null }
interface Data { channels: Channel[]; slack: { requestUrl: string; manifest: Record<string, unknown> } }

export const EVENTS: [string, string][] = [
  ["session.waiting", "A session waits on someone"],
  ["agent.failed", "An agent fails"],
  ["context.blowout", "A context window overflows"],
  ["budget.breach", "A budget limit is reached"],
  ["policy.denied", "A policy denies a tool call"],
  ["session.stale", "A session goes silent"],
];

const KINDS: { kind: Kind; label: string; blurb: string; icon: LucideIcon }[] = [
  { kind: "slack_app", label: "Slack app", blurb: "Messages with Allow, Deny and Approve buttons. Answers are made as the person who pressed.", icon: Hash },
  { kind: "slack_webhook", label: "Slack webhook", blurb: "A message in one channel with a link back. No buttons.", icon: Hash },
  { kind: "teams_webhook", label: "Microsoft Teams", blurb: "An adaptive card through a Teams workflow webhook.", icon: BellRing },
  { kind: "pagerduty", label: "PagerDuty", blurb: "Opens an incident and resolves it when the session moves on.", icon: Siren },
  { kind: "webhook", label: "Webhook", blurb: "Signed JSON to any https endpoint.", icon: Webhook },
];
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.kind, k.label])) as Record<Kind, string>;

const DELAYS: [number, string][] = [[0, "Right away"], [120, "After 2 minutes"], [300, "After 5 minutes"], [900, "After 15 minutes"], [3600, "After an hour"]];
const delayLabel = (s: number) => DELAYS.find((d) => d[0] === s)?.[1].toLowerCase() ?? `after ${Math.round(s / 60)} min`;

const blank = { kind: "slack_app" as Kind, name: "", url: "", botToken: "", signingSecret: "", channel: "", routingKey: "", events: EVENTS.slice(0, 4).map((e) => e[0]), delaySeconds: 0 };

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="sm" type="button" onClick={() => void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}>
      {done ? <Check size={14} /> : <Copy size={14} />} {done ? "Copied" : label}
    </Button>
  );
}

export function Notifications() {
  const toast = useToast();
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState(blank);
  const [secret, setSecret] = useState<string | null>(null);
  const load = useCallback(() => api.get<Data>("/api/admin/channels").then(setData), []);
  useEffect(() => void load(), [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { kind, name, events, delaySeconds } = f;
      const extra = kind === "slack_app" ? { botToken: f.botToken, signingSecret: f.signingSecret, channel: f.channel } : kind === "pagerduty" ? { routingKey: f.routingKey } : { url: f.url };
      const r = await api.post<{ signingSecret: string | null }>("/api/admin/channels", { kind, name, events, delaySeconds, ...extra });
      setOpen(false);
      setF(blank);
      if (r.signingSecret) setSecret(r.signingSecret);
      else toast("Channel added. Send a test to check it.");
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not add the channel.", "error");
    } finally {
      setBusy(false);
    }
  };
  const test = async (c: Channel) => {
    const r = await api.post<{ error: string | null }>(`/api/admin/channels/${c.id}/test`);
    toast(r.error ? `The channel answered with an error: ${r.error}` : "Test sent.", r.error ? "error" : "ok");
    await load();
  };
  const patch = (c: Channel, body: Partial<Pick<Channel, "enabled" | "delaySeconds">>) => void api.patch(`/api/admin/channels/${c.id}`, body).then(load);

  return (
    <div className="mx-auto max-w-4xl p-5">
      <h1 className="font-display text-[26px] font-semibold tracking-tight">Notifications</h1>
      <p className="mt-1 text-[14px] text-fog">Tell people where they already are. With the Slack app, a waiting permission prompt or plan can be answered from the message itself, under the same rules as the console.</p>
      <Panel title="Channels" className="mt-5" action={<Button size="sm" variant="primary" onClick={() => setOpen(true)}><Plus size={14} /> Add a channel</Button>}>
        {!data ? null : data.channels.length === 0 ? (
          <Empty title="No channels yet" body="Add the Slack app to answer sessions from Slack, PagerDuty for on-call, or a webhook for anything else." action={<Button variant="primary" onClick={() => setOpen(true)}><Plus size={14} /> Add a channel</Button>} />
        ) : (
          <ul className="divide-y divide-line">
            {data.channels.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 py-3 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-snow">
                    {c.name} <span className="ml-1 rounded bg-slate-3 px-1.5 py-0.5 text-[10.5px] font-medium text-mist">{KIND_LABEL[c.kind] ?? c.kind}</span>
                    {c.kind === "slack_app" ? <span className="ml-1.5 text-[11.5px] text-fog">buttons on · {c.slackChannel}</span> : null}
                    {c.kind === "webhook" && c.signed ? <span className="ml-1.5 text-[11.5px] text-fog">signed</span> : null}
                  </div>
                  <div className="text-[12px] text-fog">{c.events.map((e) => EVENTS.find((x) => x[0] === e)?.[1] ?? e).join(" · ")}</div>
                  <div className="text-[12px] text-fog">{c.lastError ? <span className="text-rose-400">last error: {c.lastError}</span> : c.lastSentAt ? `last sent ${fmtDate(c.lastSentAt)}` : "nothing sent yet"}</div>
                </div>
                {c.events.includes("session.waiting") ? (
                  <select aria-label="When to notify about waiting sessions" value={c.delaySeconds} onChange={(e) => patch(c, { delaySeconds: Number(e.target.value) })} className="rounded-md border border-line-2 bg-ink-2 px-2 py-1 text-[12.5px] text-snow" title="When a waiting session is sent to this channel">
                    {DELAYS.map(([s, l]) => <option key={s} value={s}>Waiting: {l.toLowerCase()}</option>)}
                    {DELAYS.some((d) => d[0] === c.delaySeconds) ? null : <option value={c.delaySeconds}>Waiting: {delayLabel(c.delaySeconds)}</option>}
                  </select>
                ) : null}
                <label className="flex items-center gap-1.5 text-mist"><input type="checkbox" checked={c.enabled} onChange={(e) => patch(c, { enabled: e.target.checked })} /> enabled</label>
                <Button size="sm" onClick={() => void test(c)}>Send a test</Button>
                <button onClick={() => { if (confirm(`Delete ${c.name}?`)) void api.del(`/api/admin/channels/${c.id}`).then(load); }} className="text-fog hover:text-rose-400">Delete</button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <p className="mt-3 text-[12.5px] text-fog">An escalation channel (for example, team leads after 15 minutes) only hears about a session that is still waiting by then. Each event is sent once per channel; URLs, tokens and keys are stored encrypted.</p>

      <Modal open={open} onClose={() => setOpen(false)} title="Add a channel" width={640}>
        <form onSubmit={add} className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            {KINDS.map(({ kind, label, blurb, icon: Icon }) => (
              <button key={kind} type="button" onClick={() => setF({ ...f, kind })} className={`flex gap-3 rounded-xl border p-3 text-left transition-colors ${f.kind === kind ? "border-teal-400 bg-teal-700/15" : "border-line-2 hover:border-line-2 hover:bg-slate-2"}`} aria-pressed={f.kind === kind}>
                <Icon size={18} className={`mt-0.5 shrink-0 ${f.kind === kind ? "text-teal-300" : "text-fog"}`} />
                <span><span className="block text-[13.5px] font-medium text-snow">{label}</span><span className="block text-[12px] leading-snug text-fog">{blurb}</span></span>
              </button>
            ))}
          </div>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={f.kind} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.15 }} className="space-y-4">
              {f.kind === "slack_app" && data ? (
                <ol className="space-y-2 rounded-xl border border-line bg-ink-2 p-3 text-[12.5px] leading-relaxed text-mist">
                  <li><span className="font-medium text-snow">1.</span> At api.slack.com/apps, choose Create New App → From a manifest, and paste this. It sets the bot's permissions and points its buttons at this server. <span className="ml-1 inline-block align-middle"><CopyButton text={JSON.stringify(data.slack.manifest, null, 2)} label="Copy manifest" /></span></li>
                  <li><span className="font-medium text-snow">2.</span> Install it to your workspace, invite the Tessera bot to the channel (<span className="font-mono">/invite @Tessera</span>), and copy the Bot User OAuth Token and the Signing Secret below.</li>
                  <li><span className="font-medium text-snow">3.</span> People are matched to Tessera by their Slack email, so they need a Tessera account with the same address.</li>
                  <li className="font-mono text-[11.5px] text-fog">Interactivity URL: {data.slack.requestUrl}</li>
                </ol>
              ) : null}
              <Field label="Name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={f.kind === "pagerduty" ? "Agents on-call" : "#agents"} /></Field>
              {f.kind === "slack_app" ? (
                <>
                  <Field label="Bot User OAuth Token" hint="Starts with xoxb-. Checked with Slack before it is saved."><Input required value={f.botToken} onChange={(e) => setF({ ...f, botToken: e.target.value })} placeholder="xoxb-…" autoComplete="off" /></Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Signing Secret" hint="Basic Information → App Credentials."><Input required value={f.signingSecret} onChange={(e) => setF({ ...f, signingSecret: e.target.value })} autoComplete="off" /></Field>
                    <Field label="Channel ID" hint="In Slack: channel details → bottom of About."><Input required value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} placeholder="C0123456789" /></Field>
                  </div>
                </>
              ) : f.kind === "pagerduty" ? (
                <Field label="Integration key" hint="A service's Events API v2 integration key (32 characters)."><Input required value={f.routingKey} onChange={(e) => setF({ ...f, routingKey: e.target.value })} autoComplete="off" /></Field>
              ) : (
                <Field label="URL" hint={f.kind === "webhook" ? "https only. Each request is signed; the secret is shown once after you add the channel." : f.kind === "teams_webhook" ? "From a Teams workflow: Post to a channel when a webhook request is received." : "https://hooks.slack.com/services/…"}>
                  <Input required type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://…" />
                </Field>
              )}
            </motion.div>
          </AnimatePresence>

          <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
            <div>
              <div className="mb-1.5 text-[13px] font-medium text-mist">Send when</div>
              <div className="space-y-1.5">{EVENTS.map(([k, label]) => <label key={k} className="flex items-center gap-2 text-[13.5px]"><input type="checkbox" checked={f.events.includes(k)} onChange={(e) => setF({ ...f, events: e.target.checked ? [...f.events, k] : f.events.filter((x) => x !== k) })} /> {label}</label>)}</div>
            </div>
            <Field label="Waiting sessions" hint="Use a delay for an escalation channel.">
              <Select value={f.delaySeconds} onChange={(e) => setF({ ...f, delaySeconds: Number(e.target.value) })}>{DELAYS.map(([s, l]) => <option key={s} value={s}>{l}</option>)}</Select>
            </Field>
          </div>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Add channel</Button></div>
        </form>
      </Modal>

      <Modal open={!!secret} onClose={() => setSecret(null)} title="Webhook signing secret">
        <p className="text-[13.5px] text-mist">Every request carries <span className="font-mono text-[12px]">X-Tessera-Signature: t=…,v1=…</span>, an HMAC-SHA256 of <span className="font-mono text-[12px]">"&lt;t&gt;.&lt;body&gt;"</span> with this secret. Store it now; Tessera will not show it again.</p>
        <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-ink p-3 font-mono text-[12.5px] text-teal-300">{secret}</pre>
        <div className="mt-4 flex justify-end gap-2">{secret ? <CopyButton text={secret} label="Copy secret" /> : null}<Button variant="primary" onClick={() => setSecret(null)}>Done</Button></div>
      </Modal>
    </div>
  );
}
