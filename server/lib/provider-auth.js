import { getProviderById } from "../../shared/model-catalog.js";
import { createHttpError } from "./http.js";

export function requireConfiguredProviderKey(providerId, apiKey) {
  const provider = getProviderById(providerId);

  if (!provider) {
    throw createHttpError(404, `Unknown provider '${providerId}'.`);
  }

  const normalizedApiKey = String(apiKey || "").trim();
  if (!normalizedApiKey) {
    throw createHttpError(400, `${provider.apiKeyLabel} is required. Configure it in settings.`);
  }

  return normalizedApiKey;
}
