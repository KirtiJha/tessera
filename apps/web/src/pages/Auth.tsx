import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Lockup } from "../components/Logo";
import { Button, Field, Input } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ThemeScope } from "../lib/theme";

function Frame({ title, lead, children, foot }: { title: string; lead?: string; children?: React.ReactNode; foot?: React.ReactNode }) {
  return (
    <ThemeScope>
      <div className="flex min-h-full items-center justify-center bg-ink px-4 py-12">
        <div className="w-full max-w-[420px]">
          <Link to="/" className="inline-flex"><Lockup size={30} textClass="text-[24px]" /></Link>
          <h1 className="mt-8 font-display text-[30px] font-semibold tracking-[-0.03em]">{title}</h1>
          {lead ? <p className="mt-2 text-[14.5px] leading-relaxed text-fog">{lead}</p> : null}
          <div className="mt-7">{children}</div>
          {foot ? <div className="mt-6 text-[14px] text-fog">{foot}</div> : null}
        </div>
      </div>
    </ThemeScope>
  );
}

function ssoStartUrl(email: string, returnTo: string): string {
  return `/api/auth/sso/start?email=${encodeURIComponent(email)}&returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * Email first. If the email's domain signs in through the organisation's
 * identity provider, offer (or, when the organisation requires it, go straight
 * to) single sign-on; otherwise ask for the password.
 */
export function SignIn() {
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const { refresh } = useAuth();
  const returnTo = (loc.state as { from?: string } | null)?.from ?? "/app";
  const [step, setStep] = useState<"email" | "password">("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sso, setSso] = useState<{ orgName: string; enforced: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(params.get("sso_error"));
  const [busy, setBusy] = useState(false);

  const goSso = () => {
    setBusy(true);
    window.location.assign(ssoStartUrl(email, returnTo));
  };

  const next = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const d = await api.get<{ sso: boolean; orgName?: string; enforced?: boolean }>(`/api/auth/sso/discover?email=${encodeURIComponent(email)}`);
      if (d.sso && d.enforced) {
        window.location.assign(ssoStartUrl(email, returnTo));
        return;
      }
      setSso(d.sso ? { orgName: d.orgName ?? "your organisation", enforced: false } : null);
      setStep("password");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not continue.");
    }
    setBusy(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.post("/api/auth/signin", { email, password });
      await refresh();
      nav(returnTo);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame title="Sign in" foot={<>New here? <Link to="/signup" className="text-teal-400 hover:underline">Create an organisation</Link></>}>
      {step === "email" ? (
        <form onSubmit={next} className="space-y-4">
          <Field label="Work email" error={err}><Input type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Continue</Button>
        </form>
      ) : (
        <div className="space-y-4">
          <button onClick={() => { setStep("email"); setErr(null); }} className="text-[13.5px] text-fog hover:text-snow">{email} · <span className="text-teal-400">change</span></button>
          {sso ? (
            <>
              <Button variant="primary" size="lg" className="w-full" loading={busy} onClick={goSso}>Sign in with {sso.orgName} SSO</Button>
              <div className="flex items-center gap-3 text-[12px] text-ash"><span className="h-px flex-1 bg-line" />or use your password<span className="h-px flex-1 bg-line" /></div>
            </>
          ) : null}
          <form onSubmit={submit} className="space-y-4">
            <Field label="Password" error={err}><Input type="password" autoComplete="current-password" autoFocus={!sso} required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            <Button type="submit" variant={sso ? "secondary" : "primary"} size="lg" className="w-full" loading={busy && !sso}>Sign in</Button>
          </form>
        </div>
      )}
    </Frame>
  );
}

export function SignUp() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [f, setF] = useState({ orgName: "", name: "", email: "", password: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.post("/api/auth/signup", f);
      await refresh();
      nav("/app/devices?welcome=1");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not create the organisation.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title="Create your organisation" lead="You become its owner. Invite your team from the console afterwards." foot={<>Already have an account? <Link to="/signin" className="text-teal-400 hover:underline">Sign in</Link></>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Organisation name"><Input required minLength={2} value={f.orgName} onChange={(e) => setF({ ...f, orgName: e.target.value })} placeholder="Acme Robotics" /></Field>
        <Field label="Your name"><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" /></Field>
        <Field label="Work email"><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" /></Field>
        <Field label="Password" hint="At least 10 characters." error={err}><Input type="password" required minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Create organisation</Button>
      </form>
    </Frame>
  );
}

export function Invite() {
  const { token = "" } = useParams();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [info, setInfo] = useState<{ email: string; name: string; org: string; ssoRequired?: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<{ email: string; name: string; org: string; ssoRequired?: boolean }>(`/api/auth/invite/${token}`).then((i) => {
      setInfo(i);
      setName(i.name);
    }).catch((e) => setErr(e instanceof ApiError ? e.message : "This invitation is not valid."));
  }, [token]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/api/auth/invite/${token}/accept`, { name, password });
      await refresh();
      nav("/app/devices?welcome=1");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not accept the invitation.");
    } finally {
      setBusy(false);
    }
  };
  if (err && !info) return <Frame title="Invitation not valid" lead={err} />;
  if (!info) return <Frame title="Loading your invitation" />;
  if (info.ssoRequired) {
    return (
      <Frame title={`Join ${info.org}`} lead={`You were invited as ${info.email}. ${info.org} signs in through its identity provider; signing in finishes joining.`}>
        <Button variant="primary" size="lg" className="w-full" onClick={() => window.location.assign(ssoStartUrl(info.email, "/app/devices?welcome=1"))}>Sign in with {info.org} SSO</Button>
      </Frame>
    );
  }
  return (
    <Frame title={`Join ${info.org}`} lead={`You were invited as ${info.email}. Choose a password to finish.`}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Your name"><Input required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Password" hint="At least 10 characters." error={err}><Input type="password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Join {info.org}</Button>
      </form>
    </Frame>
  );
}
