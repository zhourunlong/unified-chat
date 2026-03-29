import { getOpenAISystemPrompt } from "./openai.js";

export function getSystemPrompt({ providerId, modelId }) {
  if (providerId === "openai") {
    return getOpenAISystemPrompt(modelId);
  }

  return "";
}
