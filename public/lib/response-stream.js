const NON_TERMINAL_STATUSES = new Set(["queued", "in_progress"]);

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

function extractResponseText(payload) {
  if (!payload) {
    return "";
  }

  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }

  const pieces = [];
  for (const output of payload.output ?? []) {
    for (const content of output.content ?? []) {
      const text = getContentText(content);
      if (text) {
        pieces.push(text);
      }
    }
  }

  return pieces.join("");
}

function extractReasoningSummary(payload) {
  if (!payload) {
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

  collectArray(payload.summary);
  collectArray(payload.reasoning?.summary);
  collectArray(payload.response?.reasoning?.summary);

  const outputs = payload.output ?? payload.response?.output ?? [];
  if (Array.isArray(outputs)) {
    for (const output of outputs) {
      collectArray(output?.summary);
      collectArray(output?.reasoning?.summary);
    }
  }

  return Array.from(new Set(summaries.map((text) => text?.trim()).filter(Boolean))).join("\n\n");
}

function applyResponseSnapshot(state, payload) {
  const snapshot = payload?.response ?? payload;

  if (!snapshot || typeof snapshot !== "object") {
    return false;
  }

  let changed = false;

  if (typeof snapshot.id === "string" && snapshot.id !== state.id) {
    state.id = snapshot.id;
    changed = true;
  }

  if (typeof snapshot.status === "string" && snapshot.status !== state.status) {
    state.status = snapshot.status;
    state.isTerminal = !NON_TERMINAL_STATUSES.has(snapshot.status);
    changed = true;
  }

  if ("background" in snapshot) {
    const background = Boolean(snapshot.background);
    if (background !== state.background) {
      state.background = background;
      changed = true;
    }
  }

  const nextText = extractResponseText(snapshot);
  if (nextText && nextText !== state.text) {
    state.text = nextText;
    changed = true;
  }

  const nextReasoningSummary = extractReasoningSummary(snapshot);
  if (nextReasoningSummary && nextReasoningSummary !== state.reasoningSummary) {
    state.reasoningSummary = nextReasoningSummary;
    changed = true;
  }

  if (snapshot.error && snapshot.error !== state.error) {
    state.error = snapshot.error;
    changed = true;
  }

  return changed;
}

function emitUpdate(onUpdate, state, persist) {
  onUpdate?.({
    id: state.id,
    status: state.status,
    background: state.background,
    text: state.text,
    reasoningSummary: state.reasoningSummary,
    error: state.error,
    isTerminal: state.isTerminal,
  }, { persist });
}

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

export async function consumeProviderStream(response, { onUpdate } = {}) {
  if (!response.body) {
    throw new Error("Streaming response body is missing.");
  }

  const state = {
    id: null,
    status: "queued",
    background: false,
    text: "",
    reasoningSummary: "",
    error: null,
    isTerminal: false,
  };

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const sse = createSseReader((payload) => {
    if (payload?.error || payload?.type === "response.error") {
      throw new Error(payload?.error?.message || payload?.message || "Responses stream failed.");
    }

    const snapshotChanged = applyResponseSnapshot(state, payload);
    let changed = snapshotChanged;
    let persist = snapshotChanged && Boolean((payload?.response ?? payload)?.id);

    if (payload?.type === "response.output_text.delta") {
      const deltaText = typeof payload.delta === "string" ? payload.delta : getContentText(payload.delta);
      if (deltaText) {
        state.text += deltaText;
        changed = true;
      }
    }

    if (payload?.type === "response.output_text.done" && typeof payload.output_text === "string") {
      if (payload.output_text !== state.text) {
        state.text = payload.output_text;
        changed = true;
      }
    }

    if (payload?.type === "response.reasoning_summary_text.delta" && typeof payload.delta === "string") {
      state.reasoningSummary += payload.delta;
      changed = true;
    }

    if (payload?.type === "response.completed") {
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
    id: state.id,
    status: state.status,
    background: state.background,
    text: state.text,
    reasoningSummary: state.reasoningSummary,
    error: state.error,
    isTerminal: state.isTerminal,
  };
}
