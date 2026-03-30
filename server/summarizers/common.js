export const SUMMARY_PROMPT = "Summarize a topic for the following message in 5 words. Output only the topic content.\n\n----- Message -----\n";

export function clipSummaryMessage(message, limit = 300) {
  return message.length > limit
    ? `${message.slice(0, limit)}...`
    : message;
}

export function normalizeSummaryTitle(text) {
  return String(text || "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}
