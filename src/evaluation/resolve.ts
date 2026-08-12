import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentTeamConfig } from "../config/schema.js";
import {
  parseEvaluationSuite,
  parseEvaluationSuiteRuntime,
  synthesizeLegacyEvaluationSuite,
  type EvaluationSuite,
} from "./domain.js";

/**
 * Resolve the active evaluation suite for a project config.
 * Precedence: inline evaluation.suite > evaluation.suiteFile > legacy evaluationGoal.
 */
export async function resolveEvaluationSuite(
  config: AgentTeamConfig,
  projectRoot: string,
): Promise<EvaluationSuite | undefined> {
  const evaluation = config.evaluation;
  if (evaluation?.suite) {
    return parseEvaluationSuite(evaluation.suite);
  }
  if (evaluation?.suiteFile) {
    const suitePath = path.resolve(projectRoot, evaluation.suiteFile);
    const contents = await readFile(suitePath, "utf8");
    const document = parseYaml(contents);
    return parseEvaluationSuite(document);
  }
  const goal = config.evolution.automatic.evaluationGoal?.trim() ?? "";
  if (goal) {
    return synthesizeLegacyEvaluationSuite(
      goal,
      config.evolution.automatic.evaluationRepeats,
    );
  }
  return undefined;
}

export function requireEvaluationSuite(
  suite: EvaluationSuite | undefined,
  context: string,
): EvaluationSuite {
  if (!suite) {
    throw new Error(
      `${context}: no evaluation suite configured (set evaluation.suite, evaluation.suiteFile, or evolution.automatic.evaluationGoal)`,
    );
  }
  return parseEvaluationSuiteRuntime(suite);
}
