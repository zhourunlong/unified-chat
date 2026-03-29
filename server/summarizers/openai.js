import { getOpenAISystemPrompt } from "../prompts/openai.js";

const SUMMARY_MODEL_ID = "gpt-5.4-nano";
const SUMMARY_PROMPT = "Summarize a topic for the following message in 5 words. Output only the topic content.\n\n----- Message -----\n";

function normalizeTopic(text) {
  return String(text || "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function getOpenAISummaryConfig() {
  return {
    modelId: SUMMARY_MODEL_ID,
    reasoningEffort: "none",
  };
}

export function buildOpenAISummaryRequest(firstUserMessage) {
  const clippedMessage = firstUserMessage.length > 300
    ? `${firstUserMessage.slice(0, 300)}...`
    : firstUserMessage;

  return {
    instructions: getOpenAISystemPrompt(SUMMARY_MODEL_ID),
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `${SUMMARY_PROMPT}${clippedMessage}`,
          },
        ],
      },
    ],
    model: SUMMARY_MODEL_ID,
    reasoning: {
      effort: "none",
    },
    store: false,
  };
}

export function normalizeSummaryTitle(text) {
  return normalizeTopic(text);
}
