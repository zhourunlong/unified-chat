import { getSystemPrompt } from "../prompts/system.js";
import { SUMMARY_PROMPT, clipSummaryMessage, normalizeSummaryTitle } from "./common.js";

const SUMMARY_MODEL_ID = "claude-haiku-4-5-20251001";

export function getAnthropicSummaryConfig() {
  return {
    modelId: SUMMARY_MODEL_ID,
    reasoningEffort: "none",
  };
}

export function buildAnthropicSummaryRequest(firstUserMessage) {
  return {
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${SUMMARY_PROMPT}${clipSummaryMessage(firstUserMessage)}`,
          },
        ],
      },
    ],
    model: SUMMARY_MODEL_ID,
    system: getSystemPrompt("anthropic", SUMMARY_MODEL_ID),
  };
}

export { normalizeSummaryTitle };
