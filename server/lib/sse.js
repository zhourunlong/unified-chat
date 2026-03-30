export function createSseParser(onEvent) {
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

export function writeSseEvent(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function endSse(response) {
  response.write("data: [DONE]\n\n");
  response.end();
}
