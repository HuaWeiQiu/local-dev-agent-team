import type { CliInventory, RoleBindingInput } from "../types";
import { cn } from "../ui/cn";
import { COLUMNS, RoleRow } from "./role-binding/sections";

export { applyRolePatch } from "./role-binding/model";

export function RoleBindingEditor({
  roles,
  roleNames,
  inventory,
  disabled,
  sources,
  onChange,
  onClear,
}: {
  roles: Record<string, RoleBindingInput>;
  roleNames: string[];
  inventory?: CliInventory;
  disabled?: boolean;
  sources?: Record<string, "global" | "project">;
  onChange(role: string, patch: Partial<RoleBindingInput>): void;
  onClear?(role: string): void;
}) {

  return (
    <div className="role-default-grid bd divide-y overflow-hidden rounded-lg bg-surface">
      <div className={cn("hidden px-3 py-2 text-2xs font-medium text-muted md:grid md:gap-3", COLUMNS)}>
        <span>角色</span>
        <span>Agent CLI</span>
        <span>模型</span>
        <span>思考深度</span>
      </div>
      {roleNames.map((role) => (
        <RoleRow
          key={role}
          role={role}
          roles={roles}
          inventory={inventory}
          disabled={Boolean(disabled)}
          source={sources?.[role] ?? "global"}
          showSources={Boolean(sources)}
          onChange={onChange}
          onClear={onClear}
        />
      ))}
    </div>
  );
}
