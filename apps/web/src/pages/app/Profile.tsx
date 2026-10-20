import type { SessionView } from "@tessera/contract";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BarList, Change, ColumnChart } from "../../components/ColumnChart";
import { SessionCard } from "../../components/SessionCard";
import { Empty, Hint, Panel, Segmented, Spinner } from "../../components/ui";
import { HELP } from "../../lib/help";
import { api, ApiError } from "../../lib/api";
import { sessionKind, useSessions } from "../../lib/fleet";
import { fmtDate, fmtDuration, fmtTokens, fmtUsd } from "../../lib/format";
import type { ReactNode } from "react";

interface Profile {
  subject: { kind: "person"; id: string; name: string; role: string; status: string; team: { id: string; name: string } | null } | { kind: "team"; id: string; name: string; costCenter: string | null; members: number };
  range: { from: string; to: string; days: number };
  totals: { costUsd: number; prevCostUsd: number; sessions: number; prevSessions: number; tokens: number; failedAgents: number; blowouts: number };
  daily: { day: string; costUsd: number; sessions: number; anomaly?: boolean }[];
  repos: { repo: string; costUsd: number; sessions: number }[];
  prompts: { waited: { count: number; p50Ms: number | null }; answered: { count: number; p50Ms: number | null } };
  recent: { id: string; name: string | null; owner: string | null; ownerId: string | null; status: string; startedAt: string; endedAt: string | null; costUsd: number | null }[];
  members: { id: string; name: string; role: string; costUsd: number; prevCostUsd: number; sessions: number }[] | null;
}

const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const ms = (v: number | null) => (v === null ? "—" : fmtDuration(v));

function Fact({ label, value, children, help }: { label: string; value: string; children?: ReactNode; help?: string }) {
  return (
    <div className="rounded-xl border border-line bg-slate-1 px-4 py-3.5">
      <div className="text-[12px] text-fog">{label}{help ? <Hint label={label.toLowerCase()}>{help}</Hint> : null}</div>
      <div className="mt-1 text-[22px] font-semibold tabular-nums tracking-tight text-snow">{value}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-fog">{children}</div>
    </div>
  );
}

/**
 * One person or one team: what they spend against the period before, what on,
 * how long their prompts wait and how quickly they answer others', what is live
 * now and what ran lately. For a team, each member's share.
 */
export function ProfilePage({ kind }: { kind: "person" | "team" }) {
  const { id = "" } = useParams();
  const [days, setDays] = useState("30");
  const [data, setData] = useState<Profile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const sessions = useSessions();

  useEffect(() => {
    setErr(null);
    void api
      .get<Profile>(`/api/analytics/profile/${kind}/${encodeURIComponent(id)}?days=${days}`)
      .then(setData)
      .catch((e) => setErr(e instanceof ApiError ? e.message : "Could not load this page."));
  }, [kind, id, days]);

  const live = sessions.filter((s: SessionView) => s.status !== "ended" && (kind === "person" ? s.ownerId === id : s.teamId === id));
  const liveIds = new Set(live.map((x) => x.id));
  live.sort((a, b) => (sessionKind(a) === "waiting" ? -1 : 0) - (sessionKind(b) === "waiting" ? -1 : 0));

  if (err) return <div className="p-6 text-[14px] text-rose-400">{err}</div>;
  if (!data || data.subject.id !== id) return <div className="flex h-64 items-center justify-center"><Spinner /></div>;
  const s = data.subject;
  const t = data.totals;

  return (
    <div className="mx-auto max-w-6xl p-3 sm:p-5">
      <Link to="/app/analytics" className="inline-flex items-center gap-1.5 text-[13px] text-fog hover:text-snow"><ArrowLeft size={14} /> Analytics</Link>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-semibold tracking-tight">{s.name}</h1>
          <p className="mt-1 text-[14px] text-fog">
            {s.kind === "person" ? (
              <>
                {s.role}
                {s.team ? <> · <Link to={`/app/teams/${s.team.id}`} className="text-mist hover:text-teal-300">{s.team.name}</Link></> : " · no team"}
                {s.status === "disabled" ? " · disabled" : ""}
              </>
            ) : (
              <>Team of {s.members}{s.costCenter ? ` · cost centre ${s.costCenter}` : ""}</>
            )}
          </p>
        </div>
        <Segmented label="Period" value={days} onChange={setDays} options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} size="sm" />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Fact help={`${HELP.cost} ${HELP.change}`} label={`Spend, last ${data.range.days} days`} value={fmtUsd(t.costUsd)}>
          <Change now={t.costUsd} before={t.prevCostUsd} /> <span>vs {fmtUsd(t.prevCostUsd)} before</span>
        </Fact>
        <Fact label="Sessions" value={String(t.sessions)}>
          <Change now={t.sessions} before={t.prevSessions} /> <span>{fmtTokens(t.tokens)} tokens</span>
        </Fact>
        <Fact help={HELP.waited} label={s.kind === "person" ? "Their prompts waited" : "Prompts waited"} value={ms(data.prompts.waited.p50Ms)}>
          <span>median, of {data.prompts.waited.count}</span>
        </Fact>
        <Fact help={HELP.answered} label={s.kind === "person" ? "They answered" : "Members answered"} value={String(data.prompts.answered.count)}>
          <span>{data.prompts.answered.count ? `median ${ms(data.prompts.answered.p50Ms)} to answer` : "prompts in Tessera"}</span>
        </Fact>
      </div>

      <Panel title="Spend per day" className="mt-4" action={<Link to={`/app/analytics?from=${data.range.from}&to=${data.range.to}${s.kind === "team" ? `&team=${s.id}&groupBy=person` : "&groupBy=repo"}`} className="text-[12px] text-fog hover:text-teal-300">Open in Analytics →</Link>}>
        {t.costUsd > 0 ? (
          <ColumnChart
            ariaLabel={`Estimated spend per day for ${s.name}`}
            data={data.daily.map((d) => ({ key: d.day, label: shortDay(d.day), value: d.costUsd, flagged: d.anomaly, detail: `${d.sessions} session${d.sessions === 1 ? "" : "s"}` }))}
            format={(n) => fmtUsd(n, n < 10 ? 2 : 0)}
          />
        ) : <Empty title="No spend in this period" body="Sessions appear here once they report tokens." />}
        {t.failedAgents || t.blowouts ? <p className="mt-2 text-[12px] text-fog">{t.failedAgents} agent{t.failedAgents === 1 ? "" : "s"} failed and context windows overflowed {t.blowouts} time{t.blowouts === 1 ? "" : "s"} in sessions started in this period.</p> : null}
      </Panel>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {data.members ? (
          <Panel title={`Members · ${data.members.length}`} action={<span className="text-[11.5px] text-fog">change on the {data.range.days} days before<Hint label="the change">{HELP.change}</Hint></span>}>
            {data.members.length ? (
              <BarList sub="Spend by member" total={t.costUsd} format={(n) => fmtUsd(n)} rows={data.members.map((m) => ({ key: m.name, value: m.costUsd, prev: m.prevCostUsd, sub: `${m.sessions} sess.`, href: `/app/people/${m.id}` }))} />
            ) : <p className="text-[13px] text-fog">Nobody is in this team yet.</p>}
          </Panel>
        ) : null}
        <Panel title="Where it went">
          {data.repos.length ? <BarList sub="Spend by repository" total={t.costUsd} format={(n) => fmtUsd(n)} rows={data.repos.map((r) => ({ key: r.repo, value: r.costUsd, sub: `${r.sessions} sess.` }))} /> : <p className="text-[13px] text-fog">No spend in this period.</p>}
        </Panel>
        <Panel title={`Live now · ${live.length}`}>
          {live.length ? <div className="grid gap-3 sm:grid-cols-2">{live.slice(0, 6).map((x) => <SessionCard key={x.id} s={x} now={Date.now()} compact />)}</div> : <p className="text-[13px] text-fog">No live sessions.</p>}
          {live.length > 6 ? <p className="mt-2 text-[12px] text-fog">{live.length - 6} more on the <Link to="/app" className="text-mist hover:text-teal-300">wall</Link>.</p> : null}
        </Panel>
        <Panel title="Recent sessions" action={s.kind === "person" ? <Link to={`/app/history?owner=${s.id}`} className="text-[12px] text-fog hover:text-teal-300">All in History →</Link> : undefined}>
          {data.recent.length ? (
            <ul className="divide-y divide-line">
              {data.recent.map((r) => (
                <li key={r.id} className="flex items-center gap-3 py-2 text-[13px]">
                  <Link to={`/app/sessions/${encodeURIComponent(r.id)}`} className="min-w-0 flex-1 truncate text-snow hover:text-teal-300">{r.name ?? r.id.slice(0, 8)}</Link>
                  {s.kind === "team" && r.owner ? <span className="hidden shrink-0 text-[12px] text-fog sm:inline">{r.owner}</span> : null}
                  <span className="shrink-0 text-[12px] text-fog">{fmtDate(r.startedAt)}</span>
                  <span className={`w-16 shrink-0 text-right text-[12px] ${liveIds.has(r.id) ? "text-teal-300" : "text-fog"}`} title={r.status !== "ended" && !liveIds.has(r.id) ? "Has not reported for a while" : undefined}>{liveIds.has(r.id) ? "live" : r.endedAt ? fmtDuration(Date.parse(r.endedAt) - Date.parse(r.startedAt)) : r.status === "ended" ? "ended" : "silent"}</span>
                  <span className="w-16 shrink-0 text-right tabular-nums text-mist">{r.costUsd === null ? "—" : fmtUsd(r.costUsd)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-[13px] text-fog">No sessions yet.</p>}
        </Panel>
      </div>
    </div>
  );
}
