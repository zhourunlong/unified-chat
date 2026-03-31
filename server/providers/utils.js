import { createHttpError } from "../lib/http.js";
import { getModelById, getProviderById } from "../../shared/model-catalog.js";

export const NON_TERMINAL_STATUSES = new Set(["queued", "in_progress"]);

export function validateProviderChatConfig(providerId, chatConfig) {
  const provider = getProviderById(chatConfig?.providerId);

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

  return {
    model,
    provider,
  };
}

export function createContextToken(providerId, data) {
  if (!data) {
    return null;
  }

  return {
    kind: "conversation",
    providerId,
    data,
  };
}

export function readContextToken(token, providerId, label = "context") {
  if (!token) {
    return null;
  }

  if (token.providerId !== providerId || token.kind !== "conversation" || typeof token.data !== "object" || token.data === null) {
    throw createHttpError(400, `Invalid ${providerId} ${label}.`);
  }

  return token.data;
}

export function createOperationToken(providerId, id, data = null) {
  if (!id) {
    return null;
  }

  return {
    kind: "response",
    providerId,
    id,
    ...(data ? { data } : {}),
  };
}

export function readOperationToken(token, providerId, label = "operation") {
  if (!token) {
    return null;
  }

  if (token.providerId !== providerId || token.kind !== "response" || typeof token.id !== "string") {
    throw createHttpError(400, `Invalid ${providerId} ${label}.`);
  }

  return token;
}

export function createResponseState() {
  return {
    background: false,
    completedAt: null,
    context: null,
    createdAt: null,
    error: null,
    incompleteDetails: null,
    isTerminal: false,
    model: null,
    operation: null,
    operationId: null,
    reasoningSummary: "",
    status: "queued",
    text: "",
    usage: null,
  };
}

export function mergeNormalizedResponse(state, response) {
  let changed = false;

  for (const [field, value] of Object.entries(response)) {
    if (value === undefined) {
      continue;
    }

    if (field === "text" || field === "reasoningSummary") {
      if (typeof value === "string" && value !== state[field]) {
        state[field] = value;
        changed = true;
      }
      continue;
    }

    if (value !== state[field]) {
      state[field] = value;
      changed = true;
    }
  }

  if (typeof state.status === "string") {
    state.isTerminal = !NON_TERMINAL_STATUSES.has(state.status);
  }

  return changed;
}

export function buildResponseSnapshot(state) {
  return {
    background: state.background,
    completedAt: state.completedAt,
    context: state.context,
    createdAt: state.createdAt,
    error: state.error,
    incompleteDetails: state.incompleteDetails,
    isTerminal: state.isTerminal,
    model: state.model,
    operation: state.operation,
    operationId: state.operationId,
    reasoningSummary: state.reasoningSummary,
    status: state.status,
    text: state.text,
    usage: state.usage,
  };
}
