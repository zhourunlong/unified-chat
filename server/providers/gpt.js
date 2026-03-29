import { createHttpError } from "../lib/http.js";
import { getSystemPrompt } from "../prompts/index.js";
import { getModelById, getProviderById } from "../../shared/model-catalog.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1/responses";
const NON_TERMINAL_STATUSES = new Set(["queued", "in_progress"]);

function getApiKey(apiKey) {
  return apiKey || process.env.OPENAI_API_KEY || "";
}

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
  const resolvedApiKey = getApiKey(apiKey);

  if (!resolvedApiKey) {
    throw createHttpError(400, "Missing OpenAI API key. Add one in settings or set OPENAI_API_KEY.");
  }

  const response = await fetch(`${OPENAI_BASE_URL}${pathname}`, {
    ...options,
    headers: {
      ...buildHeaders(resolvedApiKey),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    throw createHttpError(response.status, await parseOpenAIError(response));
  }

  return response.json();
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

function normalizeResponse(response) {
  return {
    id: response.id,
    model: response.model,
    status: response.status,
    background: Boolean(response.background),
    text: extractOutputText(response),
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

  const response = await openaiFetch("", {
    method: "POST",
    body: JSON.stringify(body),
  }, apiKey);

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
