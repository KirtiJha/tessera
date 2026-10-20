import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronUp, ChevronsUpDown, CircleHelp, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "amber";

export function Button({ variant = "secondary", size = "md", className = "", loading, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; loading?: boolean }) {
  const base = "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap";
  const sz = size === "sm" ? "h-8 px-3 text-[13px]" : size === "lg" ? "h-12 px-5 text-[15px]" : "h-10 px-4 text-[14px]";
  const v: Record<Variant, string> = {
    primary: "bg-teal-400 text-ink hover:bg-teal-300",
    secondary: "border border-line-2 bg-slate-2 text-snow hover:bg-slate-3",
    ghost: "text-mist hover:bg-slate-2 hover:text-snow",
    danger: "bg-rose-600 text-white hover:bg-rose-400",
    amber: "bg-amber-400 text-ink hover:bg-amber-500",
  };
  return (
    <button className={`${base} ${sz} ${v[variant]} ${className}`} disabled={loading || rest.disabled} {...rest}>
      {loading ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : null}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-mist">{label}</span>
      {children}
      {error ? <span className="mt-1.5 block text-[12px] text-rose-400">{error}</span> : hint ? <span className="mt-1.5 block text-[12px] text-fog">{hint}</span> : null}
    </label>
  );
}

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`h-10 w-full rounded-lg border border-line-2 bg-ink-2 px-3 text-[14px] text-snow placeholder:text-ash focus:border-teal-400 focus:outline-none ${className}`} {...rest} />;
}

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`h-10 w-full rounded-lg border border-line-2 bg-ink-2 px-3 text-[14px] text-snow focus:border-teal-400 focus:outline-none ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({ className = "", ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`w-full rounded-lg border border-line-2 bg-ink-2 px-3 py-2 text-[14px] text-snow placeholder:text-ash focus:border-teal-400 focus:outline-none ${className}`} {...rest} />;
}

export function Panel({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-xl border border-line bg-slate-1 ${className}`}>
      {title ? (
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[14px] font-semibold text-snow">{title}</h2>
          {action}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Modal({ open, onClose, title, children, width = 520 }: { open: boolean; onClose: () => void; title: string; children: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open ? (
        <motion.div className="fixed inset-0 z-50 flex overflow-y-auto bg-black/60 p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          <motion.div role="dialog" aria-modal="true" aria-label={title} className="m-auto w-full rounded-2xl border border-line-2 bg-slate-1 shadow-2xl" style={{ maxWidth: width }} initial={{ y: 12, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 8, scale: 0.98 }} transition={{ duration: 0.2 }}>
            <header className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="text-[16px] font-semibold">{title}</h2>
              <button onClick={onClose} className="rounded-md p-1 text-fog hover:bg-slate-2 hover:text-snow" aria-label="Close">
                <X size={18} />
              </button>
            </header>
            <div className="p-5">{children}</div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

// ---- toasts ----------------------------------------------------------------
interface Toast {
  id: number;
  text: string;
  tone: "ok" | "error" | "info";
}
const ToastCtx = createContext<(text: string, tone?: Toast["tone"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, text, tone }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 4000);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        <AnimatePresence>
          {list.map((t) => (
            <motion.div key={t.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} className={`rounded-lg border bg-slate-1 px-4 py-2.5 text-[13px] shadow-lg ${t.tone === "error" ? "border-rose-600/60 text-rose-400" : t.tone === "info" ? "border-line-2 text-snow" : "border-teal-700 text-teal-300"}`}>
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-2 px-6 py-14 text-center">
      <div className="text-[16px] font-semibold text-snow">{title}</div>
      <p className="mt-1.5 max-w-md text-[13.5px] leading-relaxed text-fog">{body}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

// ---- confirm ----------------------------------------------------------------
export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  /** The button that does it. */
  action?: string;
  cancel?: string;
  tone?: "danger" | "default";
}
const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(() => Promise.resolve(false));

/** An in-app confirm dialog in place of the browser's: `if (!(await confirm({ title, action }))) return;`. Escape and the backdrop answer no. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ o: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const ask = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ o, resolve })), []);
  const answer = (v: boolean) => {
    pending?.resolve(v);
    setPending(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Modal open={!!pending} onClose={() => answer(false)} title={pending?.o.title ?? ""} width={440}>
        {pending?.o.body ? <div className="text-[13.5px] leading-relaxed text-mist">{pending.o.body}</div> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => answer(false)}>{pending?.o.cancel ?? "Cancel"}</Button>
          <Button variant={pending?.o.tone === "danger" ? "danger" : "primary"} autoFocus onClick={() => answer(true)}>{pending?.o.action ?? "Confirm"}</Button>
        </div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmCtx);
}

// ---- table ------------------------------------------------------------------
export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Sortable by this key. What sorting means (server or client) is the page's business. */
  sortable?: boolean;
  align?: "left" | "right";
  className?: string;
  width?: string;
}
export interface Sort {
  key: string;
  dir: "asc" | "desc";
}

/** The one table. Sortable headers announce their state; the page owns the sort and the rows. */
export function Table<T>({ columns, rows, rowKey, sort, onSort, rowClassName, minWidth, caption }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; sort?: Sort | null; onSort?: (s: Sort) => void; rowClassName?: (row: T) => string | undefined; minWidth?: number; caption?: string }) {
  const pad = (i: number) => (i === 0 ? "pl-4 pr-3" : i === columns.length - 1 ? "pl-3 pr-4" : "px-3");
  const toggle = (key: string) => onSort?.(sort?.key === key ? { key, dir: sort.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" });
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full text-[13px]" style={minWidth ? { minWidth } : undefined}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className="bg-slate-1 text-left text-[11.5px] text-fog">
          <tr>
            {columns.map((c, i) => {
              const active = sort?.key === c.key;
              return (
                <th key={c.key} scope="col" style={c.width ? { width: c.width } : undefined} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined} className={`py-2.5 font-medium ${pad(i)} ${c.align === "right" ? "text-right" : ""}`}>
                  {c.sortable && onSort ? (
                    <button type="button" onClick={() => toggle(c.key)} className={`inline-flex items-center gap-1 whitespace-nowrap hover:text-snow ${active ? "text-snow" : ""}`}>
                      {c.header}
                      {active ? sort.dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} /> : <ChevronsUpDown size={12} className="text-ash" />}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={rowKey(r)} className={rowClassName?.(r) ?? "hover:bg-slate-1"}>
              {columns.map((c, i) => (
                <td key={c.key} className={`py-2.5 ${pad(i)} ${c.align === "right" ? "text-right" : ""} ${c.className ?? ""}`}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Client-side sorting for a table whose rows are all in hand. Nulls sort last either way. */
export function sortRows<T>(rows: T[], sort: Sort | null | undefined, value: (row: T, key: string) => string | number | null | undefined): T[] {
  if (!sort) return rows;
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = value(a, sort.key);
    const y = value(b, sort.key);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
  });
}

// ---- tooltip ----------------------------------------------------------------
/** A label beside its child on hover or focus. Rendered at body level, so a scrolling or clipped parent cannot hide it. */
export function Tooltip({ label, side = "right", children }: { label: string; side?: "right" | "bottom"; children: ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef(0);
  const show = (el: HTMLElement) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      setPos(side === "right" ? { x: r.right + 8, y: r.top + r.height / 2 } : { x: r.left + r.width / 2, y: r.bottom + 8 });
    }, 120);
  };
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setPos(null);
  }, []);
  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pos, hide]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <span className="block" onMouseEnter={(e) => show(e.currentTarget)} onMouseLeave={hide} onFocus={(e) => show(e.currentTarget)} onBlur={hide}>
      {children}
      {pos
        ? createPortal(
            <span role="tooltip" className="pointer-events-none fixed z-[70] whitespace-nowrap rounded-md border border-line-2 bg-slate-2 px-2 py-1 text-[12px] text-snow shadow-lg" style={{ left: pos.x, top: pos.y, transform: side === "right" ? "translateY(-50%)" : "translateX(-50%)" }}>
              {label}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

// ---- menu -------------------------------------------------------------------
const MenuClose = createContext<() => void>(() => {});

/** A button that opens a small menu under itself. Escape, a click outside, a resize or choosing an item closes it; arrow keys move between items. */
export function Menu({ button, label, children, align = "end", width = 240, className = "" }: { button: ReactNode; label: string; children: ReactNode; align?: "start" | "end"; width?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const toggle = () => {
    if (open) return close();
    const r = trigger.current!.getBoundingClientRect();
    const left = align === "end" ? r.right - width : r.left;
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(left, window.innerWidth - width - 8)) });
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const items = () => [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="radio"]') ?? [])];
    items()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        trigger.current?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const list = items();
        if (!list.length) return;
        e.preventDefault();
        const i = list.indexOf(document.activeElement as HTMLElement);
        list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]!.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !trigger.current?.contains(t)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);
  return (
    <MenuClose.Provider value={close}>
      <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={toggle} className={`inline-flex items-center justify-center rounded-full ${className}`}>
        {button}
      </button>
      {open
        ? createPortal(
            <motion.div ref={panel} role="menu" aria-label={label} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.12 }} className="fixed z-50 rounded-xl border border-line-2 bg-slate-1 p-1.5 shadow-2xl" style={{ top: pos.top, left: pos.left, width }}>
              {children}
            </motion.div>,
            document.body,
          )
        : null}
    </MenuClose.Provider>
  );
}

export function MenuItem({ icon, children, onSelect, tone = "default" }: { icon?: ReactNode; children: ReactNode; onSelect: () => void; tone?: "default" | "danger" }) {
  const close = useContext(MenuClose);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        close();
        onSelect();
      }}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] focus:outline-none focus-visible:bg-slate-2 ${tone === "danger" ? "text-rose-400 hover:bg-rose-600/10" : "text-mist hover:bg-slate-2 hover:text-snow"}`}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="px-2.5 py-2">{children}</div>;
}

export function MenuSeparator() {
  return <div role="separator" className="my-1.5 border-t border-line" />;
}

// ---- segmented control ------------------------------------------------------
/** One choice among a few, shown as adjoining buttons. A radio group to assistive technology. */
export function Segmented<T extends string>({ value, onChange, options, label, size = "md", className = "" }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: ReactNode }[]; label: string; size?: "sm" | "md"; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={`inline-flex items-center gap-1 rounded-lg border border-line bg-ink-2 p-1 ${className}`}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)} className={`inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md transition-colors ${size === "sm" ? "h-7 px-2 text-[12.5px]" : "h-8 px-3 text-[13px]"} ${value === o.value ? "bg-slate-3 text-snow" : "text-fog hover:text-snow"}`}>
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`inline-block h-5 w-5 animate-spin rounded-full border-2 border-fog border-t-transparent ${className}`} />;
}

/** A list of short values typed as chips: Enter, comma or Tab adds one; Backspace on empty removes the last. */
export function TagInput({ value, onChange, placeholder, suggestions = [], mono = true, id }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; suggestions?: string[]; mono?: boolean; id?: string }) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const v = raw.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setDraft("");
  };
  const listId = id ? `${id}-suggestions` : undefined;
  return (
    <div className="flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-lg border border-line-2 bg-ink-2 px-2 py-1.5 focus-within:border-teal-400">
      {value.map((v) => (
        <span key={v} className={`inline-flex items-center gap-1 rounded-md bg-slate-3 px-2 py-0.5 text-[12px] text-snow ${mono ? "font-mono" : ""}`}>
          {v}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== v))} className="text-fog hover:text-rose-400" aria-label={`Remove ${v}`}>
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        id={id}
        list={listId}
        value={draft}
        onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value.slice(0, -1)) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === "Tab") && draft.trim()) {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => draft.trim() && add(draft)}
        placeholder={value.length ? "" : placeholder}
        className={`min-w-[8rem] flex-1 bg-transparent px-1 text-[13px] text-snow placeholder:text-ash focus:outline-none ${mono ? "font-mono" : ""}`}
      />
      {listId && suggestions.length ? <datalist id={listId}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist> : null}
    </div>
  );
}

/**
 * How a number is worked out, behind a small "?" beside its label. Opens on
 * hover, on focus and on a tap (phones have no hover), closes on Escape, on a
 * tap elsewhere, when focus leaves and when the pointer moves away. Placed so
 * it stays on screen.
 */
export function Hint({ label, children }: { label: string; children: ReactNode }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  const W = 256;
  // Drawn in a portal at a fixed place under the button, kept inside the window: a panel that clips its overflow cannot cut it off.
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - W / 2), window.innerWidth - W - 8);
    setAt({ top: r.bottom + 6, left });
  };
  const hide = () => setAt(null);
  useEffect(() => {
    if (!at) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) hide();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [at]);
  return (
    <span ref={ref} className="inline-flex align-middle" onMouseEnter={show} onMouseLeave={hide}>
      <button
        type="button"
        aria-label={`How ${label} is worked out`}
        aria-describedby={at ? id : undefined}
        // A tap focuses the button (which opens it) and then clicks it: the click must not close it again.
        onClick={show}
        onFocus={show}
        onBlur={hide}
        className="ml-1 inline-flex rounded-full text-ash hover:text-mist focus:outline-none focus-visible:text-snow focus-visible:ring-1 focus-visible:ring-teal-400"
      >
        <CircleHelp size={12} aria-hidden="true" />
      </button>
      {at
        ? createPortal(
            <span role="tooltip" id={id} style={{ top: at.top, left: at.left, width: W }} className="pointer-events-none fixed z-[70] rounded-lg border border-line-2 bg-ink-2 p-2.5 text-left text-[12px] font-normal normal-case leading-snug tracking-normal text-mist shadow-xl">
              {children}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
