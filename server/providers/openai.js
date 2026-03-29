import { createHttpError } from "../lib/http.js";
import { requireConfiguredProviderKey } from "../lib/provider-auth.js";
import { getSystemPrompt } from "../prompts/index.js";
import { getOpenAISummaryConfig } from "../summarizers/openai.js";
import { getModelById, getProviderById } from "../../shared/model-catalog.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1/responses";
const NON_TERMINAL_STATUSES = new Set(["queued", "in_progress"]);

function buildHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function parseOpenAIError(response) {
  try {
    const payload = await response.json();
    return payload?.error?.message || `OpenAI request failed with status ${response.status}.`;
  } catch {
    return `OpenAI request failed with status ${response.status}.`;
  }
}

async function openaiFetch(pathname, options, apiKey) {
  const configuredApiKey = requireConfiguredProviderKey("openai", apiKey);

  const response = await fetch(`${OPENAI_BASE_URL}${pathname}`, {
    ...options,
    headers: {
      ...buildHeaders(configuredApiKey),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    throw createHttpError(response.status, await parseOpenAIError(response));
  }

  return response.json();
}

async function openaiFetchRaw(pathname, options, apiKey) {
  const configuredApiKey = requireConfiguredProviderKey("openai", apiKey);

  const response = await fetch(`${OPENAI_BASE_URL}${pathname}`, {
    ...options,
    headers: {
      ...buildHeaders(configuredApiKey),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    throw createHttpError(response.status, await parseOpenAIError(response));
  }

  return response;
}

async function createRawResponse(body, apiKey) {
  return openaiFetch("", {
    method: "POST",
    body: JSON.stringify(body),
  }, apiKey);
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
      if (part.type === "output_text" && typeof part.text === "string") {
        fragments.push(part.text);
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

  const uniqueSummaries = Array.from(
    new Set(
      summaries
        .map((text) => text?.trim())
        .filter(Boolean),
    ),
  );

  return uniqueSummaries.join("\n\n");
}

function normalizeResponse(response) {
  return {
    id: response.id,
    model: response.model,
    status: response.status,
    background: Boolean(response.background),
    text: extractOutputText(response),
    reasoningSummary: extractReasoningSummary(response),
    error: response.error || null,
    incompleteDetails: response.incomplete_details || null,
    createdAt: response.created_at || null,
    completedAt: response.completed_at || null,
    usage: response.usage || null,
    isTerminal: !NON_TERMINAL_STATUSES.has(response.status),
  };
}

function validateChatConfig(chatConfig) {
  const provider = getProviderById(chatConfig.providerId);

  if (!provider || provider.id !== "openai") {
    throw createHttpError(400, "Unsupported provider for GPT endpoint.");
  }

  const model = getModelById(chatConfig.providerId, chatConfig.modelId);

  if (!model) {
    throw createHttpError(400, "Unknown GPT model.");
  }

  if (!model.reasoningEfforts.includes(chatConfig.reasoningEffort)) {
    throw createHttpError(400, "Unsupported reasoning effort for the selected GPT model.");
  }
}

export async function createResponse({ apiKey, chatConfig, message, previousResponseId }) {
  validateChatConfig(chatConfig);

  if (typeof message !== "string" || message.trim().length === 0) {
    throw createHttpError(400, "Message text is required.");
  }

  const body = {
    model: chatConfig.modelId,
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
    reasoning: {
      effort: chatConfig.reasoningEffort,
      summary: "auto",
    },
    background: true,
    store: true,
    instructions: getSystemPrompt({
      modelId: chatConfig.modelId,
      providerId: chatConfig.providerId,
    }),
  };

  if (previousResponseId) {
    body.previous_response_id = previousResponseId;
  }

  const response = await createRawResponse(body, apiKey);

  return normalizeResponse(response);
}

export async function createResponseStream({ apiKey, chatConfig, message, previousResponseId, signal }) {
  validateChatConfig(chatConfig);

  if (typeof message !== "string" || message.trim().length === 0) {
    throw createHttpError(400, "Message text is required.");
  }

  const body = {
    model: chatConfig.modelId,
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
    reasoning: {
      effort: chatConfig.reasoningEffort,
      summary: "auto",
    },
    background: true,
    store: true,
    stream: true,
    instructions: getSystemPrompt({
      modelId: chatConfig.modelId,
      providerId: chatConfig.providerId,
    }),
  };

  if (previousResponseId) {
    body.previous_response_id = previousResponseId;
  }

  return openaiFetchRaw("", {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  }, apiKey);
}

export async function createSummaryResponse({ apiKey, body }) {
  const config = getOpenAISummaryConfig();

  if (body.model !== config.modelId || body.reasoning?.effort !== config.reasoningEffort) {
    throw createHttpError(400, "Invalid GPT summarizer configuration.");
  }

  const response = await createRawResponse(body, apiKey);
  return normalizeResponse(response);
}

export async function retrieveResponse({ apiKey, responseId }) {
  if (!responseId) {
    throw createHttpError(400, "Response ID is required.");
  }

  const response = await openaiFetch(`/${responseId}`, {
    method: "GET",
  }, apiKey);

  return normalizeResponse(response);
}

export async function cancelResponse({ apiKey, responseId }) {
  if (!responseId) {
    throw createHttpError(400, "Response ID is required.");
  }

  const response = await openaiFetch(`/${responseId}/cancel`, {
    method: "POST",
  }, apiKey);

  return normalizeResponse(response);
}
