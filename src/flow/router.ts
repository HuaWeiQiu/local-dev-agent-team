import type { FlowSelection, FlowTemplateName } from "./types.js";

export interface RouteInput {
  goal: string;
  /** Explicit operator choice; always wins. */
  override?: FlowTemplateName;
  /** Project default from configuration (`auto` lets the router decide). */
  configured?: FlowTemplateName | "auto";
  evaluation?: boolean;
}

const RISK_PATTERN =
  /\b(migrat\w*|security|auth(?:entication|orization)?|payments?|billing|encrypt\w*|database|schema|breaking|rewrite|refactor|credentials?|secrets?|permissions?)\b|重构|迁移|安全|鉴权|认证|支付|加密|数据库|架构|全面|所有模块|权限|密钥/i;

const SMALL_PATTERN =
  /\b(typos?|renam\w*|comments?|docs?|documentation|readme|changelog|bump|lint|format\w*|wording|copy|spelling)\b|拼写|错别字|注释|文档|重命名|文案|样式|格式化|升级版本/i;

const DELIVERABLE_ID_PATTERN = /\b[TP]\d+(?:\.\d+)?\b/g;
const BULLET_PATTERN = /^\s*(?:[-*•]|\d+[.)、])\s+/gm;

const QUICK_MAX_CHARS = 200;
const FULL_MIN_CHARS = 1_500;
const FULL_MIN_DELIVERABLES = 4;

interface GoalSignals {
  goal: string;
  deliverables: number;
  risk: string | undefined;
  small: string | undefined;
}

function firstMatch(pattern: RegExp, goal: string): string | undefined {
  return pattern.exec(goal)?.[0];
}

function goalSignals(rawGoal: string): GoalSignals {
  const goal = rawGoal.trim();
  return {
    goal,
    deliverables: countDeliverables(goal),
    risk: firstMatch(RISK_PATTERN, goal),
    small: firstMatch(SMALL_PATTERN, goal),
  };
}

/** Operator, evaluation and project-configuration choices win over any heuristic. */
function forcedSelection(input: RouteInput): FlowSelection | undefined {
  if (input.evaluation) {
    return selection("standard", "evaluation", [
      "evolution evaluations always use the standard flow",
    ]);
  }
  if (input.override) return selection(input.override, "user", ["chosen by the operator"]);
  if (input.configured && input.configured !== "auto") {
    return selection(input.configured, "config", ["fixed by the project configuration"]);
  }
  return undefined;
}

function riskSelection(signals: GoalSignals): FlowSelection | undefined {
  if (!signals.risk) return undefined;
  return selection("full", "router", [`touches a sensitive area ("${signals.risk}")`]);
}

function deliverableSelection(signals: GoalSignals): FlowSelection | undefined {
  if (signals.deliverables < FULL_MIN_DELIVERABLES) return undefined;
  return selection("full", "router", [
    `lists ${signals.deliverables} separate deliverables`,
  ]);
}

function lengthSelection(signals: GoalSignals): FlowSelection | undefined {
  if (signals.goal.length < FULL_MIN_CHARS) return undefined;
  return selection("full", "router", [
    `the goal is long (${signals.goal.length} characters)`,
  ]);
}

function isSmallChange(signals: GoalSignals): boolean {
  if (signals.small === undefined) return false;
  return signals.goal.length <= QUICK_MAX_CHARS && signals.deliverables <= 1;
}

function smallChangeSelection(signals: GoalSignals): FlowSelection | undefined {
  if (!isSmallChange(signals)) return undefined;
  return selection("quick", "router", [
    `short goal (${signals.goal.length} characters) for a small, low-risk change ("${signals.small}")`,
  ]);
}

/**
 * Chooses a workflow template with plain rules over the goal text. Models
 * never take part in routing, so the same goal always yields the same flow and
 * the reasons can be shown to the operator verbatim.
 */
export function routeTemplate(input: RouteInput): FlowSelection {
  const forced = forcedSelection(input);
  if (forced) return forced;
  const signals = goalSignals(input.goal);
  return (
    riskSelection(signals) ??
    deliverableSelection(signals) ??
    lengthSelection(signals) ??
    smallChangeSelection(signals) ??
    selection("standard", "router", ["no signal that the task is trivial or high risk"])
  );
}

function selection(
  template: FlowTemplateName,
  source: FlowSelection["source"],
  reasons: string[],
): FlowSelection {
  return { template, source, reasons, engine: "v2" };
}

/** Distinct T1/P0.2 style ids, or bullet lines, whichever is larger. */
function countDeliverables(goal: string): number {
  const ids = new Set(goal.match(DELIVERABLE_ID_PATTERN) ?? []);
  const bullets = (goal.match(BULLET_PATTERN) ?? []).length;
  return Math.max(ids.size, bullets);
}
