import { Modal } from "./ui";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl";

const GROUPS: { title: string; keys: [string[], string][] }[] = [
  {
    title: "Anywhere",
    keys: [
      [[`${MOD} K`], "Search: sessions, pages, people, actions"],
      [["?"], "This sheet"],
      [["Esc"], "Close what is open"],
    ],
  },
  {
    title: "Live wall",
    keys: [
      [["←", "→"], "Previous or next card"],
      [["↑", "↓"], "Card above or below"],
      [["J", "K"], "Next or previous card"],
      [["Enter"], "Open the card"],
      [["A"], "Allow once, or approve the plan"],
      [["D"], "Deny, or send the plan back"],
      [["X"], "Select or unselect the card"],
      [["/"], "Filter the wall"],
      [["Esc"], "Clear the selection, then the focus"],
    ],
  },
  {
    title: "Replay",
    keys: [
      [["Space"], "Play or pause"],
      [["←", "→"], "Step back or forward"],
    ],
  },
];

export function Shortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" width={560}>
      <div className="grid gap-5 sm:grid-cols-2">
        {GROUPS.map((g) => (
          <section key={g.title} className={g.title === "Live wall" ? "sm:row-span-2" : ""}>
            <h3 className="text-[12px] font-medium text-ash">{g.title}</h3>
            <dl className="mt-2 space-y-1.5">
              {g.keys.map(([keys, what]) => (
                <div key={what} className="flex items-center justify-between gap-3 text-[13px]">
                  <dt className="text-mist">{what}</dt>
                  <dd className="flex shrink-0 gap-1">
                    {keys.map((k) => (
                      <kbd key={k} className="rounded border border-line-2 bg-ink-2 px-1.5 py-0.5 font-mono text-[11.5px] text-snow">{k}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
