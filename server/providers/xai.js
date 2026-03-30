import { buildXAISummaryRequest, getXAISummaryConfig, normalizeSummaryTitle } from "../summarizers/xai.js";
import { createResponsesProvider } from "./responses-api.js";
import { getSystemPrompt } from "../prompts/system.js";

function buildXAIReasoning(chatConfig) {
  if (chatConfig.modelId === "grok-3-mini" && chatConfig.reasoningEffort !== "none") {
    return {
      effort: chatConfig.reasoningEffort,
      summary: "auto",
    };
  }

  return null;
}

function customizeXAIRequestBody(body, { chatConfig }) {
  const systemPrompt = getSystemPrompt("xai", chatConfig.modelId);
  delete body.instructions;

  if (systemPrompt) {
    body.input = [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: systemPrompt,
          },
        ],
      },
      ...body.input,
    ];
  }

  return body;
}

const xaiProvider = createResponsesProvider({
  providerId: "xai",
  baseUrl: "https://api.x.ai/v1/responses",
  buildSummaryRequest: buildXAISummaryRequest,
  getSummaryConfig: getXAISummaryConfig,
  normalizeSummaryTitle,
  supportsReasoning: buildXAIReasoning,
  customizeRequestBody: customizeXAIRequestBody,
});

export const {
  cancelResponse,
  getCapabilities,
  listModels,
  retrieveResponse,
  streamResponse,
  summarizeTitle,
} = xaiProvider;
