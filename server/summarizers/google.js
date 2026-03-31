import { SUMMARY_PROMPT, clipSummaryMessage } from "./common.js";

const SUMMARY_MODEL_ID = "gemini-3.1-flash-lite-preview";

export function getGoogleSummaryConfig() {
  return {
    modelId: SUMMARY_MODEL_ID,
    reasoningEffort: "minimal",
  };
}

export function buildGoogleSummaryRequest(firstUserMessage) {
  return {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${SUMMARY_PROMPT}${clipSummaryMessage(firstUserMessage)}`,
          },
        ],
      },
    ],
    generationConfig: {},
  };
}
