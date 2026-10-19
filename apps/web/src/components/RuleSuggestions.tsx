import type { RuleSuggestion } from "@tessera/contract";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { ago } from "../lib/format";
import { Button, Panel, useToast } from "./ui";

/**
 * Prompts people keep approving, offered as allow rules. Adding one ends those
 * prompts for everyone: Claude Code is told the call is allowed, while every
 * deny and ask rule above it still wins.
 */
export function RuleSuggestions({ version, disabled, onApplied }: { version: number; disabled: boolean; onApplied: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<RuleSuggestion[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    void api.get<{ suggestions: RuleSuggestion[] }>("/api/admin/policy/suggestions").then((r) => setItems(r.suggestions)).catch(() => setItems([]));
  }, [version]);
  if (!items?.length) return null;
  const apply = async (s: RuleSuggestion) => {
    setBusy(s.key);
    try {
      const r = await api.post<{ version: number }>("/api/admin/policy/suggestions/apply", { tool: s.tool, content: s.content, baseVersion: version });
      toast(`${s.key} is allowed without asking. Version ${r.version} is in force.`);
      onApplied();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not add that rule.", "error");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Panel title={<span className="inline-flex items-center gap-2"><Sparkles size={15} className="text-teal-300" /> Prompts people keep approving</span>} className="mt-4">
      <p className="mb-3 text-[12.5px] text-fog">Asked about at least five times in the last 30 days and never denied here. Allowing one stops these prompts for everyone; your deny and ask rules above still take precedence. {disabled ? "Save or discard your edits first." : ""}</p>
      <ul className="divide-y divide-line">
        {items.map((s) => (
          <li key={s.key} className="flex flex-wrap items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[13px] text-snow" title={s.key}>{s.key}</div>
              <div className="truncate text-[12px] text-fog" title={s.example}>
                asked {s.asked}×{s.allowedHere ? `, allowed here ${s.allowedHere}×` : ""} by {s.people} {s.people === 1 ? "person" : "people"} · last {ago(s.last)} · e.g. {s.example}
              </div>
            </div>
            <Button size="sm" disabled={disabled} loading={busy === s.key} onClick={() => void apply(s)}>Always allow</Button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
