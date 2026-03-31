import { createHttpError } from "../lib/http.js";
import { requireConfiguredProviderKey } from "../lib/provider-auth.js";
import { createSseParser } from "../lib/sse.js";
import { getSystemPrompt } from "../prompts/index.js";
import { normalizeSummaryTitle } from "../summarizers/common.js";
import { buildAnthropicSummaryRequest, getAnthropicSummaryConfig } from "../summarizers/anthropic.js";
import { getProviderById } from "../../shared/model-catalog.js";
import { buildResponseSnapshot, createResponseState, mergeNormalizedResponse, validateProviderChatConfig } from "./utils.js";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1/messages";

function buildHeaders(apiKey) {
  return {
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "x-api-key": apiKey,
  };
}

function mapThinkingBudget(reasoningEffort) {
  if (reasoningEffort === "low") {
    return 1024;
  }

  if (reasoningEffort === "medium") {
    return 4096;
  }

  if (reasoningEffort === "high") {
    return 8192;
  }

  if (reasoningEffort === "xhigh") {
    return 16384;
  }

  return null;
}

function buildMessages(history, message) {
  const normalizedHistory = Array.isArray(history) ? history : [];
  const messages = normalizedHistory
    .filter((entry) => (entry.role === "user" || entry.role === "assistant") && typeof entry.text === "string" && entry.text.trim())
    .map((entry) => ({
      role: entry.role === "assistant" ? "assistant" : "user",
      content: [
        {
          type: "text",
          text: entry.text.trim(),
        },
      ],
    }));

  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: message.trim(),
      },
    ],
  });

  return messages;
}

function buildRequestBody({ chatConfig, history, message, stream = false }) {
  validateProviderChatConfig("anthropic", chatConfig);

  if (typeof message !== "string" || message.trim().length === 0) {
    throw createHttpError(400, "Message text is required.");
  }

  const body = {
    max_tokens: 4096,
    messages: buildMessages(history, message),
    model: chatConfig.modelId,
    stream,
    system: getSystemPrompt({
      providerId: "anthropic",
      modelId: chatConfig.modelId,
    }),
  };

  const thinkingBudget = mapThinkingBudget(chatConfig.reasoningEffort);
  if (thinkingBudget) {
    body.thinking = {
      type: "enabled",
      budget_tokens: thinkingBudget,
    };
  }

  return body;
}

async function parseAnthropicError(response) {
  try {
    const payload = await response.json();
    return payload?.error?.message || `Anthropic request failed with status ${response.status}.`;
  } catch {
    return `Anthropic request failed with status ${response.status}.`;
  }
}

async function anthropicFetch(body, apiKey) {
  const configuredApiKey = requireConfiguredProviderKey("anthropic", apiKey);
  const response = await fetch(ANTHROPIC_BASE_URL, {
    method: "POST",
    headers: buildHeaders(configuredApiKey),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw createHttpError(response.status, await parseAnthropicError(response));
  }

  return response.json();
}

async function anthropicFetchRaw(body, apiKey, signal) {
  const configuredApiKey = requireConfiguredProviderKey("anthropic", apiKey);
  const response = await fetch(ANTHROPIC_BASE_URL, {
    method: "POST",
    headers: buildHeaders(configuredApiKey),
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw createHttpError(response.status, await parseAnthropicError(response));
  }

  return response;
}

function extractResponseText(message) {
  return (message?.content || [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function extractReasoningSummary(message) {
  return (message?.content || [])
    .filter((block) => block?.type === "thinking" && typeof block.thinking === "string")
    .map((block) => block.thinking)
    .join("");
}

function normalizeResponse(message, state) {
  return {
    background: false,
    completedAt: state?.completedAt || new Date().toISOString(),
    context: null,
    createdAt: state?.createdAt || new Date().toISOString(),
    error: null,
    incompleteDetails: null,
    isTerminal: state?.isTerminal ?? true,
    model: message?.model || state?.model || null,
    operation: null,
    operationId: null,
    reasoningSummary: extractReasoningSummary(message),
    status: state?.status || "completed",
    text: extractResponseText(message),
    usage: message?.usage || null,
  };
}

function applyNormalizedResponse(state, response) {
  return mergeNormalizedResponse(state, response);
}

function collectStreamEvents(payload, state) {
  const events = [];

  if (payload?.type === "error") {
    throw createHttpError(502, payload?.error?.message || "Anthropic stream failed.");
  }

  if (payload?.type === "message_start") {
    applyNormalizedResponse(state, {
      background: false,
      completedAt: null,
      context: null,
      createdAt: new Date().toISOString(),
      error: null,
      incompleteDetails: null,
      isTerminal: false,
      model: payload.message?.model || null,
      operation: null,
      operationId: null,
      reasoningSummary: "",
      status: "in_progress",
      text: "",
      usage: payload.message?.usage || null,
    });
    events.push({
      type: "response.snapshot",
      response: buildResponseSnapshot(state),
    });
  }

  if (payload?.type === "content_block_delta") {
    if (payload.delta?.type === "text_delta" && typeof payload.delta.text === "string") {
      state.text += payload.delta.text;
      events.push({
        type: "response.text.delta",
        delta: payload.delta.text,
      });
    }

    if (payload.delta?.type === "thinking_delta" && typeof payload.delta.thinking === "string") {
      state.reasoningSummary += payload.delta.thinking;
      events.push({
        type: "response.reasoning.delta",
        delta: payload.delta.thinking,
      });
    }
  }

  if (payload?.type === "message_delta") {
    if (payload.usage) {
      state.usage = payload.usage;
    }

    if (payload.delta?.stop_reason) {
      state.status = "completed";
      state.isTerminal = true;
      state.completedAt = new Date().toISOString();
    }
  }

  if (payload?.type === "message_stop") {
    state.status = "completed";
    state.isTerminal = true;
    state.completedAt = state.completedAt || new Date().toISOString();
    events.push({
      type: "response.completed",
      response: buildResponseSnapshot(state),
    });
  }

  return events;
}

export function getCapabilities() {
  return getProviderById("anthropic")?.capabilities || {};
}

export function listModels() {
  return getProviderById("anthropic")?.models || [];
}

export async function* streamResponse({ apiKey, chatConfig, history, message, signal }) {
  const response = await anthropicFetchRaw(buildRequestBody({
    chatConfig,
    history,
    message,
    stream: true,
  }), apiKey, signal);

  if (!response.body) {
    throw createHttpError(502, "Provider stream did not return a body.");
  }

  const state = createResponseState();
  const queuedEvents = [];
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const parser = createSseParser((payload) => {
    queuedEvents.push(...collectStreamEvents(payload, state));
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
  while (queuedEvents.length > 0) {
    yield queuedEvents.shift();
  }
}

export async function summarizeTitle({ apiKey, firstUserMessage }) {
  if (typeof firstUserMessage !== "string" || firstUserMessage.trim().length === 0) {
    throw createHttpError(400, "First user message is required.");
  }

  const config = getAnthropicSummaryConfig();
  const response = await anthropicFetch(buildAnthropicSummaryRequest(firstUserMessage.trim()), apiKey);
  const normalized = normalizeResponse(response, { status: "completed", isTerminal: true });

  return {
    modelId: config.modelId,
    reasoningEffort: config.reasoningEffort,
    title: normalizeSummaryTitle(normalized.text),
  };
}

export async function retrieveResponse() {
  throw createHttpError(400, "Response retrieval is not supported for Anthropic.");
}

export async function cancelResponse() {
  throw createHttpError(400, "Run cancellation is not supported for Anthropic.");
}
