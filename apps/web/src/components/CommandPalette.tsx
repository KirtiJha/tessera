import { Activity, BarChart3, BellRing, Bookmark, ChevronsLeft, ChevronsRight, Clock, CornerDownLeft, Database, History, KeyRound, KeySquare, Laptop, LogOut, Monitor, Moon, PiggyBank, ScrollText, Search, Settings, ShieldCheck, Sun, Tag, User, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { readPref } from "../lib/prefs";
import { sessionKind, sessionLabel, useSessions } from "../lib/fleet";
import { fmtDate, modelShort } from "../lib/format";
import { rank } from "../lib/search";
import { useTheme } from "../lib/theme";
import { useNavWidth } from "./Prefs";
import { KIND, StateShape } from "./SessionCard";

interface Item {
  id: string;
  title: string;
  subtitle?: string;
  icon: ReactNode;
  run: () => void;
}
interface Group {
  label: string;
  items: Item[];
}

const PAGES: { to: string; label: string; icon: typeof Activity; admin?: boolean; words?: string }[] = [
  { to: "/app", label: "Live wall", icon: Activity, words: "home sessions fleet" },
  { to: "/app/history", label: "History", icon: Clock, words: "ended past sessions" },
  { to: "/app/analytics", label: "Analytics", icon: BarChart3, words: "spend cost charts" },
  { to: "/app/devices", label: "Devices", icon: Laptop, words: "enrol machine token" },
  { to: "/app/settings", label: "Account and preferences", icon: Settings, words: "password theme" },
  { to: "/app/keys", label: "API keys", icon: KeySquare },
  { to: "/app/people", label: "People and teams", icon: Users, admin: true, words: "invite roles" },
  { to: "/app/budgets", label: "Budgets", icon: PiggyBank, admin: true, words: "limits spend" },
  { to: "/app/policies", label: "Policies", icon: ShieldCheck, admin: true, words: "rules allow deny" },
  { to: "/app/prices", label: "Model prices", icon: Tag, admin: true },
  { to: "/app/notifications", label: "Notifications", icon: BellRing, admin: true, words: "slack webhook pagerduty" },
  { to: "/app/sso", label: "Single sign-on", icon: KeyRound, admin: true, words: "oidc okta entra scim" },
  { to: "/app/audit", label: "Audit log", icon: ScrollText, admin: true },
  { to: "/app/data", label: "Data and compliance", icon: Database, admin: true, words: "retention erase export" },
];

interface Person { id: string; name: string; role: string; team: string | null }
interface Ended { id: string; name: string | null; repo: string | null; cwd: string | null; branch: string | null; ownerName: string | null; startedAt: string; model: string | null }

/**
 * ⌘K. One box that reaches a live session, a page, a person, an ended session or
 * a setting. Matching is plain substring with a preference for prefixes (lib/search);
 * ended sessions come from the server once the query is two characters long.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const { isAdmin, signOut } = useAuth();
  const sessions = useSessions();
  const { choice, setChoice } = useTheme();
  const [navWidth, setNavWidth] = useNavWidth();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [ended, setEnded] = useState<Ended[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // Fresh each time it opens, and only then: the people list arriving later must not wipe what was typed.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setActive(0);
    setEnded([]);
    const t = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  // People, once, the first time the palette opens.
  useEffect(() => {
    if (!open || people) return;
    void api.get<{ people: Person[] }>("/api/fleet/people").then((r) => setPeople(r.people)).catch(() => setPeople([]));
  }, [open, people]);

  // Ended sessions, from the server, a moment after typing stops.
  useEffect(() => {
    if (!open || q.trim().length < 2) {
      setEnded([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      void api
        .get<{ sessions: Ended[] }>(`/api/fleet/history?pageSize=10&search=${encodeURIComponent(q.trim())}`)
        .then((r) => alive && setEnded(r.sessions))
        .catch(() => alive && setEnded([]));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [open, q]);

  const go = (to: string) => {
    onClose();
    nav(to);
  };

  const groups = useMemo<Group[]>(() => {
    const out: Group[] = [];
    const live = rank(q, sessions.filter((s) => s.status !== "ended"), (s) => [sessionLabel(s), s.ownerName, s.git?.branch, s.cwd, s.model, s.machine?.hostname, s.id]);
    if (live.length)
      out.push({
        label: "Live sessions",
        items: live.map((s) => {
          const k = sessionKind(s);
          return { id: `s:${s.id}`, title: sessionLabel(s), subtitle: [s.ownerName ?? "Unassigned", s.git?.branch, modelShort(s.model), KIND[k].label].filter(Boolean).join(" · "), icon: <StateShape kind={k} size={12} />, run: () => go(`/app/sessions/${encodeURIComponent(s.id)}`) };
        }),
      });
    const pages = rank(q, PAGES.filter((p) => !p.admin || isAdmin), (p) => [p.label, p.words]);
    if (pages.length) out.push({ label: "Pages", items: pages.map((p) => ({ id: `p:${p.to}`, title: p.label, icon: <p.icon size={14} className="text-fog" />, run: () => go(p.to) })) });
    // Saved wall views live in this browser's preferences.
    const views = rank(q, readPref<{ id: string; name: string; only: string; group: string; q: string }[]>("wall.views", []), (v) => [v.name, v.q, v.only, v.group], 6);
    if (views.length) out.push({ label: "Wall views", items: views.map((v) => ({ id: `v:${v.id}`, title: v.name, subtitle: [v.only !== "all" ? v.only : null, v.group !== "state" ? `by ${v.group}` : null, v.q ? `“${v.q}”` : null].filter(Boolean).join(" · ") || "everything, by state", icon: <Bookmark size={14} className="text-fog" />, run: () => go(`/app?view=${encodeURIComponent(v.id)}`) })) });
    if (q.trim() && people?.length) {
      const hits = rank(q, people, (p) => [p.name, p.team, p.role], 5);
      if (hits.length) out.push({ label: "People", items: hits.map((p) => ({ id: `u:${p.id}`, title: p.name, subtitle: [p.role, p.team].filter(Boolean).join(" · "), icon: <User size={14} className="text-fog" />, run: () => go(`/app?q=${encodeURIComponent(p.name)}`) })) });
    }
    if (ended.length)
      out.push({
        label: "Ended sessions",
        items: ended.map((e) => ({ id: `e:${e.id}`, title: e.name ?? e.repo ?? e.cwd ?? e.id.slice(0, 8), subtitle: [e.ownerName, e.branch, fmtDate(e.startedAt)].filter(Boolean).join(" · "), icon: <History size={14} className="text-fog" />, run: () => go(`/app/sessions/${encodeURIComponent(e.id)}`) })),
      });
    const actions: { id: string; title: string; words: string; icon: ReactNode; run: () => void }[] = [
      { id: "theme:dark", title: "Theme: Dark", words: "appearance", icon: <Moon size={14} className="text-fog" />, run: () => setChoice("dark") },
      { id: "theme:light", title: "Theme: Light", words: "appearance", icon: <Sun size={14} className="text-fog" />, run: () => setChoice("light") },
      { id: "theme:system", title: "Theme: System", words: "appearance", icon: <Monitor size={14} className="text-fog" />, run: () => setChoice("system") },
      navWidth === "rail"
        ? { id: "nav:expand", title: "Expand navigation", words: "sidebar menu", icon: <ChevronsRight size={14} className="text-fog" />, run: () => setNavWidth("expanded") }
        : { id: "nav:collapse", title: "Collapse navigation", words: "sidebar menu rail", icon: <ChevronsLeft size={14} className="text-fog" />, run: () => setNavWidth("rail") },
      { id: "signout", title: "Sign out", words: "log out", icon: <LogOut size={14} className="text-fog" />, run: () => void signOut().then(() => nav("/")) },
    ].filter((a) => a.id !== `theme:${choice}`);
    const acts = rank(q, actions, (a) => [a.title, a.words], q.trim() ? 5 : 3);
    if (acts.length) out.push({ label: "Actions", items: acts.map((a) => ({ id: a.id, title: a.title, icon: a.icon, run: () => { onClose(); a.run(); } })) });
    return out;
  }, [q, sessions, isAdmin, people, ended, choice, navWidth, setChoice, setNavWidth, signOut, nav, onClose]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  useEffect(() => setActive(0), [q, flat.length]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (flat.length ? (i + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      flat[active]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };
  let index = -1;
  return createPortal(
    <div className="fixed inset-0 z-[60] bg-black/60 p-4 pt-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Search" className="mx-auto w-full max-w-[640px] overflow-hidden rounded-2xl border border-line-2 bg-slate-1 shadow-2xl" onKeyDown={onKey}>
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search size={16} className="shrink-0 text-fog" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Jump to a session, page or person, or type an action…" aria-label="Search" role="combobox" aria-expanded aria-controls="palette-results" aria-activedescendant={flat[active] ? `palette-${flat[active].id}` : undefined} className="h-12 w-full bg-transparent text-[14.5px] text-snow placeholder:text-ash focus:outline-none" />
          <kbd className="hidden rounded border border-line-2 px-1.5 py-0.5 text-[10.5px] text-fog sm:inline">esc</kbd>
        </div>
        <div ref={list} id="palette-results" role="listbox" className="pane max-h-[55vh] overflow-y-auto p-1.5">
          {flat.length === 0 ? <p className="px-3 py-8 text-center text-[13px] text-fog">Nothing matches "{q}".</p> : null}
          {groups.map((g) => (
            <div key={g.label}>
              <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-ash">{g.label}</div>
              {g.items.map((item) => {
                index += 1;
                const i = index;
                const on = i === active;
                return (
                  <div key={item.id} id={`palette-${item.id}`} data-index={i} role="option" aria-selected={on} onMouseMove={() => setActive(i)} onClick={item.run} className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 ${on ? "bg-slate-2" : ""}`}>
                    <span className="flex w-4 shrink-0 justify-center">{item.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] text-snow">{item.title}</span>
                      {item.subtitle ? <span className="block truncate text-[12px] text-fog">{item.subtitle}</span> : null}
                    </span>
                    {on ? <CornerDownLeft size={13} className="shrink-0 text-ash" /> : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11.5px] text-ash">
          <span><kbd className="rounded border border-line-2 px-1">↑</kbd> <kbd className="rounded border border-line-2 px-1">↓</kbd> move</span>
          <span><kbd className="rounded border border-line-2 px-1">↵</kbd> open</span>
          <span className="ml-auto">{sessions.filter((s) => s.status !== "ended").length} live sessions searchable</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
