import { Copy, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, Empty, Field, Input, Modal, Panel, useToast } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { ago, fmtDate } from "../../lib/format";

interface Device { id: string; label: string; hostname: string | null; machineId: string | null; createdAt: string; lastSeenAt: string | null; revokedAt: string | null; userName: string; userId: string }

function Code({ children }: { children: string }) {
  const toast = useToast();
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-lg border border-line bg-ink p-3 pr-10 font-mono text-[12.5px] leading-relaxed text-teal-300">{children}</pre>
      <button onClick={() => void navigator.clipboard.writeText(children).then(() => toast("Copied."))} className="absolute right-2 top-2 rounded-md p-1.5 text-fog hover:bg-slate-2 hover:text-snow" aria-label="Copy"><Copy size={14} /></button>
    </div>
  );
}

export function Devices() {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [params] = useSearchParams();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [enrol, setEnrol] = useState<{ code: string; serverUrl: string; expiresAt: number } | null>(null);
  const [tokenModal, setTokenModal] = useState<{ label: string; token: string } | null>(null);
  const [label, setLabel] = useState("");
  const [open, setOpen] = useState(false);
  const welcome = params.get("welcome") === "1";

  const load = useCallback(() => api.get<{ devices: Device[] }>("/api/admin/devices").then((r) => setDevices(r.devices)), []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!enrol) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [enrol, load]);

  const newCode = async () => {
    const r = await api.post<{ code: string; serverUrl: string; expiresInSeconds: number }>("/api/admin/devices/enrolment-code");
    setEnrol({ code: r.code, serverUrl: r.serverUrl, expiresAt: Date.now() + r.expiresInSeconds * 1000 });
  };
  const issue = async () => {
    try {
      const r = await api.post<{ token: string }>("/api/admin/devices", { label });
      setTokenModal({ label, token: r.token });
      setOpen(false);
      setLabel("");
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not issue a token.", "error");
    }
  };
  const revoke = async (d: Device) => {
    if (!confirm(`Revoke "${d.label}"? Its reporter will stop being accepted at once.`)) return;
    await api.post(`/api/admin/devices/${d.id}/revoke`);
    toast("Revoked.");
    await load();
  };

  const origin = enrol?.serverUrl ?? window.location.origin;
  const [os, setOs] = useState<"mac" | "win">(() => (/windows/i.test(navigator.userAgent) ? "win" : "mac"));
  const code = enrol?.code ?? "<code>";
  const oneLiner = os === "win" ? `$env:TESSERA_CODE = "${code}"; irm ${origin}/install.ps1 | iex` : `curl -fsSL ${origin}/install.sh | sh -s -- --code ${code}`;

  return (
    <div className="mx-auto max-w-4xl p-3 sm:p-5">
      <h1 className="font-display text-[26px] font-semibold tracking-tight">Devices</h1>
      <p className="mt-1 text-[14px] text-fog">Each machine that reports to Tessera has its own token, bound to you. Revoke one and its reporter stops at once.</p>

      {welcome && (!devices || devices.length === 0) ? (
        <div className="mt-5 rounded-xl border border-teal-700 bg-teal-600/10 p-5">
          <div className="text-[16px] font-semibold text-teal-300">Welcome. Let's get your first session on the wall.</div>
          <p className="mt-1 text-[13.5px] text-mist">Get a code, paste one line on the machine you run Claude Code on, start a session. About a minute.</p>
        </div>
      ) : null}

      <Panel title="Enrol a machine" className="mt-5" action={<Button size="sm" variant="primary" onClick={() => void newCode()}>{enrol ? "New code" : "Get an enrolment code"}</Button>}>
        <ol className="space-y-4 text-[13.5px] text-mist">
          <li>
            <div className="mb-1.5 font-medium text-snow">1 · Get a one-time code</div>
            {enrol ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 font-mono text-[18px] font-semibold tracking-[0.12em] text-amber-400">{enrol.code}</span>
                <span className="text-[12px] text-fog">expires in {Math.max(0, Math.round((enrol.expiresAt - Date.now()) / 60000))} min · works once · this page updates when the machine appears below</span>
              </div>
            ) : (
              <p className="text-fog">Click <span className="text-snow">Get an enrolment code</span>. It is valid for 15 minutes and works once.</p>
            )}
          </li>
          <li>
            <div className="mb-1.5 flex flex-wrap items-center gap-2 font-medium text-snow">
              2 · Paste one line in a terminal on the machine
              <span className="ml-auto flex items-center gap-1 rounded-lg border border-line bg-slate-1 p-0.5 text-[12px] font-normal">
                <button onClick={() => setOs("mac")} className={`rounded-md px-2 py-0.5 ${os === "mac" ? "bg-slate-3 text-snow" : "text-fog hover:text-snow"}`}>macOS / Linux</button>
                <button onClick={() => setOs("win")} className={`rounded-md px-2 py-0.5 ${os === "win" ? "bg-slate-3 text-snow" : "text-fog hover:text-snow"}`}>Windows</button>
              </span>
            </div>
            <Code>{oneLiner}</Code>
            <p className="mt-1.5 text-[12.5px] text-fog">
              {os === "win" ? "In PowerShell. " : "In Terminal. "}
              Downloads the reporter from this server into <span className="font-mono">~/.tessera</span>, enrols the machine, adds Tessera's hooks to Claude Code's <span className="font-mono">~/.claude/settings.json</span> without touching anything else there, and checks the result. If Node 20+ is not installed, a private copy goes into <span className="font-mono">~/.tessera/node</span>; nothing else on the machine changes.
            </p>
          </li>
          <li>
            <div className="mb-1.5 font-medium text-snow">3 · Start a Claude Code session</div>
            <p className="text-fog">It appears on the live wall within two seconds of its first prompt. If it does not, the installer's last lines say what to fix; run <span className="font-mono">doctor</span> again any time with the command the installer printed at the end.</p>
          </li>
        </ol>
        <details className="mt-4 text-[12.5px] text-fog">
          <summary className="cursor-pointer text-mist">By hand, without the script</summary>
          <p className="mt-2">With Node 20+ installed: <span className="font-mono">npx -y --package={origin}/downloads/tessera-reporter.tgz tessera-reporter enrol --server {origin} --code {code}</span>, then the same command ending in <span className="font-mono">install</span>. To remove the hooks later, run it with <span className="font-mono">uninstall</span>. Scripts: <a className="text-teal-300 hover:underline" href={`${origin}/install.sh`}>install.sh</a> · <a className="text-teal-300 hover:underline" href={`${origin}/install.ps1`}>install.ps1</a>.</p>
        </details>
      </Panel>

      <Panel title="Other agent runtimes" className="mt-4">
        <p className="text-[13px] text-mist">Any runtime that exports OpenTelemetry traces with the GenAI conventions (Codex CLI, Gemini CLI, agents built on an SDK) shows up on the wall with no Tessera code on the machine: agents, tokens per model, failed tool calls. Issue a token by hand below for the machine, then set:</p>
        <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-ink p-3 font-mono text-[12px] leading-relaxed text-teal-300">{`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${window.location.origin}/api/ingest/otlp/v1/traces
OTEL_EXPORTER_OTLP_PROTOCOL=http/json
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer tsr_…"
OTEL_RESOURCE_ATTRIBUTES="session.id=$(uuidgen)"   # optional; else each trace is a session`}</pre>
        <p className="mt-2 text-[12px] text-fog">Spans named by gen_ai.operation.name: invoke_agent becomes an agent, chat carries gen_ai.usage.* tokens, execute_tool counts tool calls. vcs.repository.url.full and vcs.ref.head.name fill the repository and branch. Approving from Tessera needs a first-party reporter; traces are watch-only.</p>
      </Panel>

      <Panel title={isAdmin ? "All devices" : "Your devices"} className="mt-4" action={<Button size="sm" onClick={() => setOpen(true)}><Plus size={14} /> Issue a token by hand</Button>}>
        {!devices ? null : devices.length === 0 ? (
          <Empty title="No devices yet" body="Enrol a machine above. It shows up here the moment it exchanges its code." />
        ) : (
          <table className="w-full text-[13px]">
            <thead className="text-left text-[11.5px] text-fog">
              <tr><th className="pb-2 font-medium">Label</th><th className="pb-2 font-medium">Machine</th>{isAdmin ? <th className="pb-2 font-medium">Person</th> : null}<th className="pb-2 font-medium">Last report</th><th className="pb-2 font-medium">Enrolled</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {devices.map((d) => (
                <tr key={d.id} className={d.revokedAt ? "text-ash" : "text-mist"}>
                  <td className="py-2.5 font-medium text-snow">{d.label}{d.revokedAt ? <span className="ml-2 rounded bg-slate-3 px-1.5 text-[10.5px] text-fog">revoked</span> : null}</td>
                  <td className="py-2.5 font-mono text-[12px]">{d.hostname ?? "—"}</td>
                  {isAdmin ? <td className="py-2.5">{d.userName}</td> : null}
                  <td className="py-2.5">{d.lastSeenAt ? ago(d.lastSeenAt) : "never"}</td>
                  <td className="py-2.5">{fmtDate(d.createdAt)}</td>
                  <td className="py-2.5 text-right">{d.revokedAt ? null : <button onClick={() => void revoke(d)} className="text-[12.5px] text-fog hover:text-rose-400">Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Modal open={open} onClose={() => setOpen(false)} title="Issue a device token">
        <p className="mb-4 text-[13.5px] text-fog">For CI runners or machines where you cannot type a code. The token is shown once.</p>
        <Field label="Label"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="build-box-3" /></Field>
        <div className="mt-4 flex justify-end gap-2"><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!label.trim()} onClick={() => void issue()}>Issue token</Button></div>
      </Modal>

      <Modal open={!!tokenModal} onClose={() => setTokenModal(null)} title={`Token for ${tokenModal?.label ?? ""}`}>
        <p className="mb-3 text-[13.5px] text-mist">Copy it now. Tessera stores only a hash and cannot show it again.</p>
        <Code>{tokenModal?.token ?? ""}</Code>
        <p className="mt-3 text-[12.5px] text-fog">On the machine:</p>
        <Code>{`curl -fsSL ${origin}/install.sh | sh -s -- --token ${tokenModal?.token ?? ""}`}</Code>
        <p className="mt-1.5 text-[12px] text-fog">Windows: <span className="font-mono">$env:TESSERA_TOKEN = "{tokenModal?.token ?? ""}"; irm {origin}/install.ps1 | iex</span></p>
        <div className="mt-4 flex justify-end"><Button variant="primary" onClick={() => setTokenModal(null)}>I've saved it</Button></div>
      </Modal>
    </div>
  );
}
