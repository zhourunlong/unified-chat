import { DEFAULT_CHAT_CONFIG } from "/shared/model-catalog.js";

export const DEFAULT_APP_STATE = {
  providerKeys: {},
  chats: [],
  activeChatId: null,
};

export function createChat(config = {}) {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: {
      ...DEFAULT_CHAT_CONFIG,
      ...config,
    },
    isSubmitting: false,
    lastResponseId: null,
    pendingResponseId: null,
    messages: [],
  };
}

export function isChatLocked(chat) {
  return chat.messages.length > 0;
}
