import { createHttpError } from "../lib/http.js";
import * as openaiProvider from "./openai.js";

const PROVIDER_HANDLERS = {
  openai: openaiProvider,
};

export function getProviderHandler(providerId) {
  const handler = PROVIDER_HANDLERS[providerId];

  if (!handler) {
    throw createHttpError(404, `Provider '${providerId}' is not implemented yet.`);
  }

  return handler;
}
