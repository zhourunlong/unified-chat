import { DEFAULT_CHAT_CONFIG } from "../../shared/model-catalog.js";

export const DEFAULT_VAULT_STATE = {
  providerKeys: {},
  chats: [],
  activeChatId: null,
};

export function createEmptyVault() {
  return structuredClone(DEFAULT_VAULT_STATE);
}

export function createChat(config = {}) {
  return {
    context: null,
    id: crypto.randomUUID(),
    title: "New chat",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: {
      ...DEFAULT_CHAT_CONFIG,
      ...config,
    },
    isSubmitting: false,
    pendingOperation: null,
    pendingOperationId: null,
    messages: [],
  };
}

export function isChatLocked(chat) {
  return chat.messages.length > 0;
}
