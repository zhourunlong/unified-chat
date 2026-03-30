import { getSystemPrompt } from "../prompts/system.js";
import { SUMMARY_PROMPT, clipSummaryMessage, normalizeSummaryTitle } from "./common.js";

const SUMMARY_MODEL_ID = "gpt-5.4-nano";

export function getOpenAISummaryConfig() {
  return {
    modelId: SUMMARY_MODEL_ID,
    reasoningEffort: "none",
  };
}

export function buildOpenAISummaryRequest(firstUserMessage) {
  return {
    instructions: getSystemPrompt("openai", SUMMARY_MODEL_ID),
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `${SUMMARY_PROMPT}${clipSummaryMessage(firstUserMessage)}`,
          },
        ],
      },
    ],
    model: SUMMARY_MODEL_ID,
    reasoning: {
      effort: "none",
    },
    store: false,
  };
}

export { normalizeSummaryTitle };
