import { AnimatePresence, motion } from "framer-motion";
import { Activity, BarChart3, Database, KeySquare, BellRing, KeyRound, Menu, ShieldCheck, Clock, Laptop, LogOut, PiggyBank, ScrollText, Settings, Tag, Users, Wallet, X } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Mark, Wordmark } from "../../components/Logo";
import { useAuth } from "../../lib/auth";
import { FleetProvider, sessionKind, useFleet, useSessions } from "../../lib/fleet";

function Nav({ className = "" }: { className?: string }) {
  const { me, isAdmin, signOut } = useAuth();
  const nav = useNavigate();
  const item = "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[14.5px] lg:py-2 lg:text-[13.5px] text-mist hover:bg-slate-2 hover:text-snow";
  const active = "bg-slate-2 text-snow";
  const link = (to: string, icon: React.ReactNode, label: string, end = false) => (
    <NavLink to={to} end={end} className={({ isActive }) => `${item} ${isActive ? active : ""}`}>
      {icon}
      <span>{label}</span>
    </NavLink>
  );
  return (
    <aside className={`h-full w-[220px] shrink-0 flex-col overflow-y-auto border-r border-line bg-ink-2 px-3 py-4 ${className}`}>
      <nav className="space-y-0.5">
        {link("/app", <Activity size={16} />, "Live wall", true)}
        {link("/app/history", <Clock size={16} />, "History")}
        {link("/app/analytics", <BarChart3 size={16} />, "Analytics")}
      </nav>
      <div className="mt-5 px-3 text-[11.5px] font-medium text-ash">Your setup</div>
      <nav className="mt-1 space-y-0.5">
        {link("/app/devices", <Laptop size={16} />, "Devices")}
        {link("/app/settings", <Settings size={16} />, "Account")}
        {link("/app/keys", <KeySquare size={16} />, "API keys")}
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
            {link("/app/data", <Database size={16} />, "Data and compliance")}
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

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { connected, kpis } = useFleet();
  const sessions = useSessions();
  const waiting = sessions.filter((s) => sessionKind(s) === "waiting").length;
  const status = waiting > 0 ? "waiting" : connected ? "ok" : "stale";
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-ink-2 px-3 sm:gap-4 sm:px-4">
      <button onClick={onMenu} aria-label="Open menu" className="-ml-1 inline-flex h-10 w-10 items-center justify-center rounded-lg text-mist hover:bg-slate-2 hover:text-snow lg:hidden">
        <Menu size={20} />
      </button>
      <NavLink to="/app" className="inline-flex items-center gap-2.5">
        <Mark size={24} status={status} />
        <Wordmark className="hidden text-[19px] min-[400px]:inline" />
      </NavLink>
      <div className="ml-1 flex items-center gap-2 whitespace-nowrap text-[12.5px] text-fog sm:ml-2">
        <span className={`h-2 w-2 rounded-full ${connected ? "bg-teal-400 dot-live" : "bg-rose-400"}`} />
        {connected ? `${sessions.filter((s) => s.status !== "ended").length} live` : "reconnecting"}
      </div>
      <div className="ml-auto flex items-center gap-3 whitespace-nowrap text-[12.5px] text-fog">
        {waiting > 0 ? (
          <NavLink to="/app" className="inline-flex items-center gap-1.5 rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-1 font-medium text-amber-400">
            <span className="h-1.5 w-1.5 rounded-sm bg-amber-400" /> <span>{waiting} waiting<span className="hidden sm:inline"> on someone</span></span>
          </NavLink>
        ) : null}
        <span className="inline-flex items-center gap-1.5"><Wallet size={14} /> <span>{kpis ? `$${kpis.costTodayUsd.toFixed(2)}` : "—"}<span className="hidden sm:inline"> today</span></span></span>
      </div>
    </header>
  );
}

export function Shell() {
  const [menu, setMenu] = useState(false);
  const { pathname } = useLocation();
  // Following a link closes the menu on small screens.
  useEffect(() => setMenu(false), [pathname]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);
  return (
    <FleetProvider>
      <div className="flex h-full flex-col bg-ink">
        <TopBar onMenu={() => setMenu(true)} />
        <AnimatePresence>
          {menu ? (
            <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
              <motion.div className="absolute inset-0 bg-black/60" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMenu(false)} />
              <motion.div className="absolute inset-y-0 left-0 flex" initial={{ x: -280 }} animate={{ x: 0 }} exit={{ x: -280 }} transition={{ type: "spring", stiffness: 420, damping: 40 }}>
                <Nav className="flex w-[264px] pt-14" />
                <button onClick={() => setMenu(false)} aria-label="Close menu" className="absolute left-3 top-2 inline-flex h-10 w-10 items-center justify-center rounded-lg text-mist hover:bg-slate-2 hover:text-snow">
                  <X size={20} />
                </button>
              </motion.div>
            </div>
          ) : null}
        </AnimatePresence>
        <div className="flex min-h-0 flex-1">
          <Nav className="hidden lg:flex" />
          <main className="pane min-w-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>
    </FleetProvider>
  );
}
