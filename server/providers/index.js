import { createHttpError } from "../lib/http.js";
import * as anthropicProvider from "./anthropic.js";
import * as googleProvider from "./google.js";
import * as openaiProvider from "./openai.js";
import * as xaiProvider from "./xai.js";
import { getProviderById } from "../../shared/model-catalog.js";

const PROVIDER_HANDLERS = {
  anthropic: anthropicProvider,
  google: googleProvider,
  openai: openaiProvider,
  xai: xaiProvider,
};

export function getProviderHandler(providerId) {
  const handler = PROVIDER_HANDLERS[providerId];

  if (!handler) {
    throw createHttpError(404, `Provider '${providerId}' is not implemented yet.`);
  }

  return handler;
}

export function getProviderModels(providerId) {
  const provider = getProviderById(providerId);
  if (!provider) {
    throw createHttpError(404, `Unknown provider '${providerId}'.`);
  }

  const handler = PROVIDER_HANDLERS[providerId];
  return typeof handler.listModels === "function"
    ? handler.listModels()
    : provider.models || [];
}

export function getProviderCapabilities(providerId) {
  const provider = getProviderById(providerId);
  if (!provider) {
    throw createHttpError(404, `Unknown provider '${providerId}'.`);
  }

  const handler = PROVIDER_HANDLERS[providerId];
  return typeof handler.getCapabilities === "function"
    ? handler.getCapabilities()
    : provider.capabilities || {};
}
