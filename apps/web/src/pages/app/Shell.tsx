import { AnimatePresence, motion } from "framer-motion";
import { Activity, BarChart3, BellRing, ChevronsLeft, ChevronsRight, Clock, Database, KeyRound, KeySquare, Laptop, LogOut, Menu as MenuIcon, PiggyBank, ScrollText, Settings, ShieldCheck, Tag, Users, Wallet, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Mark, Wordmark } from "../../components/Logo";
import { ThemePicker, useNavWidth } from "../../components/Prefs";
import { Menu, MenuHeading, MenuItem, MenuSeparator, Tooltip } from "../../components/ui";
import { useAuth } from "../../lib/auth";
import { FleetProvider, sessionKind, useFleet, useSessions } from "../../lib/fleet";
import { ThemeScope } from "../../lib/theme";

/** The left navigation. As a rail it keeps the icons and shows each label as a tooltip. */
function Nav({ rail = false, onToggle, className = "" }: { rail?: boolean; onToggle?: () => void; className?: string }) {
  const { isAdmin } = useAuth();
  const item = `flex items-center gap-2.5 rounded-lg text-[14.5px] text-mist hover:bg-slate-2 hover:text-snow lg:text-[13.5px] ${rail ? "h-10 w-10 justify-center" : "px-3 py-2.5 lg:py-2"}`;
  const active = "bg-slate-2 text-snow";
  const link = (to: string, icon: ReactNode, label: string, end = false) => {
    const a = (
      <NavLink to={to} end={end} aria-label={rail ? label : undefined} className={({ isActive }) => `${item} ${isActive ? active : ""}`}>
        {icon}
        {rail ? null : <span className="whitespace-nowrap">{label}</span>}
      </NavLink>
    );
    return rail ? <Tooltip label={label}>{a}</Tooltip> : a;
  };
  const heading = (text: string) => (rail ? <div className="my-2 w-full border-t border-line" aria-hidden="true" /> : <div className="mt-5 px-3 text-[11.5px] font-medium text-ash">{text}</div>);
  return (
    <aside aria-label="Main" className={`h-full shrink-0 flex-col overflow-y-auto overflow-x-hidden border-r border-line bg-ink-2 py-4 transition-[width] duration-200 ease-[var(--ease-tile)] ${rail ? "w-[60px] items-center px-2.5" : "w-[220px] px-3"} ${className}`}>
      <nav className="space-y-0.5">
        {link("/app", <Activity size={16} />, "Live wall", true)}
        {link("/app/history", <Clock size={16} />, "History")}
        {link("/app/analytics", <BarChart3 size={16} />, "Analytics")}
      </nav>
      {heading("Your setup")}
      <nav className="mt-1 space-y-0.5">
        {link("/app/devices", <Laptop size={16} />, "Devices")}
        {link("/app/settings", <Settings size={16} />, "Account")}
        {link("/app/keys", <KeySquare size={16} />, "API keys")}
      </nav>
      {isAdmin ? (
        <>
          {heading("Organisation")}
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
      {onToggle ? (
        <div className={`mt-auto w-full border-t border-line pt-3 ${rail ? "flex justify-center" : ""}`}>
          {rail ? (
            <Tooltip label="Expand navigation">
              <button onClick={onToggle} aria-label="Expand navigation" aria-expanded={false} className={item}>
                <ChevronsRight size={16} />
              </button>
            </Tooltip>
          ) : (
            <button onClick={onToggle} aria-label="Collapse navigation" aria-expanded className={`${item} w-full`}>
              <ChevronsLeft size={16} />
              <span>Collapse</span>
            </button>
          )}
        </div>
      ) : null}
    </aside>
  );
}

/** Who is signed in, the theme, and the way out. */
function UserMenu() {
  const { me, signOut } = useAuth();
  const nav = useNavigate();
  const name = me?.user.name ?? "";
  const initials = name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
  return (
    <Menu label="Account menu" button={initials} width={272} className="h-8 w-8 bg-slate-3 text-[12px] font-semibold text-snow hover:bg-line-2">
      <MenuHeading>
        <div className="truncate text-[13px] font-medium text-snow">{name}</div>
        <div className="truncate text-[12px] text-fog">{me?.org.name} · {me?.user.role}</div>
      </MenuHeading>
      <MenuSeparator />
      <div className="px-2.5 py-1.5">
        <div className="mb-1.5 text-[11.5px] font-medium text-ash">Theme</div>
        <ThemePicker size="sm" className="flex w-full" />
      </div>
      <MenuSeparator />
      <MenuItem icon={<Settings size={15} />} onSelect={() => nav("/app/settings")}>Account and preferences</MenuItem>
      <MenuItem icon={<LogOut size={15} />} onSelect={() => void signOut().then(() => nav("/"))}>Sign out</MenuItem>
    </Menu>
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
        <MenuIcon size={20} />
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
        <UserMenu />
      </div>
    </header>
  );
}

export function Shell() {
  const [menu, setMenu] = useState(false);
  const [width, setWidth] = useNavWidth();
  const rail = width === "rail";
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
    <ThemeScope>
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
            <Nav className="hidden lg:flex" rail={rail} onToggle={() => setWidth(rail ? "expanded" : "rail")} />
            <main className="pane min-w-0 flex-1 overflow-y-auto">
              <Outlet />
            </main>
          </div>
        </div>
      </FleetProvider>
    </ThemeScope>
  );
}
