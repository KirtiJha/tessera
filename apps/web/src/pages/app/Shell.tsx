import { Activity, BarChart3, BellRing, KeyRound, ShieldCheck, Clock, Laptop, LogOut, PiggyBank, ScrollText, Settings, Tag, Users, Wallet } from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Mark, Wordmark } from "../../components/Logo";
import { useAuth } from "../../lib/auth";
import { FleetProvider, sessionKind, useFleet, useSessions } from "../../lib/fleet";

function Nav() {
  const { me, isAdmin, signOut } = useAuth();
  const nav = useNavigate();
  const item = "flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] text-mist hover:bg-slate-2 hover:text-snow";
  const active = "bg-slate-2 text-snow";
  const link = (to: string, icon: React.ReactNode, label: string, end = false) => (
    <NavLink to={to} end={end} className={({ isActive }) => `${item} ${isActive ? active : ""}`}>
      {icon}
      <span>{label}</span>
    </NavLink>
  );
  return (
    <aside className="flex h-full w-[220px] shrink-0 flex-col border-r border-line bg-ink-2 px-3 py-4">
      <nav className="space-y-0.5">
        {link("/app", <Activity size={16} />, "Live wall", true)}
        {link("/app/history", <Clock size={16} />, "History")}
        {link("/app/analytics", <BarChart3 size={16} />, "Analytics")}
      </nav>
      <div className="mt-5 px-3 text-[11.5px] font-medium text-ash">Your setup</div>
      <nav className="mt-1 space-y-0.5">
        {link("/app/devices", <Laptop size={16} />, "Devices")}
        {link("/app/settings", <Settings size={16} />, "Account")}
      </nav>
      {isAdmin ? (
        <>
          <div className="mt-5 px-3 text-[11.5px] font-medium text-ash">Organisation</div>
          <nav className="mt-1 space-y-0.5">
            {link("/app/people", <Users size={16} />, "People and teams")}
            {link("/app/budgets", <PiggyBank size={16} />, "Budgets")}
            {link("/app/policies", <ShieldCheck size={16} />, "Policies")}
            {link("/app/prices", <Tag size={16} />, "Model prices")}
            {link("/app/notifications", <BellRing size={16} />, "Notifications")}
            {link("/app/sso", <KeyRound size={16} />, "Single sign-on")}
            {link("/app/audit", <ScrollText size={16} />, "Audit log")}
          </nav>
        </>
      ) : null}
      <div className="mt-auto border-t border-line pt-3">
        <div className="px-3 text-[13px] font-medium text-snow">{me?.user.name}</div>
        <div className="px-3 text-[12px] text-fog">{me?.org.name} · {me?.user.role}</div>
        <button onClick={() => void signOut().then(() => nav("/"))} className={`${item} mt-2 w-full`}>
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </aside>
  );
}

function TopBar() {
  const { connected, kpis } = useFleet();
  const sessions = useSessions();
  const waiting = sessions.filter((s) => sessionKind(s) === "waiting").length;
  const status = waiting > 0 ? "waiting" : connected ? "ok" : "stale";
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line bg-ink-2 px-4">
      <NavLink to="/app" className="inline-flex items-center gap-2.5">
        <Mark size={24} status={status} />
        <Wordmark className="text-[19px]" />
      </NavLink>
      <div className="ml-2 flex items-center gap-2 text-[12.5px] text-fog">
        <span className={`h-2 w-2 rounded-full ${connected ? "bg-teal-400 dot-live" : "bg-rose-400"}`} />
        {connected ? `${sessions.filter((s) => s.status !== "ended").length} live` : "reconnecting"}
      </div>
      <div className="ml-auto flex items-center gap-3 text-[12.5px] text-fog">
        {waiting > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-1 font-medium text-amber-400">
            <span className="h-1.5 w-1.5 rounded-sm bg-amber-400" /> {waiting} waiting on someone
          </span>
        ) : null}
        <Wallet size={14} /> {kpis ? `$${kpis.costTodayUsd.toFixed(2)} today` : "—"}
      </div>
    </header>
  );
}

export function Shell() {
  return (
    <FleetProvider>
      <div className="flex h-full flex-col bg-ink">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <Nav />
          <main className="pane min-w-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>
    </FleetProvider>
  );
}
