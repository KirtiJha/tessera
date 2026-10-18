import type { PolicyRule } from "@tessera/contract";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowUp, ChevronDown, FlaskConical, History, Pencil, Plus, ShieldAlert, ShieldCheck, ShieldX, Trash2, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Empty, Field, Input, Modal, Panel, Select, TagInput, Textarea, useToast } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { ago } from "../../lib/format";

type Effect = PolicyRule["effect"];
type Rule = PolicyRule;
interface Version { version: number; createdAt: string; createdBy: string; note: string | null; rules: number }
interface Hit { ruleId: string; effect: string; enforced: boolean; count: number; last: string }
interface PolicyData { version: number; rules: Rule[]; updatedAt: string | null; updatedBy: string | null; versions: Version[]; hits: Hit[] }
interface Decision { id: number; sessionId: string; tool: string; summary: string | null; ruleId: string; ruleName: string; effect: Effect; enforced: boolean; version: number; createdAt: string; userName: string | null }
interface Verdict { decision: Effect; rule: { id: string; name: string; effect: Effect; reason: string } | null; dryRun: { id: string; name: string; effect: Effect }[] }
interface Team { id: string; name: string }

const EFFECT: Record<Effect, { label: string; verb: string; icon: LucideIcon; pill: string; card: string; help: string }> = {
  deny: { label: "Deny", verb: "Denied", icon: ShieldX, pill: "bg-rose-600/20 text-rose-400", card: "border-rose-600/50 bg-rose-600/10", help: "Refuse the call. The engineer sees the reason in the terminal." },
  ask: { label: "Ask", verb: "Needs approval", icon: ShieldAlert, pill: "bg-amber-400/15 text-amber-400", card: "border-amber-400/50 bg-amber-400/10", help: "Stop and ask. The prompt shows on the wall and in Slack, where an approver can allow it." },
  allow: { label: "Allow", verb: "Allowed", icon: ShieldCheck, pill: "bg-teal-700/40 text-teal-300", card: "border-teal-700 bg-teal-700/15", help: "Let it through without checking the rules below. Use it to carve an exception above a broader rule." },
};

const TOOLS = ["Bash", "Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "mcp__*"];

const newId = () => Math.random().toString(36).slice(2, 10);
const emptyMatch = (): Rule["match"] => ({ tools: [], commands: [], paths: [], urls: [], models: [], repos: [], branches: [], teams: [] });

const TEMPLATES: { title: string; blurb: string; rule: Omit<Rule, "id"> }[] = [
  { title: "Ask before Terraform changes", blurb: "apply and destroy wait for a reviewer", rule: { name: "Terraform changes need a reviewer", effect: "ask", mode: "enforce", enabled: true, reason: "Infrastructure changes are reviewed before they run.", match: { ...emptyMatch(), tools: ["Bash"], commands: ["terraform apply*", "terraform destroy*"] } } },
  { title: "Block secrets files", blurb: ".env, keys and certificates", rule: { name: "No secrets files", effect: "deny", mode: "enforce", enabled: true, reason: "Secrets stay in the vault. Ask the platform team for access.", match: { ...emptyMatch(), tools: ["Read", "Edit", "MultiEdit", "Write"], paths: ["**/.env", "**/.env.*", "**/*.pem", "**/id_rsa*"] } } },
  { title: "Ask before pushing to main", blurb: "git push on main or master", rule: { name: "Pushes to main need approval", effect: "ask", mode: "enforce", enabled: true, reason: "Open a pull request instead, or get an approver to allow this push.", match: { ...emptyMatch(), tools: ["Bash"], commands: ["git push*"], branches: ["main", "master"] } } },
  { title: "Block destructive shell commands", blurb: "rm -rf on /, home, disks", rule: { name: "No destructive shell commands", effect: "deny", mode: "enforce", enabled: true, reason: "This command can destroy data outside the project.", match: { ...emptyMatch(), tools: ["Bash"], commands: ["rm -rf /*", "rm -rf ~*", "*mkfs*", "dd *of=/dev/*"] } } },
  { title: "Ask before production MCP tools", blurb: "any MCP server named prod", rule: { name: "Production tools need approval", effect: "ask", mode: "enforce", enabled: true, reason: "Production systems are touched only with a second pair of eyes.", match: { ...emptyMatch(), tools: ["mcp__*prod*"] } } },
  { title: "Watch web access (dry run)", blurb: "see who fetches what before blocking", rule: { name: "Web access (trial)", effect: "deny", mode: "dry_run", enabled: true, reason: "", match: { ...emptyMatch(), tools: ["WebFetch", "WebSearch"] } } },
];

function summarise(m: Rule["match"], teams: Team[]): string[] {
  const out: string[] = [];
  if (m.tools.length) out.push(m.tools.join(", "));
  for (const c of m.commands) out.push(`$ ${c}`);
  for (const p of m.paths) out.push(p);
  for (const u of m.urls) out.push(u);
  if (m.models.length) out.push(`model ${m.models.join(", ")}`);
  if (m.repos.length) out.push(`repo ${m.repos.join(", ")}`);
  if (m.branches.length) out.push(`branch ${m.branches.join(", ")}`);
  if (m.teams.length) out.push(`team ${m.teams.map((t) => teams.find((x) => x.id === t)?.name ?? "?").join(", ")}`);
  return out;
}

function EffectPill({ effect, dry }: { effect: Effect; dry?: boolean }) {
  const e = EFFECT[effect];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${e.pill}`}>
      <e.icon size={12} /> {e.label}
      {dry ? <span className="font-normal opacity-80">· dry run</span> : null}
    </span>
  );
}

// ---- rule editor ------------------------------------------------------------------
function RuleEditor({ rule, teams, onSave, onClose }: { rule: Rule; teams: Team[]; onSave: (r: Rule) => void; onClose: () => void }) {
  const [r, setR] = useState(rule);
  const m = r.match;
  const set = (k: keyof Rule["match"], v: string[]) => setR({ ...r, match: { ...m, [k]: v } });
  const hasCondition = Object.values(m).some((v) => v.length);
  return (
    <div className="space-y-4">
      <Field label="Name"><Input autoFocus value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="Terraform changes need a reviewer" /></Field>
      <div>
        <div className="mb-1.5 text-[13px] font-medium text-mist">When it matches</div>
        <div className="grid gap-2 sm:grid-cols-3">
          {(["deny", "ask", "allow"] as Effect[]).map((e) => {
            const x = EFFECT[e];
            return (
              <button key={e} type="button" onClick={() => setR({ ...r, effect: e })} aria-pressed={r.effect === e} className={`rounded-xl border p-3 text-left transition-colors ${r.effect === e ? x.card : "border-line-2 hover:bg-slate-2"}`}>
                <span className="flex items-center gap-1.5 text-[13.5px] font-semibold text-snow"><x.icon size={15} /> {x.label}</span>
                <span className="mt-1 block text-[11.5px] leading-snug text-fog">{x.help}</span>
              </button>
            );
          })}
        </div>
      </div>
      <Field label="Reason" hint="Shown to the engineer in their terminal and to whoever approves."><Textarea rows={2} maxLength={400} value={r.reason} onChange={(e) => setR({ ...r, reason: e.target.value })} placeholder="Infrastructure changes are reviewed before they run." /></Field>

      <div className="rounded-xl border border-line bg-ink-2/60 p-3">
        <div className="mb-2 text-[13px] font-medium text-mist">Matches a tool call when all of these hold <span className="font-normal text-fog">(leave a line empty to not care)</span></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tools" hint="Bash, Edit, mcp__github__*"><TagInput id="tools" value={m.tools} onChange={(v) => set("tools", v)} placeholder="Bash" suggestions={TOOLS} /></Field>
          <Field label="Commands" hint='Shell globs: "terraform apply*", "*rm -rf*"'><TagInput value={m.commands} onChange={(v) => set("commands", v)} placeholder="terraform apply*" /></Field>
          <Field label="Paths" hint="**/.env, infra/prod/** (relative to the session)"><TagInput value={m.paths} onChange={(v) => set("paths", v)} placeholder="**/.env" /></Field>
          <Field label="URLs" hint="https://*.internal.example.com/**"><TagInput value={m.urls} onChange={(v) => set("urls", v)} placeholder="https://**" /></Field>
          <Field label="Repositories" hint="acme/payments, acme/*"><TagInput value={m.repos} onChange={(v) => set("repos", v)} placeholder="acme/*" /></Field>
          <Field label="Branches" hint="main, release/*"><TagInput value={m.branches} onChange={(v) => set("branches", v)} placeholder="main" /></Field>
          <Field label="Models" hint="claude-opus-*"><TagInput value={m.models} onChange={(v) => set("models", v)} placeholder="claude-opus-*" /></Field>
          <Field label="Teams" hint="Sessions of people in these teams">
            <Select value="" onChange={(e) => e.target.value && set("teams", [...new Set([...m.teams, e.target.value])])}>
              <option value="">{m.teams.length ? m.teams.map((t) => teams.find((x) => x.id === t)?.name ?? "?").join(", ") : "Everyone"}</option>
              {teams.filter((t) => !m.teams.includes(t.id)).map((t) => <option key={t.id} value={t.id}>Add {t.name}</option>)}
            </Select>
            {m.teams.length ? <button type="button" onClick={() => set("teams", [])} className="mt-1 text-[12px] text-fog hover:text-snow">Clear teams</button> : null}
          </Field>
        </div>
        {!hasCondition ? <p className="mt-2 text-[12px] text-amber-400">Add at least one condition; a rule cannot match every tool call.</p> : null}
      </div>

      <label className="flex items-start gap-2.5 rounded-xl border border-line-2 p-3 text-[13px]">
        <input type="checkbox" className="mt-0.5" checked={r.mode === "dry_run"} onChange={(e) => setR({ ...r, mode: e.target.checked ? "dry_run" : "enforce" })} />
        <span><span className="font-medium text-snow">Dry run</span><span className="block text-[12px] text-fog">Record what this rule would have done and let the call through. Use it to see a rule's reach before you enforce it.</span></span>
      </label>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!r.name.trim() || !hasCondition} onClick={() => onSave({ ...r, name: r.name.trim(), reason: r.reason.trim() })}>Done</Button>
      </div>
    </div>
  );
}

// ---- tester -------------------------------------------------------------------------
function Tester({ rules }: { rules: Rule[] }) {
  const [call, setCall] = useState({ tool: "Bash", value: "terraform apply -auto-approve", branch: "", repo: "" });
  const [v, setV] = useState<Verdict | null>(null);
  const kind = call.tool === "Bash" ? "command" : ["WebFetch"].includes(call.tool) ? "url" : ["Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "Glob", "Grep"].includes(call.tool) ? "path" : null;
  useEffect(() => {
    const t = setTimeout(() => {
      const c: Record<string, string> = { tool: call.tool || "Bash" };
      if (kind && call.value) c[kind] = call.value;
      if (kind === "path") c.cwd = "/repo";
      if (call.branch) c.branch = call.branch;
      if (call.repo) c.repo = call.repo;
      void api.post<Verdict>("/api/admin/policy/test", { rules, call: c }).then(setV).catch(() => setV(null));
    }, 200);
    return () => clearTimeout(t);
  }, [rules, call, kind]);
  const e = v ? EFFECT[v.decision] : null;
  return (
    <Panel title="Try a tool call">
      <div className="space-y-3">
        <div className="grid grid-cols-[120px_1fr] gap-2">
          <Select aria-label="Tool" value={TOOLS.includes(call.tool) ? call.tool : "other"} onChange={(ev) => setCall({ ...call, tool: ev.target.value === "other" ? "" : ev.target.value, value: "" })}>
            {TOOLS.filter((t) => t !== "mcp__*").map((t) => <option key={t}>{t}</option>)}
            <option value="other">Other…</option>
          </Select>
          {TOOLS.includes(call.tool) ? (
            <Input aria-label="Command, path or URL" className="font-mono text-[12.5px]" disabled={!kind} value={call.value} onChange={(ev) => setCall({ ...call, value: ev.target.value })} placeholder={kind === "command" ? "git push origin main" : kind === "path" ? "/repo/.env" : kind === "url" ? "https://…" : "no arguments"} />
          ) : (
            <Input aria-label="Tool name" className="font-mono text-[12.5px]" value={call.tool} onChange={(ev) => setCall({ ...call, tool: ev.target.value })} placeholder="mcp__prod_db__query" />
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Input aria-label="Branch" className="h-9 text-[12.5px]" value={call.branch} onChange={(ev) => setCall({ ...call, branch: ev.target.value })} placeholder="branch (optional)" />
          <Input aria-label="Repository" className="h-9 text-[12.5px]" value={call.repo} onChange={(ev) => setCall({ ...call, repo: ev.target.value })} placeholder="repo (optional)" />
        </div>
        {kind === "path" ? <p className="text-[11.5px] text-fog">Paths are tested as if the session runs in /repo.</p> : null}
        <AnimatePresence mode="wait">
          {v && e ? (
            <motion.div key={`${v.decision}-${v.rule?.id ?? "none"}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className={`rounded-xl border p-3 ${e.card}`} aria-live="polite">
              <div className="flex items-center gap-2 text-[15px] font-semibold text-snow"><e.icon size={17} /> {e.verb}</div>
              <div className="mt-1 text-[12.5px] text-mist">{v.rule ? <>by <span className="font-medium text-snow">{v.rule.name}</span>{v.rule.reason ? ` — ${v.rule.reason}` : ""}</> : "No rule matches; calls are allowed by default."}</div>
              {v.dryRun.length ? <div className="mt-2 flex items-center gap-1.5 text-[12px] text-fog"><FlaskConical size={13} /> Dry run: {v.dryRun.map((d) => `${d.name} would ${d.effect}`).join("; ")}</div> : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
        <p className="text-[11.5px] text-fog">Tests the rules as they are on this page, saved or not.</p>
      </div>
    </Panel>
  );
}

// ---- page -----------------------------------------------------------------------------
export function Policies() {
  const toast = useToast();
  const [data, setData] = useState<PolicyData | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [base, setBase] = useState(0);
  const [restoredFrom, setRestoredFrom] = useState<number | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [templates, setTemplates] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [p, d, t] = await Promise.all([api.get<PolicyData>("/api/admin/policy"), api.get<{ decisions: Decision[] }>("/api/admin/policy/decisions?limit=30"), api.get<{ teams: Team[] }>("/api/admin/teams")]);
    setData(p);
    setRules(p.rules);
    setBase(p.version);
    setRestoredFrom(null);
    setDecisions(d.decisions);
    setTeams(t.teams);
  }, []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!templates) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setTemplates(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [templates]);

  const dirty = useMemo(() => data !== null && JSON.stringify(rules) !== JSON.stringify(data.rules), [rules, data]);
  const hitsFor = (id: string) => data?.hits.filter((h) => h.ruleId === id).reduce((n, h) => n + h.count, 0) ?? 0;

  const upsert = (r: Rule) => {
    setRules((rs) => (rs.some((x) => x.id === r.id) ? rs.map((x) => (x.id === r.id ? r : x)) : [...rs, r]));
    setEditing(null);
  };
  const move = (i: number, d: -1 | 1) => setRules((rs) => {
    const next = [...rs];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    return next;
  });
  const patch = (id: string, p: Partial<Rule>) => setRules((rs) => rs.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put<{ version: number }>("/api/admin/policy", { rules, baseVersion: base, note: note.trim() || (restoredFrom ? `Restored version ${restoredFrom}` : undefined) });
      toast(`Version ${r.version} is in force.`);
      setNote("");
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not save the policy.", "error");
    } finally {
      setSaving(false);
    }
  };
  const restore = async (v: number) => {
    const r = await api.get<{ rules: Rule[] }>(`/api/admin/policy/versions/${v}`);
    setRules(r.rules);
    setRestoredFrom(v);
    toast(`Version ${v} loaded. Save to put it back in force.`, "info");
  };

  if (!data) return null;
  return (
    <div className="mx-auto max-w-6xl p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-semibold tracking-tight">Policies</h1>
          <p className="mt-1 max-w-2xl text-[14px] text-fog">Rules checked before every tool call on every enrolled machine. The first rule that matches decides; a call no rule matches goes ahead.</p>
        </div>
        <div className="text-right text-[12.5px] text-fog">
          {data.version ? <>Version {data.version} in force · {data.updatedBy}, {ago(data.updatedAt!)}</> : "No policy yet"}
        </div>
      </div>

      <AnimatePresence>
        {dirty ? (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="sticky top-2 z-20 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-400/40 bg-[#231d10]/95 px-4 py-3 shadow-lg backdrop-blur">
            <span className="text-[13px] text-amber-400">{restoredFrom ? `Version ${restoredFrom} loaded — not in force until you save.` : "Unsaved changes — not in force until you save."}</span>
            <Input aria-label="What changed" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed (optional)" className="h-9 max-w-xs flex-1 text-[13px]" />
            <div className="ml-auto flex gap-2">
              <Button size="sm" onClick={() => { setRules(data.rules); setRestoredFrom(null); }}>Discard</Button>
              <Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>Save as version {data.version + 1}</Button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-4">
          <Panel
            title="Rules"
            action={
              <div className="flex gap-2" ref={menuRef}>
                <div className="relative">
                  <Button size="sm" onClick={() => setTemplates((t) => !t)} aria-expanded={templates}>Templates <ChevronDown size={14} /></Button>
                  <AnimatePresence>
                    {templates ? (
                      <motion.ul initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.12 }} className="absolute right-0 z-30 mt-1 w-72 overflow-hidden rounded-xl border border-line-2 bg-slate-1 py-1 shadow-2xl">
                        {TEMPLATES.map((t) => (
                          <li key={t.title}>
                            <button className="w-full px-3 py-2 text-left hover:bg-slate-2" onClick={() => { setTemplates(false); setEditing({ ...t.rule, id: newId(), match: { ...t.rule.match } }); }}>
                              <span className="flex items-center gap-2 text-[13px] font-medium text-snow"><EffectPill effect={t.rule.effect} dry={t.rule.mode === "dry_run"} /> {t.title}</span>
                              <span className="mt-0.5 block text-[11.5px] text-fog">{t.blurb}</span>
                            </button>
                          </li>
                        ))}
                      </motion.ul>
                    ) : null}
                  </AnimatePresence>
                </div>
                <Button size="sm" variant="primary" onClick={() => setEditing({ id: newId(), name: "", effect: "deny", mode: "enforce", enabled: true, reason: "", match: emptyMatch() })}><Plus size={14} /> Add a rule</Button>
              </div>
            }
          >
            {rules.length === 0 ? (
              <Empty title="No rules" body="Every tool call goes ahead. Start from a template, such as asking before Terraform applies or blocking .env files, and run it as a dry run first to see who it would affect." />
            ) : (
              <ol className="space-y-2">
                <AnimatePresence initial={false}>
                  {rules.map((r, i) => {
                    const hits = hitsFor(r.id);
                    return (
                      <motion.li key={r.id} layout initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: 0.18 }} className={`group flex gap-3 rounded-xl border border-line bg-ink-2/50 p-3 ${r.enabled ? "" : "opacity-55"}`}>
                        <div className="flex w-6 flex-col items-center pt-0.5 text-[12px] tabular-nums text-ash">
                          {i + 1}
                          <button disabled={i === 0} onClick={() => move(i, -1)} className="mt-1 rounded p-0.5 text-fog hover:bg-slate-3 hover:text-snow disabled:invisible" aria-label={`Move ${r.name} up`}><ArrowUp size={13} /></button>
                          <button disabled={i === rules.length - 1} onClick={() => move(i, 1)} className="rounded p-0.5 text-fog hover:bg-slate-3 hover:text-snow disabled:invisible" aria-label={`Move ${r.name} down`}><ArrowDown size={13} /></button>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <EffectPill effect={r.effect} dry={r.mode === "dry_run"} />
                            <span className="text-[14px] font-medium text-snow">{r.name}</span>
                            {hits ? <span className="text-[11.5px] text-fog">{hits} {r.mode === "dry_run" ? "would-be" : r.effect === "ask" ? "approval" : "denial"}{hits === 1 ? "" : "s"} this week</span> : null}
                          </div>
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {summarise(r.match, teams).map((s) => <span key={s} className="rounded bg-slate-3 px-1.5 py-0.5 font-mono text-[11.5px] text-mist">{s}</span>)}
                          </div>
                          {r.reason ? <p className="mt-1.5 text-[12.5px] text-fog">“{r.reason}”</p> : null}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-2">
                          <div className="flex items-center gap-1">
                            <button onClick={() => setEditing(r)} className="rounded-md p-1.5 text-fog hover:bg-slate-3 hover:text-snow" aria-label={`Edit ${r.name}`}><Pencil size={14} /></button>
                            <button onClick={() => setRules((rs) => rs.filter((x) => x.id !== r.id))} className="rounded-md p-1.5 text-fog hover:bg-slate-3 hover:text-rose-400" aria-label={`Delete ${r.name}`}><Trash2 size={14} /></button>
                          </div>
                          <div className="flex rounded-lg border border-line-2 p-0.5 text-[11.5px]" role="group" aria-label="Mode">
                            {(["enforce", "dry_run"] as const).map((m) => <button key={m} onClick={() => patch(r.id, { mode: m })} aria-pressed={r.mode === m} className={`rounded-md px-2 py-0.5 ${r.mode === m ? "bg-slate-3 text-snow" : "text-fog hover:text-snow"}`}>{m === "enforce" ? "Enforce" : "Dry run"}</button>)}
                          </div>
                          <label className="flex items-center gap-1.5 text-[12px] text-fog"><input type="checkbox" checked={r.enabled} onChange={(e) => patch(r.id, { enabled: e.target.checked })} /> on</label>
                        </div>
                      </motion.li>
                    );
                  })}
                </AnimatePresence>
              </ol>
            )}
          </Panel>

          <Panel title="Recent decisions">
            {decisions.length === 0 ? (
              <p className="text-[13px] text-fog">Nothing denied, sent for approval or caught by a dry run yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {decisions.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[12.5px]">
                    <span className="w-20 shrink-0 text-fog">{ago(d.createdAt)}</span>
                    <EffectPill effect={d.effect} dry={!d.enforced} />
                    <span className="text-snow">{d.userName ?? "someone"}</span>
                    <Link to={`/app/sessions/${encodeURIComponent(d.sessionId)}`} className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-mist hover:text-teal-300" title={d.summary ?? d.tool}>{d.summary ?? d.tool}</Link>
                    <span className="text-fog">{d.ruleName}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <Tester rules={rules} />
          <Panel title={<span className="flex items-center gap-1.5"><History size={14} /> Versions</span>}>
            {data.versions.length === 0 ? (
              <p className="text-[13px] text-fog">Each save becomes a version you can return to.</p>
            ) : (
              <ul className="space-y-2">
                {data.versions.slice(0, 12).map((v) => (
                  <li key={v.version} className="flex items-start gap-2 text-[12.5px]">
                    <span className={`mt-0.5 rounded px-1.5 font-mono text-[11px] ${v.version === data.version ? "bg-teal-700/40 text-teal-300" : "bg-slate-3 text-mist"}`}>v{v.version}</span>
                    <span className="min-w-0 flex-1">
                      <span className="text-snow">{v.note ?? `${v.rules} rule${v.rules === 1 ? "" : "s"}`}</span>
                      <span className="block text-[11.5px] text-fog">{v.createdBy}, {ago(v.createdAt)}</span>
                    </span>
                    {v.version !== data.version ? <button onClick={() => void restore(v.version)} className="text-[12px] text-teal-300 hover:underline">Restore</button> : <span className="text-[11.5px] text-fog">in force</span>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <p className="px-1 text-[11.5px] leading-relaxed text-fog">Rules guard against mistakes; they are not a sandbox. A determined script can phrase a command a rule does not expect, so keep real secrets out of reach as well. If a machine cannot reach Tessera, its tool calls go ahead.</p>
        </div>
      </div>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing && rules.some((r) => r.id === editing.id) ? "Edit rule" : "New rule"} width={720}>
        {editing ? <RuleEditor key={editing.id} rule={editing} teams={teams} onSave={upsert} onClose={() => setEditing(null)} /> : null}
      </Modal>
    </div>
  );
}
