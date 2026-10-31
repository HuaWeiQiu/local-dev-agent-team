// @vitest-environment jsdom
import "./web/dom-setup.js";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RoleBindingEditor, applyRolePatch } from "../web/src/components/RoleBindingEditor.js";
import {
  FALLBACK_BINDING,
  bindingFor,
  cliIndex,
  cliOptionDisabled,
  cliOptionNote,
  modelChoices,
  reasoningOptions,
  sourceLabel,
} from "../web/src/components/role-binding/model.js";
import type { CliInventory, RoleBindingInput } from "../web/src/types.js";

function inventory(): CliInventory {
  return {
    clis: [
      {
        id: "codex",
        installed: true,
        runtimeSupported: true,
        defaultModel: "gpt-5",
        defaultReasoning: "medium",
        models: [{ id: "gpt-5", label: "GPT-5", reasoningOptions: ["low", "medium", "high"] }],
      },
      {
        id: "grok",
        installed: false,
        runtimeSupported: true,
        models: [],
      },
      {
        id: "kimi",
        installed: true,
        runtimeSupported: false,
        models: [{ id: "kimi-k2", label: "Kimi K2", reasoningOptions: ["low", "high"] }],
      },
    ],
  } as unknown as CliInventory;
}

describe("role binding model", () => {
  it("indexes the CLIs and reads a binding", () => {
    expect(cliIndex(inventory()).size).toBe(3);
    expect(cliIndex(undefined).size).toBe(0);
    expect(bindingFor({}, "worker")).toEqual(FALLBACK_BINDING);
    const binding: RoleBindingInput = { cli: "codex", model: "gpt-5", reasoning: "high" };
    expect(bindingFor({ worker: binding }, "worker")).toBe(binding);
  });

  it("resolves reasoning options from the model, the CLI or the default set", () => {
    const clis = cliIndex(inventory());
    expect(reasoningOptions(clis.get("codex"), "gpt-5")).toEqual(["low", "medium", "high"]);
    expect(reasoningOptions(clis.get("codex"), "other")).toEqual(["low", "medium", "high"]);
    expect(reasoningOptions(undefined, undefined)).toEqual(["low", "medium", "high"]);
  });

  it("offers models with the current value as the fallback", () => {
    const clis = cliIndex(inventory());
    expect(modelChoices(clis.get("codex"), undefined)).toHaveLength(1);
    expect(modelChoices(undefined, "custom")).toEqual([{ id: "custom", label: "custom" }]);
    expect(modelChoices(undefined, undefined)).toEqual([{ id: "default", label: "default" }]);
  });

  it("describes an unusable CLI option", () => {
    const clis = cliIndex(inventory());
    expect(cliOptionNote(clis.get("grok"))).toBe("（未安装）");
    expect(cliOptionNote(clis.get("kimi"))).toBe("（暂不可调用）");
    expect(cliOptionNote(clis.get("codex"))).toBe("");
    expect(cliOptionDisabled(clis.get("grok"))).toBe(true);
    expect(cliOptionDisabled(clis.get("kimi"))).toBe(true);
    expect(cliOptionDisabled(clis.get("codex"))).toBe(false);
    expect(sourceLabel("project")).toBe("项目");
    expect(sourceLabel("global")).toBe("全局");
  });
});

describe("applyRolePatch", () => {
  it("merges a patch over the current binding", () => {
    const next = applyRolePatch({}, "worker", { cli: "codex" }, inventory());
    expect(next.worker).toMatchObject({ cli: "codex", model: "gpt-5", reasoning: "medium" });
  });

  it("keeps the model when the CLI does not change", () => {
    const current = { worker: { cli: "codex", model: "keep", reasoning: "low" } as RoleBindingInput };
    const next = applyRolePatch(current, "worker", { reasoning: "high" }, inventory());
    expect(next.worker).toMatchObject({ model: "keep", reasoning: "high" });
  });

  it("falls back to the first model's reasoning when the CLI has no default", () => {
    const next = applyRolePatch({}, "worker", { cli: "kimi" }, inventory());
    expect(next.worker).toMatchObject({ model: "kimi-k2", reasoning: "low" });
  });

  it("keeps the binding untouched for an unknown CLI", () => {
    const next = applyRolePatch({}, "worker", { cli: "ghost" as never }, inventory());
    expect(next.worker).toEqual({ ...FALLBACK_BINDING, cli: "ghost" });
  });
});

describe("RoleBindingEditor", () => {
  function props(patch: Record<string, unknown> = {}) {
    return {
      roles: {},
      roleNames: ["worker"],
      inventory: inventory(),
      disabled: false,
      onChange: vi.fn(),
      ...patch,
    } as never;
  }

  it("renders a row per role with three selects", () => {
    render(<RoleBindingEditor {...(props() as object)} />);
    expect(screen.getByText("执行")).toBeTruthy();
    expect(screen.getAllByRole("combobox")).toHaveLength(3);
    expect(screen.getByRole("option", { name: /Grok（未安装）/ })).toBeDisabled();
    expect(screen.getByRole("option", { name: /Kimi（暂不可调用）/ })).toBeDisabled();
  });

  it("reports a CLI change", async () => {
    const onChange = vi.fn();
    render(<RoleBindingEditor {...(props({ onChange }) as object)} />);
    await userEvent.selectOptions(screen.getAllByRole("combobox")[0]!, "codex");
    expect(onChange).toHaveBeenCalledWith("worker", { cli: "codex" });
  });

  it("shows the source badge and the reset button for a project override", async () => {
    const onClear = vi.fn();
    render(
      <RoleBindingEditor
        {...(props({ sources: { worker: "project" }, onClear }) as object)}
      />,
    );
    expect(screen.getByText("项目")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "恢复全局" }));
    expect(onClear).toHaveBeenCalledWith("worker");
  });

  it("hides the badge when no sources are given", () => {
    render(<RoleBindingEditor {...(props() as object)} />);
    expect(screen.queryByText("全局")).toBeNull();
  });
});
