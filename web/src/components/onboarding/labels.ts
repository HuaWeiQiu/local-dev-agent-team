import type { CheckRole } from "../../types";

/**
 * How each detected command role is named in the wizard, in one table instead
 * of a lookup buried inside the row markup — the same shape
 * `stage-stepper/tone.ts` uses for stage states.
 *
 * The roles are exhaustive on purpose: a new role should fail to compile here
 * rather than render as an unlabelled checkbox.
 */
const ROLE_LABEL: Record<CheckRole, string> = {
  typecheck: "类型检查",
  lint: "Lint",
  test: "测试",
  build: "构建",
};

/** The CLI names worth spelling out; anything else shows the detected id. */
const CLI_LABEL: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  kimi: "Kimi",
  grok: "Grok",
};

export function roleLabel(role: CheckRole): string {
  return ROLE_LABEL[role] ?? role;
}

export function cliLabel(id: string): string {
  return CLI_LABEL[id] ?? id;
}
