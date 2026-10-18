import { Download } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BarList, ColumnChart } from "../../components/ColumnChart";
import { Button, Empty, Field, Input, Panel, Select, useToast } from "../../components/ui";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDuration, fmtTokens, fmtUsd, modelShort } from "../../lib/format";

interface Data {
  range: { from: string; to: string; days: number; groupBy: string };
  totals: { costUsd: number; prevCostUsd: number; tokens: number; sessions: number; people: number; agents: number; failedAgents: number; blowouts: number; asks: number; answeredInTessera: number; answeredInSlack: number; meanWaitMs: number | null };
  daily: { day: string; costUsd: number; tokens: number; sessions: number; anomaly?: boolean }[];
  groups: { key: string; costUsd: number; tokens: number; sessions: number; people: number }[];
  models: { model: string; costUsd: number; sessions: number }[];
  forecast: { monthStart: string; monthEnd: string; monthToDateUsd: number; dailyRunRateUsd: number; projectedMonthUsd: number };
}
interface Settings { ticketPattern: string; defaultTicketPattern: string; teams: { id: string; name: string; costCenter: string | null }[]; tagKeys: string[] }

const GROUP_LABEL: Record<string, string> = { team: "Team", cost_center: "Cost centre", person: "Person", repo: "Repository", ticket: "Ticket", model: "Model" };
const groupLabel = (g: string) => GROUP_LABEL[g] ?? `Tag: ${g.slice(4)}`;

const utc = (t: number) => new Date(t).toISOString().slice(0, 10);
function preset(p: string): { from: string; to: string } {
  const now = new Date();
  const today = utc(now.getTime());
  if (p === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  if (p === "last-month") {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    return { from: utc(first.getTime()), to: utc(last.getTime()) };
  }
  const days = Number(p);
  return { from: utc(now.getTime() - (days - 1) * 86_400_000), to: today };
}
const PRESETS: [string, string][] = [["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["month", "This month"], ["last-month", "Last month"]];
const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

function Tile({ label, value, sub, delta }: { label: string; value: string; sub?: string; delta?: { text: string; good: boolean } | null }) {
  return (
    <div className="rounded-xl border border-line bg-slate-1 px-4 py-3.5">
      <div className="text-[12px] text-fog">{label}</div>
      <div className="mt-1 text-[24px] font-semibold tabular-nums tracking-tight text-snow">{value}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-fog">
        {delta ? <span className={delta.good ? "text-teal-300" : "text-amber-400"}>{delta.text}</span> : null}
        {sub ? <span>{sub}</span> : null}
      </div>
    </div>
  );
}

function AllocationSettings({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const toast = useToast();
  const [pattern, setPattern] = useState(settings.ticketPattern);
  const [cc, setCc] = useState<Record<string, string>>(Object.fromEntries(settings.teams.map((t) => [t.id, t.costCenter ?? ""])));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.put("/api/analytics/settings", { ticketPattern: pattern, costCenters: settings.teams.map((t) => ({ teamId: t.id, costCenter: cc[t.id] ?? "" })) });
      toast("Allocation saved. Figures regroup straight away.");
      onSaved();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not save.", "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Allocation">
      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-3">
          <Field label="Ticket pattern" hint={`A regular expression found in branch names. Default ${settings.defaultTicketPattern} finds PAY-142 in feat/PAY-142-refunds. A ticket tag wins over the branch.`}>
            <Input className="font-mono text-[13px]" value={pattern} onChange={(e) => setPattern(e.target.value)} />
          </Field>
          <div className="rounded-lg border border-line bg-ink-2 p-3 text-[12.5px] leading-relaxed text-mist">
            Engineers can tag sessions when they start Claude Code: <span className="font-mono text-[12px] text-teal-300">TESSERA_TAGS="project=apollo,ticket=PAY-142" claude</span>. Every tag becomes a way to group spend here and a column in the per-session export.
            {settings.tagKeys.length ? <div className="mt-1.5 text-fog">Tags seen in the last 90 days: {settings.tagKeys.join(", ")}</div> : null}
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-mist">Cost centre per team</div>
          {settings.teams.length ? (
            <ul className="space-y-1.5">
              {settings.teams.map((t) => (
                <li key={t.id} className="grid grid-cols-[1fr_160px] items-center gap-3 text-[13px]">
                  <span className="truncate text-snow">{t.name}</span>
                  <Input aria-label={`Cost centre for ${t.name}`} className="h-8 font-mono text-[12.5px]" value={cc[t.id] ?? ""} onChange={(e) => setCc({ ...cc, [t.id]: e.target.value })} placeholder="CC-120" />
                </li>
              ))}
            </ul>
          ) : <p className="text-[12.5px] text-fog">Create teams under People and teams to allocate by cost centre.</p>}
        </div>
      </div>
      <div className="mt-4 flex justify-end"><Button variant="primary" size="sm" loading={busy} onClick={() => void save()}>Save allocation</Button></div>
    </Panel>
  );
}

/** Spend over time, allocated to teams, cost centres, tickets and tags; a forecast; chargeback export. */
export function Analytics() {
  const { me } = useAuth();
  const isAdmin = me?.user.role === "admin" || me?.user.role === "owner";
  const [range, setRange] = useState("30");
  const [groupBy, setGroupBy] = useState("team");
  const [team, setTeam] = useState("");
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [version, setVersion] = useState(0);
  const r = useMemo(() => preset(range), [range]);
  const qs = `from=${r.from}&to=${r.to}&groupBy=${encodeURIComponent(groupBy)}${team ? `&team=${team}` : ""}`;

  const loadSettings = useCallback(() => api.get<Settings>("/api/analytics/settings").then(setSettings), []);
  useEffect(() => void loadSettings(), [loadSettings]);
  useEffect(() => {
    setLoading(true);
    void api.get<Data>(`/api/analytics?${qs}`).then(setData).finally(() => setLoading(false));
  }, [qs, version]);

  const t = data?.totals;
  const change = t && t.prevCostUsd > 0 ? (t.costUsd - t.prevCostUsd) / t.prevCostUsd : null;
  const top = data ? data.groups.slice(0, 12) : [];
  const rest = data ? data.groups.slice(12).reduce((n, g) => n + g.costUsd, 0) : 0;

  return (
    <div className="mx-auto max-w-6xl p-3 sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-semibold tracking-tight">Analytics</h1>
          <p className="mt-1 text-[14px] text-fog">Estimated spend from tokens at your model prices, allocated the way finance asks for it. Days are UTC.</p>
        </div>
        {isAdmin ? (
          <div className="flex gap-2">
            <a href={`/api/analytics/export.csv?${qs}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-slate-2 px-3 text-[13px] font-medium text-snow hover:bg-slate-3"><Download size={14} /> By {groupLabel(groupBy).toLowerCase()}</a>
            <a href={`/api/analytics/export.csv?${qs}&detail=sessions`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-2 bg-slate-2 px-3 text-[13px] font-medium text-snow hover:bg-slate-3"><Download size={14} /> Per session</a>
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-line bg-slate-1 p-1 text-[12.5px]" role="group" aria-label="Date range">
          {PRESETS.map(([k, l]) => <button key={k} onClick={() => setRange(k)} aria-pressed={range === k} className={`rounded-md px-2.5 py-1 ${range === k ? "bg-slate-3 text-snow" : "text-fog hover:text-snow"}`}>{l}</button>)}
        </div>
        <div className="w-44"><Select aria-label="Team" value={team} onChange={(e) => setTeam(e.target.value)} className="h-9 text-[13px]">
          <option value="">All teams</option>
          {settings?.teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </Select></div>
        <div className="w-52"><Select aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className="h-9 text-[13px]">
          {Object.entries(GROUP_LABEL).map(([k, l]) => <option key={k} value={k}>By {l.toLowerCase()}</option>)}
          {settings?.tagKeys.map((k) => <option key={k} value={`tag:${k}`}>By tag: {k}</option>)}
        </Select></div>
        <span className="ml-auto text-[12px] text-fog">{shortDay(r.from)} – {shortDay(r.to)}</span>
      </div>

      {!data ? null : (
        <div className={`transition-opacity duration-200 ${loading ? "opacity-60" : ""}`}>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile label="Estimated spend" value={fmtUsd(t!.costUsd)} delta={change === null ? null : { text: `${change >= 0 ? "+" : "−"}${Math.abs(Math.round(change * 100))}%`, good: change <= 0 }} sub={change === null ? "no earlier period to compare" : `vs the ${data.range.days} days before`} />
            <Tile label="Forecast this month" value={fmtUsd(data.forecast.projectedMonthUsd)} sub={`${fmtUsd(data.forecast.monthToDateUsd)} so far · ${fmtUsd(data.forecast.dailyRunRateUsd)}/day lately`} />
            <Tile label="Sessions" value={t!.sessions.toLocaleString()} sub={`${t!.people} ${t!.people === 1 ? "person" : "people"} · ${fmtTokens(t!.tokens)} tokens`} />
            <Tile label="Prompts answered in Tessera" value={t!.asks ? `${Math.round((t!.answeredInTessera / t!.asks) * 100)}%` : "—"} sub={t!.asks ? `${t!.answeredInTessera} of ${t!.asks}${t!.answeredInSlack ? `, ${t!.answeredInSlack} from Slack` : ""}${t!.meanWaitMs !== null ? ` · mean wait ${fmtDuration(t!.meanWaitMs)}` : ""}` : "no prompts in this range"} />
          </div>

          {t!.sessions === 0 ? (
            <div className="mt-4"><Empty title="No spend in this range" body="Spend appears as sessions report. Try a longer range, or another team." /></div>
          ) : (
            <>
              <Panel title="Spend per day" className="mt-4">
                <ColumnChart
                  ariaLabel="Estimated spend per day"
                  data={data.daily.map((d) => ({ key: d.day, label: shortDay(d.day), value: d.costUsd, flagged: d.anomaly, detail: `${d.sessions} session${d.sessions === 1 ? "" : "s"}` }))}
                  format={(n) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : fmtUsd(n, n < 10 ? 2 : 0))}
                />
                {data.daily.some((d) => d.anomaly) ? <p className="mt-2 text-[12px] text-fog">Marked days spent more than three standard deviations above the two weeks before them.</p> : null}
              </Panel>
              <div className="mt-4 grid gap-4 lg:grid-cols-[1.5fr_1fr]">
                <Panel title={`By ${groupLabel(groupBy).toLowerCase()}`}>
                  <BarList
                    sub={`Spend by ${groupLabel(groupBy).toLowerCase()}`}
                    total={t!.costUsd}
                    format={(n) => fmtUsd(n)}
                    rows={[...top.map((g) => ({ key: groupBy === "model" ? modelShort(g.key) : g.key, value: g.costUsd, sub: `${g.sessions} sess.` })), ...(rest > 0 ? [{ key: `Other (${data.groups.length - 12})`, value: rest }] : [])]}
                  />
                </Panel>
                <Panel title="By model">
                  <BarList sub="Spend by model" total={t!.costUsd} format={(n) => fmtUsd(n)} rows={data.models.map((m) => ({ key: modelShort(m.model), value: m.costUsd, sub: `${m.sessions} sess.` }))} />
                  <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-3 text-[12px]">
                    <div><div className="text-fog">Agents run</div><div className="text-[15px] font-semibold text-snow">{t!.agents.toLocaleString()}</div></div>
                    <div><div className="text-fog">Failed</div><div className="text-[15px] font-semibold text-snow">{t!.agents ? `${((t!.failedAgents / t!.agents) * 100).toFixed(1)}%` : "—"}</div></div>
                    <div><div className="text-fog">Context blowouts</div><div className="text-[15px] font-semibold text-snow">{t!.blowouts}</div></div>
                  </div>
                </Panel>
              </div>
            </>
          )}
        </div>
      )}

      {isAdmin && settings ? <div className="mt-4"><AllocationSettings key={settings.ticketPattern + settings.teams.map((x) => x.costCenter).join()} settings={settings} onSaved={() => { void loadSettings(); setVersion((x) => x + 1); }} /></div> : null}
    </div>
  );
}
