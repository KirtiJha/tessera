import { Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Empty, Field, Input, Modal, Panel, Select, useConfirm, useToast } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { fmtUsd } from "../../lib/format";

interface Budget { id: string; scopeType: "org" | "team" | "user"; scopeId: string | null; window: "daily" | "weekly" | "monthly"; softUsd: number | null; hardUsd: number | null; enforce: boolean; spentUsd: number; level: "ok" | "soft" | "hard"; windowStart: string }
interface Team { id: string; name: string }
interface User { id: string; name: string }

export function Budgets() {
  const toast = useToast();
  const confirm = useConfirm();
  const [budgets, setBudgets] = useState<Budget[] | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ scopeType: "org", scopeId: "", window: "monthly", softUsd: "", hardUsd: "", enforce: false });

  const load = useCallback(async () => {
    const [b, t, u] = await Promise.all([api.get<{ budgets: Budget[] }>("/api/admin/budgets"), api.get<{ teams: Team[] }>("/api/admin/teams"), api.get<{ users: User[] }>("/api/admin/users")]);
    setBudgets(b.budgets);
    setTeams(t.teams);
    setUsers(u.users);
  }, []);
  useEffect(() => void load(), [load]);

  const name = (b: Budget) => (b.scopeType === "org" ? "Whole organisation" : b.scopeType === "team" ? `Team: ${teams.find((t) => t.id === b.scopeId)?.name ?? "?"}` : `Person: ${users.find((u) => u.id === b.scopeId)?.name ?? "?"}`);

  const save = async () => {
    try {
      await api.put("/api/admin/budgets", { scopeType: f.scopeType, scopeId: f.scopeId || null, window: f.window, softUsd: f.softUsd ? Number(f.softUsd) : null, hardUsd: f.hardUsd ? Number(f.hardUsd) : null, enforce: f.enforce });
      setOpen(false);
      toast("Budget saved.");
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not save.", "error");
    }
  };

  return (
    <div className="mx-auto max-w-4xl p-3 sm:p-5">
      <h1 className="font-display text-[26px] font-semibold tracking-tight">Budgets</h1>
      <p className="mt-1 text-[14px] text-fog">Soft limits notify. Hard limits with enforcement deny every new tool call in the sessions they cover until the window resets.</p>
      <Panel title="Limits" className="mt-5" action={<Button size="sm" variant="primary" onClick={() => setOpen(true)}><Plus size={14} /> Add a budget</Button>}>
        {!budgets ? null : budgets.length === 0 ? (
          <Empty title="No budgets" body="Add a daily, weekly or monthly limit for the organisation, a team or a person." />
        ) : (
          <div className="space-y-3">
            {budgets.map((b) => {
              const limit = b.hardUsd ?? b.softUsd ?? 0;
              const pct = limit ? Math.min(100, (b.spentUsd / limit) * 100) : 0;
              const color = b.level === "hard" ? "bg-rose-400" : b.level === "soft" ? "bg-amber-400" : "bg-teal-400";
              return (
                <div key={b.id} className="rounded-lg border border-line bg-ink-2 p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[14px] font-medium text-snow">{name(b)} <span className="text-fog">· {b.window}</span></div>
                    <div className="flex items-center gap-3 text-[12.5px] text-mist">
                      <span>{fmtUsd(b.spentUsd)} spent</span>
                      {b.softUsd !== null ? <span>soft {fmtUsd(b.softUsd)}</span> : null}
                      {b.hardUsd !== null ? <span>hard {fmtUsd(b.hardUsd)}{b.enforce ? " · enforced" : ""}</span> : null}
                      <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${b.level === "hard" ? "bg-rose-600/30 text-rose-400" : b.level === "soft" ? "bg-amber-400/15 text-amber-400" : "bg-teal-700/40 text-teal-300"}`}>{b.level === "ok" ? "within budget" : `${b.level} limit reached`}</span>
                      <button onClick={() => void confirm({ title: "Delete this budget?", body: "Spending against it stops being watched or enforced.", action: "Delete", tone: "danger" }).then((ok) => { if (ok) void api.del(`/api/admin/budgets/${b.id}`).then(load); })} className="text-fog hover:text-rose-400">Delete</button>
                    </div>
                  </div>
                  <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-slate-3"><div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} /></div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
      <Modal open={open} onClose={() => setOpen(false)} title="Add a budget">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Applies to"><Select value={f.scopeType} onChange={(e) => setF({ ...f, scopeType: e.target.value, scopeId: "" })}><option value="org">Whole organisation</option><option value="team">A team</option><option value="user">A person</option></Select></Field>
            {f.scopeType !== "org" ? (
              <Field label={f.scopeType === "team" ? "Team" : "Person"}><Select value={f.scopeId} onChange={(e) => setF({ ...f, scopeId: e.target.value })}><option value="">Choose…</option>{(f.scopeType === "team" ? teams : users).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
            ) : <Field label="Window"><Select value={f.window} onChange={(e) => setF({ ...f, window: e.target.value })}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></Select></Field>}
          </div>
          {f.scopeType !== "org" ? <Field label="Window"><Select value={f.window} onChange={(e) => setF({ ...f, window: e.target.value })}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></Select></Field> : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Soft limit (USD)" hint="Notifies when reached."><Input type="number" min={0} step="0.01" value={f.softUsd} onChange={(e) => setF({ ...f, softUsd: e.target.value })} /></Field>
            <Field label="Hard limit (USD)" hint="Can stop sessions."><Input type="number" min={0} step="0.01" value={f.hardUsd} onChange={(e) => setF({ ...f, hardUsd: e.target.value })} /></Field>
          </div>
          <label className="flex items-start gap-2.5 text-[13.5px]"><input type="checkbox" checked={f.enforce} onChange={(e) => setF({ ...f, enforce: e.target.checked })} className="mt-1" /><span><span className="font-medium text-snow">Enforce the hard limit</span><br /><span className="text-fog">Deny new tool calls in covered sessions once the hard limit is reached. Engineers see the reason in their terminal.</span></span></label>
          <div className="flex justify-end gap-2"><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={(f.scopeType !== "org" && !f.scopeId) || (!f.softUsd && !f.hardUsd)} onClick={() => void save()}>Save budget</Button></div>
        </div>
      </Modal>
    </div>
  );
}
