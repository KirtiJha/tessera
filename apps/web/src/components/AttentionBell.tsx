import { Bell, CircleAlert, MessageCircleQuestion, PiggyBank } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAttention, type AttentionItem } from "../lib/attention";
import { ago } from "../lib/format";
import { Menu, MenuHeading, MenuItem, MenuSeparator } from "./ui";

const ICON: Record<AttentionItem["kind"], typeof Bell> = { waiting: MessageCircleQuestion, failed: CircleAlert, budget: PiggyBank };
const TONE: Record<AttentionItem["kind"], string> = { waiting: "text-amber-400", failed: "text-rose-400", budget: "text-violet-400" };
const GROUP: Record<AttentionItem["kind"], string> = { waiting: "Waiting on someone", failed: "Agents failed", budget: "Budgets" };

/** The bell: everything that needs a person right now, from the live fleet. Opening it refreshes the budget statuses. */
export function AttentionBell({ now }: { now: number }) {
  const [opened, setOpened] = useState(0);
  const items = useAttention(opened);
  const nav = useNavigate();
  const worst = items.some((i) => i.kind === "failed" || (i.kind === "budget" && i.title.includes("hard"))) ? "bg-rose-400 text-white" : items.some((i) => i.kind === "waiting") ? "bg-amber-400 text-ink" : "bg-slate-3 text-snow";
  const label = items.length ? `${items.length} item${items.length === 1 ? " needs" : "s need"} attention` : "Nothing needs attention";
  let lastKind: AttentionItem["kind"] | null = null;
  return (
    <span onClickCapture={() => setOpened((n) => n + 1)}>
      <Menu
        label={label}
        width={380}
        className="relative h-9 w-9 text-mist hover:bg-slate-2 hover:text-snow"
        button={
          <>
            <Bell size={18} />
            {items.length ? <span className={`absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10.5px] font-semibold ${worst}`}>{items.length > 99 ? "99+" : items.length}</span> : null}
          </>
        }
      >
        <MenuHeading>
          <div className="text-[13px] font-medium text-snow">Needs attention</div>
          <div className="text-[12px] text-fog">{items.length ? "Live: an item goes away as soon as it is dealt with." : "Nothing is waiting on a person, no agent has failed, and no budget is over."}</div>
        </MenuHeading>
        {items.slice(0, 30).map((item) => {
          const Icon = ICON[item.kind];
          const heading = item.kind !== lastKind ? <div className="mt-1.5 px-2.5 pb-1 text-[11px] font-medium text-ash">{GROUP[item.kind]}</div> : null;
          lastKind = item.kind;
          return (
            <div key={item.id}>
              {heading ? (
                <>
                  <MenuSeparator />
                  {heading}
                </>
              ) : null}
              <MenuItem icon={<Icon size={15} className={`mt-0.5 shrink-0 self-start ${TONE[item.kind]}`} />} onSelect={() => nav(item.href)}>
                <span className="block truncate text-[13px] text-snow">{item.title}</span>
                <span className="block truncate text-[12px] text-fog">{item.detail}</span>
                {item.since ? <span className="block text-[11px] text-ash">{ago(item.since, now)}</span> : null}
              </MenuItem>
            </div>
          );
        })}
        {items.length > 30 ? <div className="px-2.5 py-2 text-[12px] text-fog">and {items.length - 30} more on the wall</div> : null}
      </Menu>
    </span>
  );
}
