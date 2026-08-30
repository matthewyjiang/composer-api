#!/usr/bin/env node
import {
  runLocalAgent,
  _resetBridgeStateForTests,
  _setCreateAgentForTests
} from "../src/bridge.mjs";

const CREATE_DELAY_MS = Number(process.env.BENCH_CREATE_DELAY_MS || 80);
const SEND_DELAY_MS = Number(process.env.BENCH_SEND_DELAY_MS || 5);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function timeTurns(label, turns) {
  _resetBridgeStateForTests();
  let creates = 0;
  const prompts = [];
  _setCreateAgentForTests(async () => {
    creates += 1;
    await sleep(CREATE_DELAY_MS);
    return {
      agentId: `agent-${creates}`,
      close() {},
      async send(prompt) {
        prompts.push(prompt);
        await sleep(SEND_DELAY_MS);
        return {
          id: `run-${prompts.length}`,
          async *stream() {
            yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } };
          },
          async wait() {
            return { status: "finished", result: "ok" };
          },
          async cancel() {}
        };
      }
    };
  });

  const started = performance.now();
  const turnTimes = [];
  for (const turn of turns) {
    const turnStarted = performance.now();
    await runLocalAgent(turn);
    turnTimes.push(Math.round(performance.now() - turnStarted));
  }
  const elapsed = Math.round(performance.now() - started);
  _resetBridgeStateForTests();
  return { label, creates, elapsed, turnTimes, promptChars: prompts.map((prompt) => prompt.length) };
}

const base = {
  apiKey: "bench-key",
  model: "composer-2.5",
  sessionKey: "bench-session",
  workingDirectory: "/tmp/project",
  clientTools: []
};

const full1 = "SYSTEM + TOOL INVENTORY + USER: first turn\n".repeat(40);
const full2 = `${full1}\nUSER: second turn with a tool result`;
const incremental = "Continue from this new input only:\n\nUSER: second turn with a tool result";

const before = await timeTurns("full replay (evicts cached agent)", [
  { ...base, prompt: full1, requestId: "req-1" },
  { ...base, prompt: full2, requestId: "req-2" }
]);
const after = await timeTurns("incremental reuse (keeps cached agent)", [
  { ...base, prompt: full1, requestId: "req-1" },
  { ...base, prompt: full2, incrementalPrompt: incremental, requestId: "req-2" }
]);

console.log(JSON.stringify({
  createDelayMs: CREATE_DELAY_MS,
  sendDelayMs: SEND_DELAY_MS,
  before,
  after,
  turn2DeltaMs: before.turnTimes[1] - after.turnTimes[1],
  createCountDelta: before.creates - after.creates
}, null, 2));
