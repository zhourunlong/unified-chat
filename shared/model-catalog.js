export const PROVIDERS = [
  {
    id: "openai",
    label: "GPT",
    tagline: "Responses API with background mode",
    status: "active",
    apiKeyLabel: "OpenAI API key",
    envKeyName: "OPENAI_API_KEY",
    models: [
      {
        id: "gpt-5",
        label: "GPT-5",
        description: "Highest quality reasoning for hard prompts.",
        reasoningEfforts: ["minimal", "low", "medium", "high"],
      },
      {
        id: "gpt-5-mini",
        label: "GPT-5 Mini",
        description: "Faster and cheaper general reasoning default.",
        reasoningEfforts: ["minimal", "low", "medium", "high"],
      },
      {
        id: "gpt-5-nano",
        label: "GPT-5 Nano",
        description: "Lowest latency GPT option for lightweight tasks.",
        reasoningEfforts: ["minimal", "low", "medium", "high"],
      },
    ],
  },
  {
    id: "anthropic",
    label: "Claude",
    tagline: "Provider module placeholder",
    status: "coming_soon",
    apiKeyLabel: "Anthropic API key",
    envKeyName: "ANTHROPIC_API_KEY",
    models: [],
  },
  {
    id: "google",
    label: "Gemini",
    tagline: "Provider module placeholder",
    status: "coming_soon",
    apiKeyLabel: "Google AI API key",
    envKeyName: "GEMINI_API_KEY",
    models: [],
  },
  {
    id: "xai",
    label: "Grok",
    tagline: "Provider module placeholder",
    status: "coming_soon",
    apiKeyLabel: "xAI API key",
    envKeyName: "XAI_API_KEY",
    models: [],
  },
];

export const DEFAULT_CHAT_CONFIG = {
  providerId: "openai",
  modelId: "gpt-5-mini",
  reasoningEffort: "medium",
  systemPrompt: "",
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
