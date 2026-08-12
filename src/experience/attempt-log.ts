import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface AttemptCard {
  runId: string;
  taskId: string;
  taskTitle: string;
  attempt: number;
  feedback: string;
  signature: string;
  at: string;
}

/**
 * Append-only attempt cards for rework memory (OpenRSI-style within-run signals).
 * Stored under stateRoot/experience/attempts.jsonl
 */
export class AttemptLog {
  constructor(private readonly filePath: string) {}

  static pathFor(stateRoot: string): string {
    return path.join(stateRoot, "experience", "attempts.jsonl");
  }

  async append(card: AttemptCard): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(card)}\n`, "utf8");
  }

  async recentMatching(input: {
    feedback: string;
    taskId?: string;
    limit?: number;
  }): Promise<AttemptCard[]> {
    const limit = input.limit ?? 5;
    const signature = signatureFromFeedback(input.feedback);
    let raw = "";
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const lines = raw.split("\n").filter(Boolean);
    const cards: AttemptCard[] = [];
    for (let index = lines.length - 1; index >= 0 && cards.length < limit * 3; index -= 1) {
      try {
        const card = JSON.parse(lines[index]!) as AttemptCard;
        if (input.taskId && card.taskId === input.taskId) {
          cards.push(card);
          continue;
        }
        if (
          card.signature &&
          signature &&
          (card.signature === signature ||
            card.feedback.includes(signature) ||
            input.feedback.includes(card.signature))
        ) {
          cards.push(card);
        }
      } catch {
        // skip corrupt lines
      }
    }
    return cards.slice(0, limit);
  }
}

export function signatureFromFeedback(feedback: string): string {
  const text = feedback.replace(/\s+/g, " ").trim().toLowerCase();
  if (/codex/.test(text) && /enoent|not found|找不到/.test(text)) return "codex-missing";
  if (/grok/.test(text) && /enoent|not found|找不到/.test(text)) return "grok-missing";
  if (/owned path|ownedPaths|路径/.test(text)) return "owned-paths";
  if (/no repository changes|无变更|no changes/.test(text)) return "no-changes";
  if (/quality|验收|exit code|failed gates/.test(text)) return "quality-gates";
  if (/review|审查/.test(text)) return "review-reject";
  if (/test|测试/.test(text)) return "test-reject";
  if (/quota|额度/.test(text)) return "model-quota";
  if (/rate|限流|429/.test(text)) return "model-rate";
  return text.slice(0, 48);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
