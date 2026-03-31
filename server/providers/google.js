import { createHttpError } from "../lib/http.js";
import { requireConfiguredProviderKey } from "../lib/provider-auth.js";
import { createSseParser } from "../lib/sse.js";
import { getSystemPrompt } from "../prompts/index.js";
import { normalizeSummaryTitle } from "../summarizers/common.js";
import { buildGoogleSummaryRequest, getGoogleSummaryConfig } from "../summarizers/google.js";
import { getProviderById } from "../../shared/model-catalog.js";
import { buildResponseSnapshot, createContextToken, createResponseState, readContextToken, validateProviderChatConfig } from "./utils.js";

const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function mapThinkingLevel(reasoningEffort) {
  if (reasoningEffort === "none" || reasoningEffort === "minimal") {
    return "minimal";
  }

  if (reasoningEffort === "low") {
    return "low";
  }

  if (reasoningEffort === "medium") {
    return "medium";
  }

  if (reasoningEffort === "high" || reasoningEffort === "xhigh") {
    return "high";
  }

  return null;
}

function clonePart(part) {
  const nextPart = {};

  if (typeof part?.text === "string") {
    nextPart.text = part.text;
  }

  if (part?.thought === true) {
    nextPart.thought = true;
  }

  if (typeof part?.thoughtSignature === "string" && part.thoughtSignature.length > 0) {
    nextPart.thoughtSignature = part.thoughtSignature;
  }

  return nextPart;
}

function buildContents(history) {
  const normalizedHistory = Array.isArray(history) ? history : [];
  return normalizedHistory
    .filter((entry) => (entry.role === "user" || entry.role === "assistant") && typeof entry.text === "string" && entry.text.trim())
    .map((entry) => ({
      role: entry.role === "assistant" ? "model" : "user",
      parts: [
        {
          text: entry.text.trim(),
        },
      ],
    }));
}

function buildTurnContents({ context, history, message }) {
  const previousContext = readContextToken(context, "google");
  const contents = Array.isArray(previousContext?.contents)
    ? previousContext.contents
        .filter((entry) => (entry?.role === "user" || entry?.role === "model") && Array.isArray(entry.parts))
        .map((entry) => ({
          role: entry.role,
          parts: entry.parts.map(clonePart),
        }))
    : buildContents(history);

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

function buildRequestBody({ chatConfig, context, history, message }) {
  validateProviderChatConfig("google", chatConfig);

  if (typeof message !== "string" || message.trim().length === 0) {
    throw createHttpError(400, "Message text is required.");
  }

  const body = {
    contents: buildTurnContents({ context, history, message }),
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

  const thinkingLevel = mapThinkingLevel(chatConfig.reasoningEffort);
  if (thinkingLevel) {
    body.generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingLevel,
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

function appendModelPart(state, part) {
  const text = typeof part?.text === "string" ? part.text : "";
  const thought = part?.thought === true;
  const thoughtSignature = typeof part?.thoughtSignature === "string" && part.thoughtSignature.length > 0
    ? part.thoughtSignature
    : null;

  if (!text && !thoughtSignature) {
    return;
  }

  const previousPart = state.googleModelParts[state.googleModelParts.length - 1];
  const canMerge = previousPart
    && Boolean(previousPart.thought) === thought
    && !previousPart.thoughtSignature
    && !thoughtSignature;

  if (canMerge) {
    previousPart.text = `${previousPart.text || ""}${text}`;
    return;
  }

  const nextPart = {};
  if (text) {
    nextPart.text = text;
  }
  if (thought) {
    nextPart.thought = true;
  }
  if (thoughtSignature) {
    nextPart.thoughtSignature = thoughtSignature;
  }

  state.googleModelParts.push(nextPart);
}

function buildGoogleContextToken(state) {
  if (!Array.isArray(state.googleRequestContents)) {
    return null;
  }

  const contents = state.googleRequestContents.map((entry) => ({
    role: entry.role,
    parts: entry.parts.map(clonePart),
  }));

  if (state.googleModelParts.length > 0) {
    contents.push({
      role: "model",
      parts: state.googleModelParts.map(clonePart),
    });
  } else if (state.text) {
    contents.push({
      role: "model",
      parts: [
        {
          text: state.text,
        },
      ],
    });
  }

  return createContextToken("google", { contents });
}

export function getCapabilities() {
  return getProviderById("google")?.capabilities || {};
}

export function listModels() {
  return getProviderById("google")?.models || [];
}

export async function* streamResponse({ apiKey, chatConfig, context, history, message, signal }) {
  const requestBody = buildRequestBody({ chatConfig, context, history, message });
  const requestContents = requestBody.contents.map((entry) => ({
    role: entry.role,
    parts: entry.parts.map(clonePart),
  }));
  const response = await googleFetch(
    `/models/${encodeURIComponent(chatConfig.modelId)}:streamGenerateContent?alt=sse`,
    requestBody,
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
  state.googleModelParts = [];
  state.googleRequestContents = requestContents;

  const queuedEvents = [{
    type: "response.snapshot",
    response: buildResponseSnapshot(state),
  }];
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const parser = createSseParser((payload) => {
    const candidate = extractCandidate(payload);
    const parts = candidate?.content?.parts || [];

    for (const part of parts) {
      const delta = typeof part?.text === "string" ? part.text : "";
      if (part?.thought === true) {
        if (delta) {
          state.reasoningSummary += delta;
          queuedEvents.push({
            type: "response.reasoning.delta",
            delta,
          });
        }
      } else if (delta) {
        state.text += delta;
        queuedEvents.push({
          type: "response.text.delta",
          delta,
        });
      }

      appendModelPart(state, part);
    }

    state.usage = payload?.usageMetadata || state.usage;
    const finishReason = candidate?.finishReason;
    if (finishReason) {
      state.status = "completed";
      state.isTerminal = true;
      state.completedAt = new Date().toISOString();
      state.context = buildGoogleContextToken(state);
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
  state.context = state.context || buildGoogleContextToken(state);
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
