import { Copy, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { Button, Field, Input, Panel, Select, Spinner, useToast } from "../../components/ui";
import { api, ApiError } from "../../lib/api";

interface Settings {
  redirectUri: string;
  canEdit: boolean;
  config: { enabled: boolean; issuer: string; clientId: string; hasSecret: boolean; jitProvisioning: boolean; defaultRole: string; enforce: boolean } | null;
  domains: string[];
}

const PROVIDERS: { name: string; issuer: string; note: string }[] = [
  { name: "Okta", issuer: "https://YOUR-ORG.okta.com", note: "Applications → Create App Integration → OIDC, Web Application. Use the org authorization server's issuer." },
  { name: "Microsoft Entra ID", issuer: "https://login.microsoftonline.com/TENANT-ID/v2.0", note: "App registrations → New registration, Web platform. Create a client secret under Certificates & secrets." },
  { name: "Google Workspace", issuer: "https://accounts.google.com", note: "Google Cloud console → APIs & Services → Credentials → OAuth client ID, Web application. Set the consent screen to Internal." },
];

export function Sso() {
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [f, setF] = useState({ enabled: false, issuer: "", clientId: "", clientSecret: "", jitProvisioning: true, defaultRole: "operator", enforce: false });
  const [domains, setDomains] = useState<string[]>([]);
  const [domainInput, setDomainInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await api.get<Settings>("/api/admin/sso");
    setS(r);
    setDomains(r.domains);
    if (r.config) setF({ ...r.config, clientSecret: "" });
  }, []);
  useEffect(() => void load(), [load]);

  const addDomain = () => {
    const d = domainInput.trim().toLowerCase().replace(/^@/, "");
    if (d && !domains.includes(d)) setDomains([...domains, d]);
    setDomainInput("");
  };
  const onDomainKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === " ") {
      e.preventDefault();
      addDomain();
    }
  };

  const runTest = async () => {
    setBusy("test");
    setTest(null);
    try {
      const r = await api.post<{ issuer: string; authorizationEndpoint: string }>("/api/admin/sso/test", { issuer: f.issuer });
      setTest({ ok: true, text: `Found ${r.issuer}. Sign-in goes to ${new URL(r.authorizationEndpoint).host}.` });
    } catch (e) {
      setTest({ ok: false, text: e instanceof ApiError ? e.message : "Could not reach the provider." });
    }
    setBusy(null);
  };

  const save = async () => {
    setBusy("save");
    try {
      await api.put("/api/admin/sso", { ...f, clientSecret: f.clientSecret || undefined, domains: domainInput.trim() ? [...domains, domainInput.trim().toLowerCase()] : domains });
      setDomainInput("");
      toast(f.enabled ? "Single sign-on saved and on." : "Single sign-on saved; it is off until you turn it on.");
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not save.", "error");
    }
    setBusy(null);
  };

  if (!s) return <div className="flex h-64 items-center justify-center"><Spinner /></div>;
  const ro = !s.canEdit;

  return (
    <div className="mx-auto max-w-3xl p-5">
      <h1 className="font-display text-[26px] font-semibold tracking-tight">Single sign-on</h1>
      <p className="mt-1 text-[14px] text-fog">People sign in through your identity provider with OpenID Connect. Works with Okta, Microsoft Entra ID, Google Workspace and any OIDC provider.</p>
      {ro ? <p className="mt-3 rounded-lg border border-line-2 bg-slate-2 px-3 py-2 text-[13px] text-mist">Only an owner can change these settings.</p> : null}

      <Panel title="1 · Register Tessera with your provider" className="mt-5">
        <p className="text-[13.5px] text-mist">Create a web application in your provider and set this as its sign-in redirect URI:</p>
        <div className="mt-2 flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-lg border border-line bg-ink px-3 py-2 font-mono text-[12.5px] text-teal-300">{s.redirectUri}</code>
          <Button size="sm" onClick={() => void navigator.clipboard.writeText(s.redirectUri).then(() => toast("Copied."))}><Copy size={14} /> Copy</Button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {PROVIDERS.map((p) => (
            <button key={p.name} disabled={ro} onClick={() => setF({ ...f, issuer: f.issuer || p.issuer })} className="rounded-lg border border-line bg-ink-2 p-3 text-left hover:border-line-2 disabled:cursor-default">
              <div className="text-[13.5px] font-medium text-snow">{p.name}</div>
              <div className="mt-1 text-[12px] leading-snug text-fog">{p.note}</div>
            </button>
          ))}
        </div>
        <p className="mt-3 text-[12.5px] text-fog">Ask for the scopes <span className="font-mono">openid email profile</span>. Tessera uses the authorization code flow with PKCE.</p>
      </Panel>

      <Panel title="2 · Connect" className="mt-4">
        <div className="space-y-4">
          <Field label="Issuer URL" hint="The provider's issuer; Tessera reads its /.well-known/openid-configuration.">
            <div className="flex gap-2">
              <Input disabled={ro} value={f.issuer} onChange={(e) => { setF({ ...f, issuer: e.target.value }); setTest(null); }} placeholder="https://your-org.okta.com" />
              <Button disabled={ro || !f.issuer} loading={busy === "test"} onClick={() => void runTest()}>Test</Button>
            </div>
          </Field>
          {test ? <p className={`-mt-2 text-[12.5px] ${test.ok ? "text-teal-300" : "text-rose-400"}`}>{test.text}</p> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Client ID"><Input disabled={ro} value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} /></Field>
            <Field label="Client secret" hint={s.config?.hasSecret ? "Stored encrypted. Leave empty to keep it." : "Stored encrypted; never shown again."}>
              <Input disabled={ro} type="password" autoComplete="off" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} placeholder={s.config?.hasSecret ? "••••••••" : ""} />
            </Field>
          </div>
          <Field label="Email domains" hint="People whose email ends in one of these are sent to your provider. A domain can belong to one organisation; public ones like gmail.com cannot be used.">
            <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-line-2 bg-ink-2 px-2 py-1.5 focus-within:border-teal-400">
              {domains.map((d) => (
                <span key={d} className="inline-flex items-center gap-1 rounded-md bg-slate-3 px-2 py-0.5 text-[12.5px] text-snow">
                  {d}
                  {!ro ? <button onClick={() => setDomains(domains.filter((x) => x !== d))} className="text-fog hover:text-rose-400" aria-label={`Remove ${d}`}>×</button> : null}
                </span>
              ))}
              <input disabled={ro} value={domainInput} onChange={(e) => setDomainInput(e.target.value)} onKeyDown={onDomainKey} onBlur={addDomain} placeholder={domains.length ? "" : "acme.com"} className="min-w-[8rem] flex-1 bg-transparent px-1 text-[14px] text-snow placeholder:text-ash focus:outline-none" />
            </div>
          </Field>
        </div>
      </Panel>

      <Panel title="3 · Access" className="mt-4">
        <div className="space-y-4 text-[13.5px]">
          <label className="flex items-start gap-2.5"><input disabled={ro} type="checkbox" checked={f.jitProvisioning} onChange={(e) => setF({ ...f, jitProvisioning: e.target.checked })} className="mt-1" />
            <span><span className="font-medium text-snow">Create accounts on first sign-in</span><br /><span className="text-fog">Anyone your provider lets in, with an email on your domains, gets a Tessera account. Off: only people you invite can sign in.</span></span>
          </label>
          <Field label="Role for new accounts">
            <Select disabled={ro || !f.jitProvisioning} value={f.defaultRole} onChange={(e) => setF({ ...f, defaultRole: e.target.value })} className="max-w-xs">
              <option value="viewer">viewer</option><option value="operator">operator</option><option value="approver">approver</option><option value="admin">admin</option>
            </Select>
          </Field>
          <label className="flex items-start gap-2.5"><input disabled={ro || !f.enabled} type="checkbox" checked={f.enforce} onChange={(e) => setF({ ...f, enforce: e.target.checked })} className="mt-1" />
            <span><span className="font-medium text-snow">Require single sign-on</span><br /><span className="text-fog">Members can no longer sign in with a password. Owners keep their password so you can always get back in if the provider is down.</span></span>
          </label>
        </div>
      </Panel>

      {!ro ? (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[14px]">
            <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked, enforce: e.target.checked && f.enforce })} />
            <ShieldCheck size={16} className={f.enabled ? "text-teal-400" : "text-fog"} />
            <span className={f.enabled ? "text-snow" : "text-fog"}>Single sign-on is {f.enabled ? "on" : "off"}</span>
          </label>
          <Button variant="primary" className="ml-auto" loading={busy === "save"} disabled={!f.issuer || !f.clientId || (!f.clientSecret && !s.config?.hasSecret)} onClick={() => void save()}>Save</Button>
        </div>
      ) : null}
    </div>
  );
}
