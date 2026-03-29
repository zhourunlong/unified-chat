function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeMathDelimiters(input) {
  if (!input) {
    return "";
  }

  const codeFenceSplitRegex = /(```[\s\S]*?```)/g;
  const displayRegex = /\\\[([\s\S]*?)\\\]/g;
  const inlineRegex = /\\\(([\s\S]*?)\\\)/g;

  return input
    .split(codeFenceSplitRegex)
    .map((segment, index) => {
      if (index % 2 === 1) {
        return segment;
      }

      const displayNormalized = segment.replace(
        displayRegex,
        (_, content) => `\n$$\n${content.trim()}\n$$\n`,
      );

      return displayNormalized.replace(
        inlineRegex,
        (_, content) => `$${content.trim()}$`,
      );
    })
    .join("");
}

function attachMathRenderer(markdownItInstance, katexInstance) {
  const isEscaped = (src, pos) => {
    let backslashCount = 0;

    for (let index = pos - 1; index >= 0 && src[index] === "\\"; index -= 1) {
      backslashCount += 1;
    }

    return backslashCount % 2 === 1;
  };

  const cleanMath = (content) => content.replace(/\\\*/g, "*");

  const inlineRule = (state, silent) => {
    const start = state.pos;
    if (state.src[start] !== "$") {
      return false;
    }
    if (state.src[start + 1] === "$") {
      return false;
    }

    let match = start + 1;
    while ((match = state.src.indexOf("$", match)) !== -1) {
      if (isEscaped(state.src, match)) {
        match += 1;
        continue;
      }

      const content = state.src.slice(start + 1, match);
      if (!content.trim()) {
        match += 1;
        continue;
      }

      if (!silent) {
        const token = state.push("math_inline", "math", 0);
        token.content = content.trim();
      }

      state.pos = match + 1;
      return true;
    }

    return false;
  };

  const blockRule = (state, startLine, endLine, silent) => {
    const startPos = state.bMarks[startLine] + state.tShift[startLine];
    const maxPos = state.eMarks[startLine];
    const line = state.src.slice(startPos, maxPos);

    if (!line.startsWith("$$")) {
      return false;
    }

    if (line.slice(2).includes("$$")) {
      const closeIndex = line.indexOf("$$", 2);
      const content = line.slice(2, closeIndex).trim();

      if (!silent) {
        const token = state.push("math_block", "math", 0);
        token.block = true;
        token.content = content;
        token.map = [startLine, startLine + 1];
        token.markup = "$$";
      }

      state.line = startLine + 1;
      return true;
    }

    for (let nextLine = startLine + 1; nextLine < endLine; nextLine += 1) {
      const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineEnd = state.eMarks[nextLine];
      const text = state.src.slice(lineStart, lineEnd);

      if (!text.startsWith("$$")) {
        continue;
      }

      const firstLine = state.src.slice(startPos + 2, maxPos);
      const middle = state.getLines(startLine + 1, nextLine, state.tShift[startLine], true);
      const lastLine = text.slice(2);
      const content = [firstLine, middle, lastLine].join("\n").trim();

      if (!silent) {
        const token = state.push("math_block", "math", 0);
        token.block = true;
        token.content = content;
        token.map = [startLine, nextLine + 1];
        token.markup = "$$";
      }

      state.line = nextLine + 1;
      return true;
    }

    return false;
  };

  markdownItInstance.inline.ruler.after("escape", "math_inline", inlineRule);
  markdownItInstance.block.ruler.after("blockquote", "math_block", blockRule, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });

  markdownItInstance.renderer.rules.math_inline = (tokens, index) =>
    katexInstance.renderToString(cleanMath(tokens[index].content), {
      throwOnError: false,
    });

  markdownItInstance.renderer.rules.math_block = (tokens, index) =>
    katexInstance.renderToString(cleanMath(tokens[index].content), {
      displayMode: true,
      throwOnError: false,
    });
}

function createRenderer() {
  if (!window.markdownit || !window.katex) {
    return null;
  }

  const markdownItInstance = window.markdownit({
    breaks: true,
    html: false,
    linkify: true,
  });

  attachMathRenderer(markdownItInstance, window.katex);

  const defaultFence = markdownItInstance.renderer.rules.fence || null;

  markdownItInstance.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const language = token.info ? token.info.trim() : "";
    const rawFence = defaultFence
      ? defaultFence(tokens, index, options, env, self)
      : self.renderToken(tokens, index, options);

    return `<div class="message__codeblock" data-language="${escapeHtml(language)}">${rawFence}</div>`;
  };

  markdownItInstance.renderer.rules.code_inline = (tokens, index) =>
    `<code class="message__inline-code">${markdownItInstance.utils.escapeHtml(tokens[index].content)}</code>`;

  return markdownItInstance;
}

let renderer = null;

export function renderMessageContent(message) {
  if (!renderer) {
    renderer = createRenderer();
  }

  if (!renderer) {
    return `<pre class="message__plaintext">${escapeHtml(message || "")}</pre>`;
  }

  return renderer.render(normalizeMathDelimiters(message || ""));
}
