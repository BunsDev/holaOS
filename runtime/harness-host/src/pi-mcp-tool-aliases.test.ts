import assert from "node:assert/strict";
import test from "node:test";

import { mcpToolNameAliasesNeededForModel } from "./pi.js";

// Exact-name models call MCP tools by the exact registered name, so they must NOT
// get the `mcp__<server>__<tool>` aliases — those double a kebab-named MCP server's
// tool count in the list the model sees (e.g. AdsPower). This now covers every
// mainstream family EXCEPT GLM: Claude, GPT/OpenAI, Gemini, and also DeepSeek,
// Qwen, Kimi, MiniMax, Doubao — plus any unrecognized model (aliases are opt-in,
// not a default-on safety net, since the bloat is severe and GLM is the only known
// offender).
test("exact-name models (and unknown models) do not get MCP tool-name aliases", () => {
  for (const model of [
    "claude-opus-4-8",
    "anthropic/claude-sonnet-5",
    "Claude Sonnet 5",
    "gpt-5.4",
    "openai/gpt-5.4",
    "google/gemini-2.5-pro",
    "gemini-2.5-flash",
    "deepseek/deepseek-v4-flash-0731",
    "qwen/qwen3.7-max",
    "moonshotai/kimi-k3",
    "minimax/minimax-m3",
    "doubao-seed-2.0-pro",
    "some-unknown-model",
    "",
  ]) {
    assert.equal(
      mcpToolNameAliasesNeededForModel(model),
      false,
      `${model} should skip aliases`,
    );
  }
});

// GLM / Zhipu (chatGLM) are the only known models that mimic the Claude-Agent-SDK
// `mcp__<server>__<tool>` namespacing while keeping the original (kebab) tool
// spelling, so they opt IN to the alias compat shim.
test("GLM-family models get MCP tool-name aliases", () => {
  for (const model of [
    "z-ai/glm-5.2",
    "z-ai/glm-4.6",
    "thudm/glm-4",
    "GLM-4.5-Air",
    "zhipu/chatglm-6b",
  ]) {
    assert.equal(
      mcpToolNameAliasesNeededForModel(model),
      true,
      `${model} should get aliases`,
    );
  }
});
