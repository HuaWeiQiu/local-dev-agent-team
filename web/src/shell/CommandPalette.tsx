import { Command } from "cmdk";
import type { ReactNode } from "react";
import { Kbd } from "../ui/kbd";

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  keywords?: string[];
  run(): void;
}

export interface PaletteGroup {
  heading: string;
  items: PaletteItem[];
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  groups: PaletteGroup[];
}

export function CommandPalette({ open, onOpenChange, groups }: CommandPaletteProps) {
  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="命令面板"
      overlayClassName="fixed inset-0 z-[80] bg-scrim backdrop-blur-[2px]"
      contentClassName="bd fixed left-1/2 top-[14vh] z-[81] w-[min(600px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl bg-surface shadow-modal"
    >
      <Command.Input
        placeholder="搜索运行、页面或操作…"
        className="bd-b h-12 w-full border-0 bg-transparent px-4 text-base text-ink outline-none placeholder:text-muted"
      />
      <Command.List className="scroll-thin max-h-[min(52vh,420px)] overflow-y-auto p-1.5">
        <Command.Empty className="px-3 py-8 text-center text-sm text-muted">没有匹配的结果</Command.Empty>
        {groups
          .filter((group) => group.items.length > 0)
          .map((group) => (
            <Command.Group
              key={group.heading}
              heading={group.heading}
              className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted"
            >
              {group.items.map((item) => (
                <Command.Item
                  key={item.id}
                  value={`${item.label} ${item.hint ?? ""} ${(item.keywords ?? []).join(" ")}`}
                  onSelect={() => {
                    onOpenChange(false);
                    item.run();
                  }}
                  className="flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm text-ink aria-selected:bg-accent-soft aria-selected:text-accent-ink [&_svg]:size-4 [&_svg]:text-muted aria-selected:[&_svg]:text-accent-ink"
                >
                  {item.icon}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="shrink-0 truncate text-xs text-muted">{item.hint}</span>}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
      </Command.List>
      <footer className="bd-t flex items-center gap-3 bg-surface-2 px-3.5 py-2 text-2xs text-muted">
        <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd>选择</span>
        <span className="flex items-center gap-1"><Kbd>↵</Kbd>打开</span>
        <span className="flex items-center gap-1"><Kbd>Esc</Kbd>关闭</span>
      </footer>
    </Command.Dialog>
  );
}
