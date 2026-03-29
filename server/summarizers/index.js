import { createHttpError } from "../lib/http.js";
import { buildOpenAISummaryRequest, getOpenAISummaryConfig, normalizeSummaryTitle } from "./openai.js";

export function getSummarizer(providerId) {
  if (providerId === "openai") {
    return {
      buildRequest: buildOpenAISummaryRequest,
      config: getOpenAISummaryConfig(),
      normalizeTitle: normalizeSummaryTitle,
    };
  }

  throw createHttpError(404, `No summarizer configured for provider '${providerId}'.`);
}
