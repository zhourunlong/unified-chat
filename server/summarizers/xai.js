import { SUMMARY_PROMPT, clipSummaryMessage } from "./common.js";

const SUMMARY_MODEL_ID = "grok-4-fast-reasoning";

export function getXAISummaryConfig() {
  return {
    modelId: SUMMARY_MODEL_ID,
    reasoningEffort: "none",
  };
}

export function buildXAISummaryRequest(firstUserMessage) {
  return {
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: "Summarize the user's message into a short chat title with no extra commentary.",
          },
        ],
      },
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
    store: false,
  };
}
