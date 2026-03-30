const NON_TERMINAL_STATUSES = new Set(["queued", "in_progress"]);

function createSseReader(onEvent) {
  let buffer = "";

  const flushEvent = (rawEvent) => {
    if (!rawEvent.trim()) {
      return;
    }

    const dataLines = [];
    for (const line of rawEvent.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length === 0) {
      return;
    }

    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      return;
    }

    onEvent(JSON.parse(data));
  };

  return {
    push(chunk) {
      buffer += chunk;

      while (true) {
        const separatorIndex = buffer.search(/\r?\n\r?\n/);
        if (separatorIndex === -1) {
          break;
        }

        const rawEvent = buffer.slice(0, separatorIndex);
        const separatorMatch = buffer.slice(separatorIndex).match(/^\r?\n\r?\n/);
        buffer = buffer.slice(separatorIndex + (separatorMatch?.[0].length || 2));
        flushEvent(rawEvent);
      }
    },
    finish() {
      flushEvent(buffer);
      buffer = "";
    },
  };
}

function createResponseState() {
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

function applyResponseSnapshot(state, snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return false;
  }

  let changed = false;

  for (const [field, value] of Object.entries(snapshot)) {
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

  if (typeof snapshot.status === "string") {
    state.isTerminal = !NON_TERMINAL_STATUSES.has(snapshot.status);
  }

  return changed;
}

function emitUpdate(onUpdate, state, persist) {
  onUpdate?.({
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
  }, { persist });
}

export async function consumeProviderStream(response, { onUpdate } = {}) {
  if (!response.body) {
    throw new Error("Streaming response body is missing.");
  }

  const state = createResponseState();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const sse = createSseReader((payload) => {
    if (payload?.type === "response.error") {
      throw new Error(payload.message || "Provider stream failed.");
    }

    let changed = false;
    let persist = false;

    if (payload?.type === "response.snapshot" && payload.response) {
      changed = applyResponseSnapshot(state, payload.response) || changed;
      persist = Boolean(payload.response.operationId);
    }

    if (payload?.type === "response.text.delta" && typeof payload.delta === "string") {
      state.text += payload.delta;
      changed = true;
    }

    if (payload?.type === "response.reasoning.delta" && typeof payload.delta === "string") {
      state.reasoningSummary += payload.delta;
      changed = true;
    }

    if (payload?.type === "response.completed" && payload.response) {
      changed = applyResponseSnapshot(state, payload.response) || changed;
      state.isTerminal = true;
      persist = true;
    }

    if (changed) {
      emitUpdate(onUpdate, state, persist);
    }
  });

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    sse.push(decoder.decode(value, { stream: true }));
  }

  sse.finish();
  state.isTerminal = !NON_TERMINAL_STATUSES.has(state.status);
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
