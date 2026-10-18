import { Check, Copy, KeyRound, Plus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, Empty, Field, Input, Modal, Panel, Select, useToast } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { ago, fmtDate } from "../../lib/format";

interface Key { id: string; name: string; prefix: string; scopes: string[]; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null; owner: string; mine: boolean }
interface ScopeInfo { scope: string; allowed: boolean; minRole: string }

const SCOPE_HELP: Record<string, string> = {
  "fleet:read": "Read live sessions, history, timelines and the stream",
  "sessions:act": "Answer, message, pause, stop and hand over sessions you may act on",
  "analytics:read": "Read spend and download chargeback (admins)",
  "audit:read": "Read and verify the audit log",
  "policy:read": "Read and test the tool-call policy",
  "policy:write": "Save new policy versions (policy as code)",
};

function Copyable({ text, mono = true }: { text: string; mono?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="group relative">
      <pre className={`overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-ink p-3 pr-12 text-[12.5px] text-teal-300 ${mono ? "font-mono" : ""}`}>{text}</pre>
      <button onClick={() => void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })} className="absolute right-2 top-2 rounded-md p-1.5 text-fog hover:bg-slate-2 hover:text-snow" aria-label="Copy">
        {done ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/** Keys for the API and the CLI. A key acts as its maker, limited to the scopes chosen. */
export function ApiKeys() {
  const toast = useToast();
  const { me } = useAuth();
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [scopes, setScopes] = useState<ScopeInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", scopes: ["fleet:read"], expiresInDays: "90" });
  const [token, setToken] = useState<string | null>(null);
  const isAdmin = me?.user.role === "admin" || me?.user.role === "owner";
  const origin = window.location.origin;

  const load = useCallback(() => api.get<{ keys: Key[]; scopes: ScopeInfo[] }>("/api/keys").then((r) => { setKeys(r.keys); setScopes(r.scopes); }), []);
  useEffect(() => void load(), [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.post<{ token: string }>("/api/keys", { name: f.name, scopes: f.scopes, expiresInDays: f.expiresInDays === "never" ? null : Number(f.expiresInDays) });
      setOpen(false);
      setToken(r.token);
      setF({ name: "", scopes: ["fleet:read"], expiresInDays: "90" });
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not create the key.", "error");
    }
  };
  const revoke = async (k: Key) => {
    if (!confirm(`Revoke "${k.name}"? Anything using it stops working at once.`)) return;
    await api.del(`/api/keys/${k.id}`);
    toast("Key revoked.");
    await load();
  };

  const active = keys?.filter((k) => !k.revokedAt) ?? [];
  const revoked = keys?.filter((k) => k.revokedAt) ?? [];

  return (
    <div className="mx-auto max-w-4xl p-3 sm:p-5">
      <h1 className="font-display text-[26px] font-semibold tracking-tight">API keys</h1>
      <p className="mt-1 text-[14px] text-fog">For scripts, CI and the <span className="font-mono text-[13px]">tessera</span> command line. A key acts as the person who made it, with their current role, limited to the scopes you pick. {isAdmin ? "As an admin you see, and can revoke, every key in the organisation." : ""}</p>

      <Panel title="Keys" className="mt-5" action={<Button size="sm" variant="primary" onClick={() => setOpen(true)}><Plus size={14} /> Create a key</Button>}>
        {!keys ? null : active.length === 0 ? (
          <Empty title="No keys yet" body="Create one to use the API or the CLI: watch the fleet from a terminal, answer prompts, export chargeback, or apply policy from Git." />
        ) : (
          <ul className="divide-y divide-line">
            {active.map((k) => {
              const expired = k.expiresAt && Date.parse(k.expiresAt) < Date.now();
              return (
                <li key={k.id} className="flex flex-wrap items-center gap-3 py-3 text-[13px]">
                  <KeyRound size={16} className="text-fog" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-snow">{k.name} <span className="ml-1 font-mono text-[11.5px] text-fog">{k.prefix}…</span>{isAdmin && !k.mine ? <span className="ml-2 text-[12px] font-normal text-fog">{k.owner}</span> : null}</div>
                    <div className="mt-1 flex flex-wrap gap-1">{k.scopes.map((s) => <span key={s} className="rounded bg-slate-3 px-1.5 py-0.5 font-mono text-[11px] text-mist">{s}</span>)}</div>
                    <div className="mt-1 text-[12px] text-fog">
                      created {fmtDate(k.createdAt)} · {k.lastUsedAt ? `last used ${ago(k.lastUsedAt)}` : "never used"} · {k.expiresAt ? <span className={expired ? "text-rose-400" : ""}>{expired ? "expired" : "expires"} {fmtDate(k.expiresAt)}</span> : "does not expire"}
                    </div>
                  </div>
                  <button onClick={() => void revoke(k)} className="text-fog hover:text-rose-400">Revoke</button>
                </li>
              );
            })}
          </ul>
        )}
        {revoked.length ? <p className="mt-3 text-[12px] text-fog">{revoked.length} revoked key{revoked.length === 1 ? "" : "s"} not shown.</p> : null}
      </Panel>

      <Panel title="Use it" className="mt-4">
        <div className="space-y-3 text-[13px] text-mist">
          <p>Install the CLI from this server and log in:</p>
          <Copyable text={`npx -y --package=${origin}/downloads/tessera-cli.tgz tessera login --server ${origin}`} />
          <p>Then, for example: <span className="font-mono text-[12.5px] text-snow">tessera sessions --waiting</span>, <span className="font-mono text-[12.5px] text-snow">tessera watch</span>, <span className="font-mono text-[12.5px] text-snow">tessera allow &lt;session&gt;</span>, <span className="font-mono text-[12.5px] text-snow">tessera policy apply policy.json</span>, <span className="font-mono text-[12.5px] text-snow">tessera export --by cost_center</span>. In CI, set <span className="font-mono text-[12.5px]">TESSERA_URL</span> and <span className="font-mono text-[12.5px]">TESSERA_API_KEY</span> instead of logging in.</p>
          <p>Or call the API directly. The reference is at <a className="text-teal-300 hover:underline" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">/api/v1/openapi.json</a> (OpenAPI 3.1).</p>
          <Copyable text={`curl -H "Authorization: Bearer $TESSERA_API_KEY" ${origin}/api/v1/fleet/state`} />
        </div>
      </Panel>

      <Modal open={open} onClose={() => setOpen(false)} title="Create an API key" width={560}>
        <form onSubmit={create} className="space-y-4">
          <Field label="Name" hint="Where it is used, so you know what breaks if you revoke it."><Input required maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="policy-gitops in CI" /></Field>
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-mist">Scopes</div>
            <div className="space-y-1.5">
              {scopes.map((s) => (
                <label key={s.scope} className={`flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-[13px] ${s.allowed ? "hover:bg-slate-2" : "opacity-50"}`} title={s.allowed ? undefined : `Needs the ${s.minRole} role`}>
                  <input type="checkbox" className="mt-0.5" disabled={!s.allowed} checked={f.scopes.includes(s.scope)} onChange={(e) => setF({ ...f, scopes: e.target.checked ? [...f.scopes, s.scope] : f.scopes.filter((x) => x !== s.scope) })} />
                  <span><span className="font-mono text-[12.5px] text-snow">{s.scope}</span><span className="block text-[12px] text-fog">{SCOPE_HELP[s.scope]}{s.allowed ? "" : ` · needs ${s.minRole}`}</span></span>
                </label>
              ))}
            </div>
          </div>
          <Field label="Expires">
            <Select value={f.expiresInDays} onChange={(e) => setF({ ...f, expiresInDays: e.target.value })}>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
              <option value="never">Never</option>
            </Select>
          </Field>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" variant="primary" disabled={!f.name.trim() || !f.scopes.length}>Create key</Button></div>
        </form>
      </Modal>

      <Modal open={!!token} onClose={() => setToken(null)} title="Your new key" width={560}>
        <p className="text-[13.5px] text-mist">Copy it now. Tessera stores only a hash and will not show it again.</p>
        <div className="mt-3"><Copyable text={token ?? ""} /></div>
        <div className="mt-4 flex justify-end"><Button variant="primary" onClick={() => setToken(null)}>Done</Button></div>
      </Modal>
    </div>
  );
}
