#!/usr/bin/env node
// Scripted stand-in for `claude --input-format stream-json` used by session tests.
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log(process.env.FAKE_VERSION ?? "2.1.237 (Claude Code)");
  process.exit(0);
}
if (process.env.FAKE_LOG) {
  appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ argv: args })}\n`);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let initialised = false;
let pending;
let awaitingInterrupt = false;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "user") return onUser(message.message.content[0].text);
  if (message.type === "control_request" && message.request.subtype === "interrupt") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
    if (awaitingInterrupt) {
      awaitingInterrupt = false;
      send({ type: "result", subtype: "error_during_execution", is_error: true, result: "", session_id: "sess-1" });
    }
    return;
  }
  if (message.type === "control_response" && pending) {
    const handler = pending;
    pending = undefined;
    handler(message.response);
  }
});

function onUser(text) {
  if (!initialised) {
    initialised = true;
    send({ type: "system", subtype: "init", session_id: "sess-1" });
  }
  if (text.includes("slow")) {
    send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "working" } } });
    awaitingInterrupt = true;
    return;
  }
  if (text.startsWith("Operator guidance")) {
    return done(`redirected:${text.split("\n")[1]}`);
  }
  if (text.includes("ask")) {
    send({
      type: "control_request",
      request_id: "cr-ask",
      request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Which option?", options: [{ label: "A" }, { label: "B" }] }] } },
    });
    pending = (response) => done(`answer:${JSON.stringify(response.response.updatedInput.answers)}`);
    return;
  }
  if (text.includes("bash")) {
    send({ type: "control_request", request_id: "cr-bash", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf /" } } });
    pending = (response) => done(`bash:${response.response.behavior}`);
    return;
  }
  if (text.includes("tool")) {
    send({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/a" } }] } });
    send({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } });
  }
  if (text.includes("fail")) {
    return send({ type: "result", subtype: "error_during_execution", is_error: true, result: "rate limit exceeded", session_id: "sess-1" });
  }
  if (text.includes("die")) process.exit(4);
  done(text.includes("JSON Schema") ? JSON.stringify({ ok: true }) : `echo:${text}`);
}

function done(result) {
  send({ type: "assistant", message: { content: [{ type: "text", text: result }] } });
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    session_id: "sess-1",
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 },
  });
}
