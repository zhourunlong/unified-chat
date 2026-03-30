import { SUMMARY_PROMPT, clipSummaryMessage, normalizeSummaryTitle } from "./common.js";

const SUMMARY_MODEL_ID = "gemini-2.5-flash-lite";

export function getGoogleSummaryConfig() {
  return {
    modelId: SUMMARY_MODEL_ID,
    reasoningEffort: "none",
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

export { normalizeSummaryTitle };
