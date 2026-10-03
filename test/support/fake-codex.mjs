#!/usr/bin/env node
// Scripted stand-in for `codex app-server` used by session tests.
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log(process.env.FAKE_VERSION ?? "codex-cli 0.147.0");
  process.exit(0);
}
if (process.env.FAKE_LOG) {
  appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ argv: args, codexHome: process.env.CODEX_HOME ?? null })}\n`);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let turnCounter = 0;
let current;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined && message.id !== undefined) {
    if (current?.questionRequestId === message.id) {
      const answers = message.result.answers;
      finish(`answer:${Object.values(answers)[0].answers[0]}`);
    }
    return;
  }
  switch (message.method) {
    case "initialize":
      return send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" } });
    case "thread/start":
    case "thread/resume":
      return send({ id: message.id, result: { thread: { id: message.params.threadId ?? "thr-1" } } });
    case "turn/start":
      return startTurn(message);
    case "turn/steer":
      if (!current || message.params.expectedTurnId !== current.id) {
        return send({ id: message.id, error: { code: -32000, message: "no matching turn" } });
      }
      send({ id: message.id, result: { turnId: current.id } });
      return finish(`steered:${message.params.input[0].text}`);
    case "turn/interrupt":
      send({ id: message.id, result: {} });
      return finish("", "interrupted");
    default:
  }
});

function startTurn(message) {
  const prompt = message.params.input[0].text;
  current = { id: `turn-${++turnCounter}`, prompt, schema: message.params.outputSchema };
  send({ id: message.id, result: { turn: { id: current.id, items: [], status: "inProgress" } } });
  send({ method: "turn/started", params: { threadId: "thr-1", turn: { id: current.id, status: "inProgress" } } });
  if (prompt.includes("slow")) {
    send({ method: "item/agentMessage/delta", params: { threadId: "thr-1", turnId: current.id, itemId: "m1", delta: "working" } });
    return;
  }
  if (prompt.includes("ask")) {
    current.questionRequestId = 900;
    send({
      id: 900,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thr-1",
        turnId: current.id,
        itemId: "i1",
        isBlocking: true,
        questions: [{ id: "q1", header: "Pick", question: "Which option?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }],
      },
    });
    return;
  }
  if (prompt.includes("approve")) {
    current.approvalRequestId = 901;
    send({ id: 901, method: "item/commandExecution/requestApproval", params: { threadId: "thr-1", turnId: current.id, itemId: "c1", command: "rm -rf /" } });
    setTimeout(() => finish("approval-handled"), 50);
    return;
  }
  if (prompt.includes("tool")) {
    send({ method: "item/started", params: { threadId: "thr-1", turnId: current.id, item: { type: "commandExecution", id: "c1", command: "ls", status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId: "thr-1", turnId: current.id, item: { type: "commandExecution", id: "c1", command: "ls", status: "completed", exitCode: 0 } } });
  }
  if (prompt.includes("fail")) {
    send({ method: "turn/completed", params: { threadId: "thr-1", turn: { id: current.id, status: "failed", error: { message: "usage limit reached", codexErrorInfo: "usageLimitExceeded" }, items: [] } } });
    current = undefined;
    return;
  }
  if (prompt.includes("die")) process.exit(3);
  finish(current.schema ? JSON.stringify({ ok: true }) : `echo:${prompt}`);
}

function finish(text, status = "completed") {
  if (!current) return;
  const turn = current;
  current = undefined;
  const items = text ? [{ type: "agentMessage", id: "m1", text, phase: "final_answer" }] : [];
  for (const item of items) {
    send({ method: "item/started", params: { threadId: "thr-1", turnId: turn.id, item: { ...item, text: "" } } });
    send({ method: "item/completed", params: { threadId: "thr-1", turnId: turn.id, item } });
  }
  send({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thr-1",
      turnId: turn.id,
      tokenUsage: {
        total: { totalTokens: 15 * turnCounter, inputTokens: 10 * turnCounter, cachedInputTokens: 2 * turnCounter, cacheWriteInputTokens: 0, outputTokens: 5 * turnCounter, reasoningOutputTokens: 0 },
        last: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
      },
    },
  });
  send({ method: "turn/completed", params: { threadId: "thr-1", turn: { id: turn.id, status, error: null, items } } });
}
