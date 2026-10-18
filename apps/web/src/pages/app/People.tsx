import { Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Field, Input, Modal, Panel, Select, useToast } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { ago } from "../../lib/format";

interface User { id: string; email: string; name: string; role: string; status: string; teamId: string | null; teamName: string | null; lastLoginAt: string | null; devices: number; ssoLinked: boolean }
interface Team { id: string; name: string; members: number }

const ROLES = ["viewer", "operator", "approver", "admin", "owner"] as const;
const ROLE_HELP: Record<string, string> = {
  viewer: "Can watch the wall and read history.",
  operator: "Can also answer and control their own sessions.",
  approver: "Can also act on any session in their team.",
  admin: "Can act on any session and manage people, budgets, prices and notifications.",
  owner: "Everything, including other owners.",
};

export function People() {
  const toast = useToast();
  const { me } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [invite, setInvite] = useState(false);
  const [f, setF] = useState({ email: "", name: "", role: "operator", teamId: "" });
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [teamName, setTeamName] = useState("");

  const load = useCallback(async () => {
    const [u, t] = await Promise.all([api.get<{ users: User[] }>("/api/admin/users"), api.get<{ teams: Team[] }>("/api/admin/teams")]);
    setUsers(u.users);
    setTeams(t.teams);
  }, []);
  useEffect(() => void load(), [load]);

  const sendInvite = async () => {
    try {
      const r = await api.post<{ inviteUrl: string }>("/api/admin/users/invite", { ...f, teamId: f.teamId || null });
      setInviteUrl(r.inviteUrl);
      setF({ email: "", name: "", role: "operator", teamId: "" });
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not invite.", "error");
    }
  };
  const update = async (u: User, patch: Record<string, unknown>) => {
    try {
      await api.patch(`/api/admin/users/${u.id}`, patch);
      await load();
      toast("Saved.");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not save.", "error");
    }
  };
  const addTeam = async () => {
    try {
      await api.post("/api/admin/teams", { name: teamName });
      setTeamName("");
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not add the team.", "error");
    }
  };

  return (
    <div className="mx-auto max-w-5xl p-3 sm:p-5">
      <h1 className="font-display text-[26px] font-semibold tracking-tight">People and teams</h1>
      <p className="mt-1 text-[14px] text-fog">Who can see the wall, who can act on which sessions, and how sessions group.</p>

      <Panel title="People" className="mt-5" action={<Button size="sm" variant="primary" onClick={() => setInvite(true)}><Plus size={14} /> Invite</Button>}>
        <div className="-mx-1 overflow-x-auto px-1"><table className="w-full min-w-[560px] text-[13px]">
          <thead className="text-left text-[11.5px] text-fog"><tr><th className="pb-2 font-medium">Name</th><th className="pb-2 font-medium">Role</th><th className="pb-2 font-medium">Team</th><th className="pb-2 font-medium">Devices</th><th className="pb-2 font-medium">Last sign-in</th><th className="pb-2 font-medium">Status</th></tr></thead>
          <tbody className="divide-y divide-line">
            {users.map((u) => (
              <tr key={u.id} className={u.status === "disabled" ? "text-ash" : "text-mist"}>
                <td className="py-2.5">
                  <div className="font-medium text-snow">{u.name}{u.id === me?.user.id ? <span className="ml-1.5 text-[11px] text-fog">(you)</span> : null}{u.ssoLinked ? <span className="ml-2 rounded bg-teal-700/40 px-1.5 py-0.5 text-[10.5px] font-medium text-teal-300" title="Signs in through your identity provider">SSO</span> : null}</div>
                  <div className="text-[11.5px] text-fog">{u.email}{u.ssoLinked && me?.user.role === "owner" ? <button onClick={() => { if (confirm(`Unlink ${u.name} from their identity at your provider? Their next SSO sign-in links whichever identity your provider sends for ${u.email}.`)) void api.post(`/api/admin/sso/users/${u.id}/unlink`).then(() => { toast("Unlinked."); return load(); }); }} className="ml-2 text-fog underline-offset-2 hover:text-rose-400 hover:underline">Unlink SSO</button> : null}</div>
                </td>
                <td className="py-2.5">
                  <select value={u.role} disabled={u.id === me?.user.id || (u.role === "owner" && me?.user.role !== "owner")} onChange={(e) => void update(u, { role: e.target.value })} className="rounded-md border border-line-2 bg-ink-2 px-2 py-1 text-[12.5px] text-snow disabled:opacity-60" title={ROLE_HELP[u.role]}>
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </td>
                <td className="py-2.5">
                  <select value={u.teamId ?? ""} onChange={(e) => void update(u, { teamId: e.target.value || null })} className="rounded-md border border-line-2 bg-ink-2 px-2 py-1 text-[12.5px] text-snow">
                    <option value="">No team</option>
                    {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </td>
                <td className="py-2.5">{u.devices}</td>
                <td className="py-2.5">{u.lastLoginAt ? ago(u.lastLoginAt) : u.status === "invited" ? "invited" : "never"}</td>
                <td className="py-2.5">
                  {u.id === me?.user.id ? <span className="text-fog">active</span> : u.status === "disabled" ? <button onClick={() => void update(u, { status: "active" })} className="text-teal-300 hover:underline">Enable</button> : <button onClick={() => void update(u, { status: "disabled" })} className="text-fog hover:text-rose-400">Disable</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <div className="mt-4 grid gap-1.5 text-[12px] text-fog sm:grid-cols-2">
          {ROLES.map((r) => <div key={r}><span className="font-medium text-mist">{r}</span> — {ROLE_HELP[r]}</div>)}
        </div>
      </Panel>

      <Panel title="Teams" className="mt-4">
        <div className="flex flex-wrap gap-2">
          {teams.map((t) => (
            <span key={t.id} className="inline-flex items-center gap-2 rounded-lg border border-line-2 bg-slate-2 px-3 py-1.5 text-[13px]">
              {t.name} <span className="text-fog">{t.members}</span>
              <button onClick={() => { if (confirm(`Delete team "${t.name}"? Members keep their accounts.`)) void api.del(`/api/admin/teams/${t.id}`).then(load); }} className="text-fog hover:text-rose-400" aria-label={`Delete ${t.name}`}>×</button>
            </span>
          ))}
          <form onSubmit={(e) => { e.preventDefault(); void addTeam(); }} className="flex gap-2">
            <Input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="New team name" className="h-9 w-48" />
            <Button size="sm" type="submit" disabled={!teamName.trim()}>Add team</Button>
          </form>
        </div>
        <p className="mt-3 text-[12.5px] text-fog">Approvers can act on sessions owned by anyone in their team. Budgets can be set per team.</p>
      </Panel>

      <Modal open={invite} onClose={() => { setInvite(false); setInviteUrl(null); }} title="Invite someone">
        {inviteUrl ? (
          <>
            <p className="text-[13.5px] text-mist">Send them this link. It works once and signs them in after they choose a password.</p>
            <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-ink p-3 font-mono text-[12px] text-teal-300">{inviteUrl}</pre>
            <div className="mt-4 flex justify-end gap-2"><Button onClick={() => void navigator.clipboard.writeText(inviteUrl).then(() => toast("Copied."))}>Copy link</Button><Button variant="primary" onClick={() => { setInvite(false); setInviteUrl(null); }}>Done</Button></div>
          </>
        ) : (
          <div className="space-y-4">
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Role" hint={ROLE_HELP[f.role]}><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.filter((r) => r !== "owner" || me?.user.role === "owner").map((r) => <option key={r} value={r}>{r}</option>)}</Select></Field>
            <Field label="Team"><Select value={f.teamId} onChange={(e) => setF({ ...f, teamId: e.target.value })}><option value="">No team</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
            <div className="flex justify-end gap-2"><Button onClick={() => setInvite(false)}>Cancel</Button><Button variant="primary" disabled={!f.name.trim() || !f.email.trim()} onClick={() => void sendInvite()}>Create invitation</Button></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
