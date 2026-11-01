// @vitest-environment jsdom
import "./dom-setup.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OnboardingWizard, parseCommandLine } from "../../web/src/components/OnboardingWizard.js";
import { selectedCommands } from "../../web/src/components/onboarding/commands.js";
import type { OnboardingStatus } from "../../web/src/types.js";
import { OnboardingWizard as BaselineWizard } from "./baseline/OnboardingWizard.baseline.js";

function status(patch: Partial<OnboardingStatus> = {}): OnboardingStatus {
  return {
    projectId: "p",
    projectName: "demo",
    source: "detected",
    configPath: "/repo/agent-team.yaml",
    needsSetup: true,
    detection: {
      root: "/repo",
      name: "demo",
      isGitRepo: true,
      defaultBranch: "main",
      ecosystems: ["node"],
      packageManager: "pnpm",
      commands: [
        { role: "typecheck", label: "pnpm run check", command: { command: "pnpm", args: ["run", "check"] }, source: "package.json scripts.check", selected: true },
        { role: "test", label: "pnpm run test", command: { command: "pnpm", args: ["run", "test"] }, source: "package.json scripts.test", selected: true },
        { role: "build", label: "pnpm run build", command: { command: "pnpm", args: ["run", "build"] }, source: "package.json scripts.build", selected: false },
      ],
    },
    current: { commands: [] },
    clis: [{ id: "codex", installed: true, runtimeSupported: true, version: "1.2.3", authStatus: "present" }],
    recommendedCli: "codex",
    ...patch,
  };
}

describe("parseCommandLine", () => {
  it("splits on whitespace and never builds a shell string", () => {
    expect(parseCommandLine("  make   verify  ")).toEqual({ command: "make", args: ["verify"] });
    expect(parseCommandLine("   ")).toBeUndefined();
  });
});

describe("selectedCommands", () => {
  it("keeps detection order and appends the extra line only when it parsed", () => {
    const { detection } = status();
    expect(selectedCommands(detection, new Set([2, 0]), undefined)).toEqual([
      { command: "pnpm", args: ["run", "check"] },
      { command: "pnpm", args: ["run", "build"] },
    ]);
    expect(selectedCommands(detection, new Set(), { command: "make", args: ["verify"] })).toEqual([
      { command: "make", args: ["verify"] },
    ]);
  });
});

describe("OnboardingWizard", () => {
  it("saves the pre-selected detected commands plus a custom one", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<OnboardingWizard open status={status()} busy={false} error={undefined} onSave={onSave} onSkip={vi.fn()} />);

    expect(screen.getByText("默认使用")).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([true, true, false]);

    await user.click(boxes[2]!);
    await user.click(boxes[0]!);
    await user.type(screen.getByLabelText("额外命令"), "make verify");
    await user.click(screen.getByRole("button", { name: "保存到 agent-team.yaml" }));

    expect(onSave).toHaveBeenCalledWith([
      { command: "pnpm", args: ["run", "test"] },
      { command: "pnpm", args: ["run", "build"] },
      { command: "make", args: ["verify"] },
    ]);
  });

  it("skips without saving and warns when no CLI is installed", async () => {
    const onSkip = vi.fn();
    const onSave = vi.fn();
    const user = userEvent.setup();
    const empty = status({ clis: [], detection: { ...status().detection, commands: [] } });
    render(<OnboardingWizard open status={empty} busy={false} error="boom" onSave={onSave} onSkip={onSkip} />);

    expect(screen.getByText(/未检测到可用的/)).toBeTruthy();
    expect(screen.getByText(/没有从仓库中检测到/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("boom");
    await user.click(screen.getByRole("button", { name: "先用默认值" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("preselects the configured commands once agent-team.yaml exists", () => {
    render(
      <OnboardingWizard
        open
        status={status({ source: "file", needsSetup: false, current: { commands: [{ command: "pnpm", args: ["run", "build"] }] } })}
        busy={false}
        error={undefined}
        onSave={vi.fn()}
        onSkip={vi.fn()}
      />,
    );
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([false, false, true]);
  });
});

/* ------------------------------------------------------------------------- *
 * Differential proof that the split is render-identical.
 *
 * The bodies moved into `onboarding/panels.tsx`, but the markup must not have
 * moved with them. Each state below is rendered twice with identical props:
 * once by the frozen pre-split component (test/web/baseline/…baseline.tsx,
 * taken verbatim from `git show HEAD:web/src/components/OnboardingWizard.tsx`)
 * and once by the split one. The comparison is on the DOM the modal actually
 * produces — Radix portals it into `document.body`, so the render container
 * stays empty and `document.body.innerHTML` is the real output.
 *
 * Element order, element counts, text, class names and aria attributes are all
 * part of the compared string, so any of them drifting fails the state.
 * ------------------------------------------------------------------------- */

interface WizardProps {
  open: boolean;
  status: OnboardingStatus | undefined;
  busy: boolean;
  error: string | undefined;
  onSave(commands: Array<{ command: string; args: string[] }>): Promise<boolean>;
  onSkip(): void;
}

type WizardComponent = (props: WizardProps) => ReturnType<typeof BaselineWizard>;

interface WizardState {
  name: string;
  props: WizardProps;
  /** Whether this state is supposed to have a dialog in the document at all. */
  dialog: boolean;
  /** Markup that must appear on both sides, so an empty comparison cannot pass. */
  anchors?: string[];
  /** Interaction to run before the markup is captured, for input and click states. */
  after?(view: { user: ReturnType<typeof userEvent.setup>; show(props: WizardProps): void }): Promise<void>;
}

/**
 * React derives node ids per render (`radix-_r_0_`), so two renders of the same
 * markup legitimately differ in those tokens and nowhere else.
 */
function normalize(html: string): string {
  return html.replace(/radix-_r_[0-9a-z]+_/g, "radix-id");
}

async function capture(Component: WizardComponent, state: WizardState): Promise<string> {
  const user = userEvent.setup();
  const view = render(<Component {...state.props} />);
  if (state.after) {
    await state.after({ user, show: (props) => view.rerender(<Component {...props} />) });
  }
  const html = normalize(document.body.innerHTML);
  cleanup();
  return html;
}

/** First divergence with context, or the empty string when the two are identical. */
function compareHtml(baseline: string, candidate: string): string {
  if (baseline === candidate) return "";
  let offset = 0;
  while (offset < baseline.length && offset < candidate.length && baseline[offset] === candidate[offset]) {
    offset += 1;
  }
  const from = Math.max(0, offset - 90);
  return [
    `first difference at offset ${offset} (baseline ${baseline.length} chars, candidate ${candidate.length} chars)`,
    `baseline: …${baseline.slice(from, offset + 130)}…`,
    `candidate: …${candidate.slice(from, offset + 130)}…`,
  ].join("\n");
}

const richAnchors = ['aria-label="仓库"', 'aria-label="已检测到的 CLI"', 'aria-label="质量命令"'];

const STATES: WizardState[] = [
  {
    name: "detected defaults",
    dialog: true,
    anchors: [...richAnchors, "已检测到的 Agent CLI", "默认使用", "测试", "保存到 agent-team.yaml", "先用默认值"],
    props: { open: true, status: status(), busy: false, error: undefined, onSave: async () => true, onSkip: () => undefined },
  },
  {
    name: "agent-team.yaml already lists commands",
    dialog: true,
    anchors: [...richAnchors, "pnpm run build"],
    props: {
      open: true,
      status: status({ source: "file", needsSetup: false, current: { commands: [{ command: "pnpm", args: ["run", "build"] }] } }),
      busy: false,
      error: undefined,
      onSave: async () => true,
      onSkip: () => undefined,
    },
  },
  {
    name: "no CLI, no commands, error",
    dialog: true,
    anchors: [...richAnchors, "未检测到可用的", "没有从仓库中检测到", 'role="alert"', "boom"],
    props: {
      open: true,
      status: status({ clis: [], detection: { ...status().detection, commands: [] } }),
      busy: false,
      error: "boom",
      onSave: async () => true,
      onSkip: () => undefined,
    },
  },
  {
    name: "submitting",
    dialog: true,
    anchors: [...richAnchors, "正在保存", "disabled"],
    props: { open: true, status: status(), busy: true, error: undefined, onSave: async () => true, onSkip: () => undefined },
  },
  {
    name: "closed",
    dialog: false,
    props: { open: false, status: status(), busy: false, error: undefined, onSave: async () => true, onSkip: () => undefined },
  },
  {
    name: "no status yet",
    dialog: false,
    props: { open: true, status: undefined, busy: false, error: undefined, onSave: async () => true, onSkip: () => undefined },
  },
  {
    name: "CLI flags: unsupported, unauthenticated, recommended, hidden",
    dialog: true,
    anchors: [...richAnchors, "不可调用", "未登录", "默认使用", "Kimi", "9.9"],
    props: {
      open: true,
      status: status({
        clis: [
          { id: "codex", installed: true, runtimeSupported: false, authStatus: "missing" },
          { id: "kimi", installed: true, runtimeSupported: true, version: "9.9", authStatus: "present" },
          { id: "grok", installed: false, runtimeSupported: true, version: "0.1", authStatus: "invalid" },
        ],
        recommendedCli: "kimi",
      }),
      busy: false,
      error: undefined,
      onSave: async () => true,
      onSkip: () => undefined,
    },
  },
  {
    name: "labels fall back for a CLI and a role this build does not know",
    dialog: true,
    anchors: [...richAnchors, "custom-cli", "audit"],
    props: {
      open: true,
      status: status({
        clis: [{ id: "custom-cli", installed: true, runtimeSupported: true, authStatus: "unknown" }],
        recommendedCli: undefined,
        detection: {
          ...status().detection,
          defaultBranch: undefined,
          ecosystems: [],
          commands: [
            { role: "audit" as OnboardingStatus["detection"]["commands"][number]["role"], label: "x", command: { command: "make", args: ["audit"] }, source: "Makefile", selected: true },
          ],
        },
      }),
      busy: false,
      error: undefined,
      onSave: async () => true,
      onSkip: () => undefined,
    },
  },
  {
    name: "extra command typed",
    dialog: true,
    anchors: [...richAnchors, 'value="make verify"', "例如：make verify"],
    props: { open: true, status: status(), busy: false, error: undefined, onSave: async () => true, onSkip: () => undefined },
    after: async ({ user }) => {
      await user.type(screen.getByLabelText("额外命令"), "make verify");
    },
  },
  {
    name: "extra command is whitespace only",
    dialog: true,
    anchors: [...richAnchors, "例如：make verify"],
    props: { open: true, status: status(), busy: false, error: undefined, onSave: async () => true, onSkip: () => undefined },
    after: async ({ user }) => {
      await user.type(screen.getByLabelText("额外命令"), "   ");
    },
  },
  {
    name: "extra command is long",
    dialog: true,
    anchors: [...richAnchors, "make"],
    props: { open: true, status: status(), busy: false, error: undefined, onSave: async () => true, onSkip: () => undefined },
    after: async ({ user }) => {
      await user.type(screen.getByLabelText("额外命令"), `make ${"very-long-target ".repeat(12).trim()}`);
    },
  },
  {
    name: "checkboxes toggled both ways",
    dialog: true,
    anchors: [...richAnchors, "pnpm run build"],
    props: { open: true, status: status(), busy: false, error: undefined, onSave: async () => true, onSkip: () => undefined },
    after: async ({ user }) => {
      const boxes = screen.getAllByRole("checkbox");
      await user.click(boxes[2]!);
      await user.click(boxes[0]!);
    },
  },
  {
    name: "save clicked, then resolves into the idle state",
    dialog: true,
    anchors: [...richAnchors, "保存到 agent-team.yaml"],
    props: {
      open: true,
      status: status(),
      busy: true,
      error: undefined,
      onSave: async () => true,
      onSkip: () => undefined,
    },
    after: async ({ user, show }) => {
      await user.click(screen.getByRole("button", { name: "正在保存" }));
      show({ open: true, status: status(), busy: false, error: undefined, onSave: async () => true, onSkip: () => undefined });
    },
  },
  {
    name: "skip clicked",
    dialog: true,
    anchors: [...richAnchors, "先用默认值"],
    props: { open: true, status: status(), busy: false, error: undefined, onSave: async () => true, onSkip: () => undefined },
    after: async ({ user }) => {
      await user.click(screen.getByRole("button", { name: "先用默认值" }));
    },
  },
  {
    name: "reopened on a new status, resetting ticks and the extra command",
    dialog: true,
    anchors: [...richAnchors, "pnpm run build"],
    props: { open: true, status: status(), busy: false, error: undefined, onSave: async () => true, onSkip: () => undefined },
    after: async ({ user, show }) => {
      await user.type(screen.getByLabelText("额外命令"), "make verify");
      await user.click(screen.getAllByRole("checkbox")[2]!);
      show({
        open: true,
        status: status({ source: "file", current: { commands: [{ command: "pnpm", args: ["run", "build"] }] } }),
        busy: false,
        error: undefined,
        onSave: async () => true,
        onSkip: () => undefined,
      });
    },
  },
];

describe("OnboardingWizard — the split renders exactly what the pre-split component rendered", () => {
  it.each(STATES.map((state) => [state.name, state] as const))("%s", async (_name, state) => {
    const baselineHtml = await capture(BaselineWizard, state);
    const candidateHtml = await capture(OnboardingWizard, state);

    if (!state.dialog) {
      expect(candidateHtml).toBe(baselineHtml);
      expect(candidateHtml).not.toContain('role="dialog"');
      return;
    }

    for (const anchor of state.anchors ?? []) {
      expect(candidateHtml, `candidate lost ${anchor}`).toContain(anchor);
      expect(baselineHtml, `baseline lost ${anchor}`).toContain(anchor);
    }
    expect(compareHtml(baselineHtml, candidateHtml)).toBe("");
  });

  it("the comparison would notice a changed class name", async () => {
    const state = STATES[0]!;
    const html = await capture(OnboardingWizard, state);
    expect(html).toContain('class="flex flex-col gap-5"');
    expect(compareHtml(html, html)).toBe("");
    const mutated = html.replace('class="flex flex-col gap-5"', 'class="flex flex-col gap-6"');
    expect(mutated).not.toBe(html);
    expect(compareHtml(html, mutated)).toContain("first difference at offset");
  });
});
