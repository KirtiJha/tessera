import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

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
    <section className={`rounded-xl border border-line bg-slate-1 ${className}`}>
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
        <motion.div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          <motion.div role="dialog" aria-modal="true" aria-label={title} className="w-full rounded-2xl border border-line-2 bg-slate-1 shadow-2xl" style={{ maxWidth: width }} initial={{ y: 12, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 8, scale: 0.98 }} transition={{ duration: 0.2 }}>
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
            <motion.div key={t.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} className={`rounded-lg border px-4 py-2.5 text-[13px] shadow-lg ${t.tone === "error" ? "border-rose-600/60 bg-[#2a1a1e] text-rose-400" : t.tone === "info" ? "border-line-2 bg-slate-2 text-snow" : "border-teal-700 bg-[#122826] text-teal-300"}`}>
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

export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`inline-block h-5 w-5 animate-spin rounded-full border-2 border-fog border-t-transparent ${className}`} />;
}
