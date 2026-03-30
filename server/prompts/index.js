import { getSystemPrompt as buildSystemPrompt } from "./system.js";

export function getSystemPrompt({ providerId, modelId }) {
  if (providerId === "openai" || providerId === "anthropic" || providerId === "google" || providerId === "xai") {
    return buildSystemPrompt(providerId, modelId);
  }

  return "";
}
