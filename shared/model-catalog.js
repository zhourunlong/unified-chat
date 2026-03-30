export const PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    tagline: "Responses API with background mode",
    status: "active",
    apiKeyLabel: "OpenAI API key",
    capabilities: {
      contextManagement: true,
      modelSelection: true,
      reasoningSummaryStreaming: true,
      responseRetrieval: true,
      responseStreaming: true,
      runCancellation: true,
      titleSummarization: true,
    },
    models: [
      {
        id: "gpt-5.4",
        label: "GPT-5.4",
        description: "General-purpose work, including complex reasoning, broad world knowledge, and code-heavy or multi-step agentic tasks.",
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
      },
      {
        id: "gpt-5.4-pro",
        label: "GPT-5.4 Pro",
        description: "Tough problems that may take longer to solve and need deeper reasoning.",
        reasoningEfforts: ["medium", "high", "xhigh"],
      },
      {
        id: "gpt-5.4-mini",
        label: "GPT-5.4 Mini",
        description: "High-volume coding, computer use, and agent workflows that still need strong reasoning.",
        reasoningEfforts: ["none", "low", "medium", "high"],
      },
      {
        id: "gpt-5.4-nano",
        label: "GPT-5.4 Nano",
        description: "Simple high-throughput tasks where speed and cost matter most.",
        reasoningEfforts: ["none", "low", "medium", "high"],
      },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    tagline: "Messages API with streaming",
    status: "active",
    apiKeyLabel: "Anthropic API key",
    capabilities: {
      contextManagement: true,
      modelSelection: true,
      reasoningSummaryStreaming: true,
      responseRetrieval: false,
      responseStreaming: true,
      runCancellation: false,
      titleSummarization: true,
    },
    models: [
      {
        id: "claude-opus-4-6",
        label: "Claude Opus 4.6",
        description: "Anthropic's most capable model for complex reasoning, coding, and long-horizon agent work.",
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
      },
      {
        id: "claude-sonnet-4-5-20250929",
        label: "Claude Sonnet 4.5",
        description: "Strong general-purpose performance with lower latency than Opus.",
        reasoningEfforts: ["none", "low", "medium", "high"],
      },
      {
        id: "claude-haiku-4-5-20251001",
        label: "Claude Haiku 4.5",
        description: "Fastest Anthropic model with strong everyday reasoning and coding quality.",
        reasoningEfforts: ["none", "low", "medium"],
      },
    ],
  },
  {
    id: "google",
    label: "Google",
    tagline: "Gemini API with streamed content generation",
    status: "active",
    apiKeyLabel: "Google AI API key",
    capabilities: {
      contextManagement: true,
      modelSelection: true,
      reasoningSummaryStreaming: true,
      responseRetrieval: false,
      responseStreaming: true,
      runCancellation: false,
      titleSummarization: true,
    },
    models: [
      {
        id: "gemini-2.5-pro",
        label: "Gemini 2.5 Pro",
        description: "Google's strongest reasoning model for coding and complex multimodal tasks.",
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
      },
      {
        id: "gemini-2.5-flash",
        label: "Gemini 2.5 Flash",
        description: "Balanced Gemini model with strong reasoning and lower latency.",
        reasoningEfforts: ["none", "low", "medium", "high"],
      },
      {
        id: "gemini-2.5-flash-lite",
        label: "Gemini 2.5 Flash-Lite",
        description: "Fast, cost-efficient Gemini model for high-frequency requests.",
        reasoningEfforts: ["none", "low", "medium"],
      },
    ],
  },
  {
    id: "xai",
    label: "xAI",
    tagline: "Responses API with Grok models",
    status: "active",
    apiKeyLabel: "xAI API key",
    capabilities: {
      contextManagement: true,
      modelSelection: true,
      reasoningSummaryStreaming: true,
      responseRetrieval: true,
      responseStreaming: true,
      runCancellation: false,
      titleSummarization: true,
    },
    models: [
      {
        id: "grok-4-fast-reasoning",
        label: "Grok 4 Fast Reasoning",
        description: "Latest fast reasoning model from xAI with a large context window.",
        reasoningEfforts: ["none"],
      },
      {
        id: "grok-4-fast-non-reasoning",
        label: "Grok 4 Fast",
        description: "Fast non-reasoning Grok model for general text generation.",
        reasoningEfforts: ["none"],
      },
      {
        id: "grok-3-mini",
        label: "Grok 3 Mini",
        description: "Smaller Grok model with configurable reasoning effort.",
        reasoningEfforts: ["none", "low", "medium", "high"],
      },
    ],
  },
];

export const DEFAULT_CHAT_CONFIG = {
  providerId: "openai",
  modelId: "gpt-5.4-mini",
  reasoningEffort: "medium",
};

export function getProviderById(providerId) {
  return PROVIDERS.find((provider) => provider.id === providerId) || null;
}

export function getModelById(providerId, modelId) {
  const provider = getProviderById(providerId);

  if (!provider) {
    return null;
  }

  return provider.models.find((model) => model.id === modelId) || null;
}
