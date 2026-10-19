import { BadgeCheck, CircleDashed, Copy, RefreshCw, ShieldCheck, UsersRound } from "lucide-react";
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { Button, Field, Input, Modal, Panel, Select, Spinner, useConfirm, useToast } from "../../components/ui";
import { ago } from "../../lib/format";
import { api, ApiError } from "../../lib/api";

interface Settings {
  redirectUri: string;
  canEdit: boolean;
  config: { enabled: boolean; issuer: string; clientId: string; hasSecret: boolean; jitProvisioning: boolean; defaultRole: string; enforce: boolean } | null;
  domains: { domain: string; verified: boolean; verifiedAt: string | null; record: { name: string; type: string; value: string } | null }[];
  scim: { baseUrl: string; token: { prefix: string; createdAt: string; lastUsedAt: string | null } | null };
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className="grid grid-cols-[70px_1fr_auto] items-center gap-2 text-[12.5px]">
      <span className="text-fog">{label}</span>
      <code className="overflow-x-auto whitespace-nowrap rounded-md border border-line bg-ink px-2 py-1.5 font-mono text-teal-300">{value}</code>
      <button onClick={() => void navigator.clipboard.writeText(value).then(() => toast("Copied."))} className="rounded-md p-1.5 text-fog hover:bg-slate-2 hover:text-snow" aria-label={`Copy ${label}`}><Copy size={14} /></button>
    </div>
  );
}

const PROVIDERS: { name: string; issuer: string; note: string }[] = [
  { name: "Okta", issuer: "https://YOUR-ORG.okta.com", note: "Applications → Create App Integration → OIDC, Web Application. Use the org authorization server's issuer." },
  { name: "Microsoft Entra ID", issuer: "https://login.microsoftonline.com/TENANT-ID/v2.0", note: "App registrations → New registration, Web platform. Create a client secret under Certificates & secrets." },
  { name: "Google Workspace", issuer: "https://accounts.google.com", note: "Google Cloud console → APIs & Services → Credentials → OAuth client ID, Web application. Set the consent screen to Internal." },
];

export function Sso() {
  const toast = useToast();
  const confirm = useConfirm();
  const [s, setS] = useState<Settings | null>(null);
  const [f, setF] = useState({ enabled: false, issuer: "", clientId: "", clientSecret: "", jitProvisioning: true, defaultRole: "operator", enforce: false });
  const [domains, setDomains] = useState<string[]>([]);
  const [domainInput, setDomainInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [scimToken, setScimToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.get<Settings>("/api/admin/sso");
    setS(r);
    setDomains(r.domains.map((d) => d.domain));
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

  const verify = async (domain: string) => {
    setBusy(`verify:${domain}`);
    try {
      await api.post(`/api/admin/sso/domains/${encodeURIComponent(domain)}/verify`);
      toast(`${domain} is verified. Sign-ins for it now go to your provider.`);
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not verify.", "error");
    }
    setBusy(null);
  };
  const newScimToken = async () => {
    if (s?.scim.token && !(await confirm({ title: "Make a new SCIM token?", body: "The current one stops working at once, so update your identity provider straight after.", action: "Make a new token" }))) return;
    setBusy("scim");
    try {
      const r = await api.post<{ token: string }>("/api/admin/sso/scim/token");
      setScimToken(r.token);
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not make a token.", "error");
    }
    setBusy(null);
  };

  if (!s) return <div className="flex h-64 items-center justify-center"><Spinner /></div>;
  const status = new Map(s.domains.map((d) => [d.domain, d]));
  const ro = !s.canEdit;

  return (
    <div className="mx-auto max-w-3xl p-3 sm:p-5">
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
          <Field label="Email domains" hint="People whose email ends in one of these are sent to your provider once you verify the domain below. Public ones like gmail.com cannot be used.">
            <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-line-2 bg-ink-2 px-2 py-1.5 focus-within:border-teal-400">
              {domains.map((d) => (
                <span key={d} className="inline-flex items-center gap-1 rounded-md bg-slate-3 px-2 py-0.5 text-[12.5px] text-snow" title={status.get(d)?.verified ? "Verified" : status.has(d) ? "Not verified yet" : "Not saved yet"}>
                  {status.get(d)?.verified ? <BadgeCheck size={13} className="text-teal-300" /> : <CircleDashed size={13} className="text-amber-400" />}
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
      {s.domains.length ? (
        <Panel title="4 · Prove you own each domain" className="mt-4">
          <p className="text-[13.5px] text-mist">Add a TXT record to each domain's DNS. Until a domain is verified, sign-ins for it are not sent to your provider and no accounts are created for it. Another organisation can only claim a domain by verifying it first.</p>
          <ul className="mt-3 space-y-3">
            {s.domains.map((d) => (
              <li key={d.domain} className="rounded-xl border border-line bg-ink-2/60 p-3">
                <div className="flex items-center gap-2 text-[13.5px]">
                  {d.verified ? <BadgeCheck size={16} className="text-teal-300" /> : <CircleDashed size={16} className="text-amber-400" />}
                  <span className="font-medium text-snow">{d.domain}</span>
                  <span className={`text-[12px] ${d.verified ? "text-teal-300" : "text-amber-400"}`}>{d.verified ? `verified ${d.verifiedAt ? ago(d.verifiedAt) : ""}` : "not verified"}</span>
                  {!d.verified && !ro ? <Button size="sm" className="ml-auto" loading={busy === `verify:${d.domain}`} onClick={() => void verify(d.domain)}>Check DNS</Button> : null}
                </div>
                {!d.verified && d.record ? (
                  <div className="mt-2.5 space-y-1.5">
                    <CopyLine label="Name" value={d.record.name} />
                    <CopyLine label="Type" value={d.record.type} />
                    <CopyLine label="Value" value={d.record.value} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel title={<span className="flex items-center gap-1.5"><UsersRound size={15} /> Provisioning with SCIM</span>} className="mt-4">
        <p className="text-[13.5px] text-mist">Let your provider create people, keep their names and teams in step, and switch them off the moment they leave. Groups you push become teams. Roles stay a Tessera decision, and owners cannot be switched off from the provider.</p>
        <div className="mt-3 space-y-1.5">
          <CopyLine label="Base URL" value={s.scim.baseUrl} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[12.5px]">
          {s.scim.token ? <span className="text-mist">Token <span className="font-mono text-snow">{s.scim.token.prefix}…</span> made {ago(s.scim.token.createdAt)} · {s.scim.token.lastUsedAt ? `last used ${ago(s.scim.token.lastUsedAt)}` : "not used yet"}</span> : <span className="text-fog">No token yet.</span>}
          {!ro ? (
            <span className="ml-auto flex gap-2">
              {s.scim.token ? <Button size="sm" onClick={() => void confirm({ title: "Revoke the SCIM token?", body: "Provisioning stops until you make a new one.", action: "Revoke", tone: "danger" }).then((ok) => { if (ok) void api.del("/api/admin/sso/scim/token").then(load); })}>Revoke</Button> : null}
              <Button size="sm" variant={s.scim.token ? "secondary" : "primary"} loading={busy === "scim"} onClick={() => void newScimToken()}>{s.scim.token ? <><RefreshCw size={13} /> Rotate</> : "Make a token"}</Button>
            </span>
          ) : null}
        </div>
        <p className="mt-3 text-[12px] text-fog">Okta: Applications → your app → Provisioning → SCIM, authentication "HTTP Header". Entra ID: Enterprise applications → your app → Provisioning → Automatic, Tenant URL and Secret token.</p>
      </Panel>

      <Modal open={!!scimToken} onClose={() => setScimToken(null)} title="SCIM token">
        <p className="text-[13.5px] text-mist">Paste it into your identity provider now. Tessera stores only a hash and will not show it again.</p>
        <div className="mt-3"><CopyLine label="Token" value={scimToken ?? ""} /></div>
        <div className="mt-4 flex justify-end"><Button variant="primary" onClick={() => setScimToken(null)}>Done</Button></div>
      </Modal>

    </div>
  );
}
