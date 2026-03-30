import { createHttpError } from "../lib/http.js";
import { requireConfiguredProviderKey } from "../lib/provider-auth.js";
import { createSseParser } from "../lib/sse.js";
import { getSystemPrompt } from "../prompts/index.js";
import { buildGoogleSummaryRequest, getGoogleSummaryConfig, normalizeSummaryTitle } from "../summarizers/google.js";
import { getModelById, getProviderById } from "../../shared/model-catalog.js";
import { buildResponseSnapshot, createResponseState, mergeNormalizedResponse } from "./utils.js";

const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function mapThinkingBudget(reasoningEffort) {
  if (reasoningEffort === "low") {
    return 256;
  }

  if (reasoningEffort === "medium") {
    return 1024;
  }

  if (reasoningEffort === "high") {
    return 4096;
  }

  if (reasoningEffort === "xhigh") {
    return 8192;
  }

  return null;
}

function validateChatConfig(chatConfig) {
  const provider = getProviderById(chatConfig.providerId);
  if (!provider || provider.id !== "google") {
    throw createHttpError(400, "Unsupported provider configuration.");
  }

  const model = getModelById(chatConfig.providerId, chatConfig.modelId);
  if (!model) {
    throw createHttpError(400, "Unknown model.");
  }

  if (!model.reasoningEfforts.includes(chatConfig.reasoningEffort)) {
    throw createHttpError(400, "Unsupported reasoning effort for the selected model.");
  }
}

function buildContents(history, message) {
  const normalizedHistory = Array.isArray(history) ? history : [];
  const contents = normalizedHistory
    .filter((entry) => (entry.role === "user" || entry.role === "assistant") && typeof entry.text === "string" && entry.text.trim())
    .map((entry) => ({
      role: entry.role === "assistant" ? "model" : "user",
      parts: [
        {
          text: entry.text.trim(),
        },
      ],
    }));

  contents.push({
    role: "user",
    parts: [
      {
        text: message.trim(),
      },
    ],
  });

  return contents;
}

function buildRequestBody({ chatConfig, history, message }) {
  validateChatConfig(chatConfig);

  if (typeof message !== "string" || message.trim().length === 0) {
    throw createHttpError(400, "Message text is required.");
  }

  const body = {
    contents: buildContents(history, message),
    generationConfig: {},
    systemInstruction: {
      role: "system",
      parts: [
        {
          text: getSystemPrompt({
            providerId: "google",
            modelId: chatConfig.modelId,
          }),
        },
      ],
    },
  };

  const thinkingBudget = mapThinkingBudget(chatConfig.reasoningEffort);
  if (thinkingBudget) {
    body.generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget,
    };
  }

  return body;
}

function buildHeaders(apiKey) {
  return {
    "content-type": "application/json",
    "x-goog-api-key": apiKey,
  };
}

async function parseGoogleError(response) {
  try {
    const payload = await response.json();
    return payload?.error?.message || `Google request failed with status ${response.status}.`;
  } catch {
    return `Google request failed with status ${response.status}.`;
  }
}

async function googleFetch(path, body, apiKey, signal) {
  const configuredApiKey = requireConfiguredProviderKey("google", apiKey);
  const response = await fetch(`${GOOGLE_BASE_URL}${path}`, {
    method: "POST",
    headers: buildHeaders(configuredApiKey),
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw createHttpError(response.status, await parseGoogleError(response));
  }

  return response;
}

function extractCandidate(response) {
  return Array.isArray(response?.candidates) ? response.candidates[0] || null : null;
}

function extractPartsByThought(response, thought) {
  const candidate = extractCandidate(response);
  const parts = candidate?.content?.parts || [];

  return parts
    .filter((part) => Boolean(part?.thought) === thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function normalizeResponse(response, state) {
  return {
    background: false,
    completedAt: state?.completedAt || null,
    context: null,
    createdAt: state?.createdAt || null,
    error: null,
    incompleteDetails: null,
    isTerminal: state?.isTerminal ?? false,
    model: state?.model || null,
    operation: null,
    operationId: null,
    reasoningSummary: extractPartsByThought(response, true),
    status: state?.status || "in_progress",
    text: extractPartsByThought(response, false),
    usage: response?.usageMetadata || null,
  };
}

function applyChunk(state, response) {
  return mergeNormalizedResponse(state, normalizeResponse(response, state));
}

export function getCapabilities() {
  return getProviderById("google")?.capabilities || {};
}

export function listModels() {
  return getProviderById("google")?.models || [];
}

export async function* streamResponse({ apiKey, chatConfig, history, message, signal }) {
  const response = await googleFetch(
    `/models/${encodeURIComponent(chatConfig.modelId)}:streamGenerateContent?alt=sse`,
    buildRequestBody({ chatConfig, history, message }),
    apiKey,
    signal,
  );

  if (!response.body) {
    throw createHttpError(502, "Provider stream did not return a body.");
  }

  const state = createResponseState();
  state.status = "in_progress";
  state.model = chatConfig.modelId;
  state.createdAt = new Date().toISOString();

  const queuedEvents = [{
    type: "response.snapshot",
    response: buildResponseSnapshot(state),
  }];
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const parser = createSseParser((payload) => {
    const previousText = state.text;
    const previousReasoning = state.reasoningSummary;

    applyChunk(state, payload);

    if (state.text.length > previousText.length) {
      queuedEvents.push({
        type: "response.text.delta",
        delta: state.text.slice(previousText.length),
      });
    }

    if (state.reasoningSummary.length > previousReasoning.length) {
      queuedEvents.push({
        type: "response.reasoning.delta",
        delta: state.reasoningSummary.slice(previousReasoning.length),
      });
    }

    state.usage = payload?.usageMetadata || state.usage;
    const finishReason = extractCandidate(payload)?.finishReason;
    if (finishReason) {
      state.status = "completed";
      state.isTerminal = true;
      state.completedAt = new Date().toISOString();
    }
  });

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    parser.push(decoder.decode(value, { stream: true }));
    while (queuedEvents.length > 0) {
      yield queuedEvents.shift();
    }
  }

  parser.finish();
  state.status = "completed";
  state.isTerminal = true;
  state.completedAt = state.completedAt || new Date().toISOString();
  queuedEvents.push({
    type: "response.completed",
    response: buildResponseSnapshot(state),
  });

  while (queuedEvents.length > 0) {
    yield queuedEvents.shift();
  }
}

export async function summarizeTitle({ apiKey, firstUserMessage }) {
  if (typeof firstUserMessage !== "string" || firstUserMessage.trim().length === 0) {
    throw createHttpError(400, "First user message is required.");
  }

  const config = getGoogleSummaryConfig();
  const response = await googleFetch(
    `/models/${encodeURIComponent(config.modelId)}:generateContent`,
    buildGoogleSummaryRequest(firstUserMessage.trim()),
    apiKey,
  );
  const payload = await response.json();
  const title = normalizeSummaryTitle(extractPartsByThought(payload, false));

  return {
    modelId: config.modelId,
    reasoningEffort: config.reasoningEffort,
    title,
  };
}

export async function retrieveResponse() {
  throw createHttpError(400, "Response retrieval is not supported for Google.");
}

export async function cancelResponse() {
  throw createHttpError(400, "Run cancellation is not supported for Google.");
}
