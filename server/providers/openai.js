import { buildOpenAISummaryRequest, getOpenAISummaryConfig, normalizeSummaryTitle } from "../summarizers/openai.js";
import { createResponsesProvider } from "./responses-api.js";

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
  normalizeSummaryTitle,
  supportsReasoning: buildOpenAIReasoning,
});

export const {
  cancelResponse,
  getCapabilities,
  listModels,
  retrieveResponse,
  streamResponse,
  summarizeTitle,
} = openaiProvider;
