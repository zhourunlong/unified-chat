import { createHttpError } from "../lib/http.js";
import { requireConfiguredProviderKey } from "../lib/provider-auth.js";
import { createSseParser } from "../lib/sse.js";
import { getSystemPrompt } from "../prompts/index.js";
import { getModelById, getProviderById } from "../../shared/model-catalog.js";
import {
  NON_TERMINAL_STATUSES,
  buildResponseSnapshot,
  createContextToken,
  createOperationToken,
  createResponseState,
  mergeNormalizedResponse,
  readContextToken,
  readOperationToken,
} from "./utils.js";

function getContentText(content) {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (typeof content.text === "string") {
    return content.text;
  }

  if (Array.isArray(content.parts)) {
    return content.parts.join("");
  }

  return "";
}

function extractOutputText(response) {
  if (typeof response.output_text === "string" && response.output_text.length > 0) {
    return response.output_text;
  }

  const outputItems = Array.isArray(response.output) ? response.output : [];
  const fragments = [];

  for (const item of outputItems) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }

    for (const part of item.content) {
      const text = getContentText(part);
      if (text) {
        fragments.push(text);
      }
    }
  }

  return fragments.join("\n").trim();
}

function extractReasoningSummary(response) {
  if (!response) {
    return "";
  }

  const summaries = [];
  const collectText = (entry) => {
    if (!entry) {
      return;
    }

    if (typeof entry === "string") {
      summaries.push(entry);
    } else if (typeof entry.text === "string") {
      summaries.push(entry.text);
    }
  };

  const collectArray = (maybeArray) => {
    if (Array.isArray(maybeArray)) {
      maybeArray.forEach(collectText);
    }
  };

  collectArray(response.summary);
  collectArray(response.reasoning?.summary);
  collectArray(response.response?.reasoning?.summary);

  const outputs = response.output ?? response.response?.output ?? [];
  if (Array.isArray(outputs)) {
    for (const output of outputs) {
      collectArray(output?.summary);
      collectArray(output?.reasoning?.summary);
    }
  }

  return Array.from(new Set(summaries.map((text) => text?.trim()).filter(Boolean))).join("\n\n");
}

export function createResponsesProvider({
  providerId,
  baseUrl,
  buildSummaryRequest,
  getSummaryConfig,
  normalizeSummaryTitle,
  supportsReasoning,
  customizeRequestBody,
  exposeOperation = true,
  headers = (apiKey) => ({
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  }),
}) {
  function validateChatConfig(chatConfig) {
    const provider = getProviderById(chatConfig.providerId);

    if (!provider || provider.id !== providerId) {
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

  function normalizeResponse(response) {
    const responseId = typeof response.id === "string" ? response.id : null;
    const status = response.status || "queued";

    return {
      background: Boolean(response.background),
      completedAt: response.completed_at || null,
      context: createContextToken(providerId, responseId ? { responseId } : null),
      createdAt: response.created_at || null,
      error: response.error || null,
      incompleteDetails: response.incomplete_details || null,
      isTerminal: !NON_TERMINAL_STATUSES.has(status),
      model: response.model || null,
      operation: exposeOperation ? createOperationToken(providerId, responseId, responseId ? { responseId } : null) : null,
      operationId: exposeOperation ? responseId : null,
      reasoningSummary: extractReasoningSummary(response),
      status,
      text: extractOutputText(response),
      usage: response.usage || null,
    };
  }

  function applySnapshot(state, payload) {
    const snapshot = payload?.response ?? payload;

    if (!snapshot || typeof snapshot !== "object") {
      return false;
    }

    const hasResponseFields = typeof snapshot.id === "string"
      || typeof snapshot.status === "string"
      || typeof snapshot.output_text === "string"
      || Array.isArray(snapshot.output);

    if (!hasResponseFields) {
      return false;
    }

    return mergeNormalizedResponse(state, normalizeResponse(snapshot));
  }

  function buildResponseBody({ chatConfig, context, history, message, stream = false }) {
    validateChatConfig(chatConfig);

    if (typeof message !== "string" || message.trim().length === 0) {
      throw createHttpError(400, "Message text is required.");
    }

    const body = {
      background: true,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: message.trim(),
            },
          ],
        },
      ],
      instructions: getSystemPrompt({
        modelId: chatConfig.modelId,
        providerId: chatConfig.providerId,
      }),
      model: chatConfig.modelId,
      store: true,
      ...(stream ? { stream: true } : {}),
    };

    const reasoning = supportsReasoning?.(chatConfig) ?? {
      effort: chatConfig.reasoningEffort,
      summary: "auto",
    };
    if (reasoning) {
      body.reasoning = reasoning;
    }

    const previousContext = readContextToken(context, providerId);
    if (previousContext?.responseId) {
      body.previous_response_id = previousContext.responseId;
    }

    return customizeRequestBody
      ? customizeRequestBody(body, { chatConfig, context, history, message })
      : body;
  }

  async function parseProviderError(response) {
    try {
      const payload = await response.json();
      return payload?.error?.message || `${getProviderById(providerId)?.label || providerId} request failed with status ${response.status}.`;
    } catch {
      return `${getProviderById(providerId)?.label || providerId} request failed with status ${response.status}.`;
    }
  }

  async function providerFetch(pathname, options, apiKey) {
    const configuredApiKey = requireConfiguredProviderKey(providerId, apiKey);
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: {
        ...headers(configuredApiKey),
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      throw createHttpError(response.status, await parseProviderError(response));
    }

    return response.json();
  }

  async function providerFetchRaw(pathname, options, apiKey) {
    const configuredApiKey = requireConfiguredProviderKey(providerId, apiKey);
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: {
        ...headers(configuredApiKey),
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      throw createHttpError(response.status, await parseProviderError(response));
    }

    return response;
  }

  function collectStreamEvents(payload, state) {
    if (payload?.error || payload?.type === "response.error") {
      const message = payload?.error?.message || payload?.message || `${getProviderById(providerId)?.label || providerId} stream failed.`;
      throw createHttpError(502, message);
    }

    const events = [];
    const snapshotChanged = applySnapshot(state, payload);
    if (snapshotChanged) {
      events.push({
        type: "response.snapshot",
        response: buildResponseSnapshot(state),
      });
    }

    if (payload?.type === "response.output_text.delta") {
      const delta = typeof payload.delta === "string" ? payload.delta : getContentText(payload.delta);
      if (delta) {
        state.text += delta;
        events.push({
          type: "response.text.delta",
          delta,
        });
      }
    }

    if (payload?.type === "response.output_text.done" && typeof payload.output_text === "string" && payload.output_text !== state.text) {
      state.text = payload.output_text;
      events.push({
        type: "response.snapshot",
        response: buildResponseSnapshot(state),
      });
    }

    if (payload?.type === "response.reasoning_summary_text.delta" && typeof payload.delta === "string") {
      state.reasoningSummary += payload.delta;
      events.push({
        type: "response.reasoning.delta",
        delta: payload.delta,
      });
    }

    if (payload?.type === "response.completed") {
      state.isTerminal = true;
      events.push({
        type: "response.completed",
        response: buildResponseSnapshot(state),
      });
    }

    return events;
  }

  return {
    getCapabilities() {
      return getProviderById(providerId)?.capabilities || {};
    },

    listModels() {
      return getProviderById(providerId)?.models || [];
    },

    async *streamResponse({ apiKey, chatConfig, context, history, message, signal }) {
      const rawResponse = await providerFetchRaw("", {
        method: "POST",
        body: JSON.stringify(buildResponseBody({
          chatConfig,
          context,
          history,
          message,
          stream: true,
        })),
        signal,
      }, apiKey);

      if (!rawResponse.body) {
        throw createHttpError(502, "Provider stream did not return a body.");
      }

      const state = createResponseState();
      const queuedEvents = [];
      const decoder = new TextDecoder();
      const reader = rawResponse.body.getReader();
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
    },

    async summarizeTitle({ apiKey, firstUserMessage }) {
      if (typeof firstUserMessage !== "string" || firstUserMessage.trim().length === 0) {
        throw createHttpError(400, "First user message is required.");
      }

      const config = getSummaryConfig();
      const response = await providerFetch("", {
        method: "POST",
        body: JSON.stringify(buildSummaryRequest(firstUserMessage.trim())),
      }, apiKey);
      const summary = normalizeResponse(response);

      return {
        modelId: config.modelId,
        reasoningEffort: config.reasoningEffort,
        title: normalizeSummaryTitle(summary.text),
      };
    },

    async retrieveResponse({ apiKey, operation }) {
      if (!exposeOperation) {
        throw createHttpError(400, "Response retrieval is not supported for this provider.");
      }

      const token = readOperationToken(operation, providerId);
      const responseId = token?.data?.responseId || token?.id;
      if (!responseId) {
        throw createHttpError(400, "Operation token is required.");
      }

      const response = await providerFetch(`/${responseId}`, {
        method: "GET",
      }, apiKey);

      return normalizeResponse(response);
    },

    async cancelResponse({ apiKey, operation }) {
      if (!exposeOperation) {
        throw createHttpError(400, "Run cancellation is not supported for this provider.");
      }

      const token = readOperationToken(operation, providerId);
      const responseId = token?.data?.responseId || token?.id;
      if (!responseId) {
        throw createHttpError(400, "Operation token is required.");
      }

      const response = await providerFetch(`/${responseId}/cancel`, {
        method: "POST",
      }, apiKey);

      return normalizeResponse(response);
    },
  };
}
