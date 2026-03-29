export const PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    tagline: "Responses API with background mode",
    status: "active",
    apiKeyLabel: "OpenAI API key",
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
    tagline: "Provider module placeholder",
    status: "coming_soon",
    apiKeyLabel: "Anthropic API key",
    models: [],
  },
  {
    id: "google",
    label: "Google",
    tagline: "Provider module placeholder",
    status: "coming_soon",
    apiKeyLabel: "Google AI API key",
    models: [],
  },
  {
    id: "xai",
    label: "xAI",
    tagline: "Provider module placeholder",
    status: "coming_soon",
    apiKeyLabel: "xAI API key",
    models: [],
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
