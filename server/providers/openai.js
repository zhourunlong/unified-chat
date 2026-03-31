import { getSystemPrompt } from "../prompts/index.js";
import { SUMMARY_PROMPT, clipSummaryMessage } from "../summarizers/common.js";
import { createResponsesProvider } from "./responses-api.js";

const OPENAI_SUMMARY_MODEL_ID = "gpt-5.4-nano";

function getOpenAISummaryConfig() {
  return {
    modelId: OPENAI_SUMMARY_MODEL_ID,
    reasoningEffort: "none",
  };
}

function buildOpenAISummaryRequest(firstUserMessage) {
  return {
    instructions: getSystemPrompt({
      providerId: "openai",
      modelId: OPENAI_SUMMARY_MODEL_ID,
    }),
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
    model: OPENAI_SUMMARY_MODEL_ID,
    reasoning: {
      effort: "none",
    },
    store: false,
  };
}

function buildOpenAIReasoning(chatConfig) {
  return {
    effort: chatConfig.reasoningEffort,
    summary: "auto",
  };
}

const openaiProvider = createResponsesProvider({
  providerId: "openai",
  baseUrl: "https://api.openai.com/v1/responses",
  buildSummaryRequest: buildOpenAISummaryRequest,
  getSummaryConfig: getOpenAISummaryConfig,
  buildReasoning: buildOpenAIReasoning,
});

export const {
  cancelResponse,
  getCapabilities,
  listModels,
  retrieveResponse,
  streamResponse,
  summarizeTitle,
} = openaiProvider;
