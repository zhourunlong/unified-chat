import { DEFAULT_CHAT_CONFIG } from "../../shared/model-catalog.js";

export const DEFAULT_VAULT_STATE = {
  providerKeys: {},
  chats: [],
  activeChatId: null,
};

function createTimestamp() {
  return new Date().toISOString();
}

export function createEmptyVault() {
  return structuredClone(DEFAULT_VAULT_STATE);
}

export function createMessageNode({
  createdAt = createTimestamp(),
  error = null,
  id = crypto.randomUUID(),
  isEdited = false,
  operation = null,
  operationId = null,
  parentId = null,
  reasoningSummary = "",
  role,
  status = "",
  text = "",
} = {}) {
  return {
    activeChildId: null,
    childIds: [],
    context: null,
    createdAt,
    error,
    id,
    isEdited,
    operation,
    operationId,
    parentId,
    reasoningSummary,
    role,
    status,
    text,
  };
}

export function createChat(config = {}) {
  return {
    context: null,
    id: crypto.randomUUID(),
    title: "New chat",
    createdAt: createTimestamp(),
    updatedAt: createTimestamp(),
    config: {
      ...DEFAULT_CHAT_CONFIG,
      ...config,
    },
    isSubmitting: false,
    pendingMessageId: null,
    pendingOperation: null,
    pendingOperationId: null,
    messageNodes: {},
    rootMessageIds: [],
    activeRootMessageId: null,
  };
}

function linkChild(chat, parentId, childId) {
  if (!parentId) {
    if (!chat.rootMessageIds.includes(childId)) {
      chat.rootMessageIds.push(childId);
    }
    chat.activeRootMessageId = childId;
    return;
  }

  const parent = chat.messageNodes[parentId];
  if (!parent) {
    return;
  }

  if (!parent.childIds.includes(childId)) {
    parent.childIds.push(childId);
  }
  parent.activeChildId = childId;
}

export function migrateLinearMessagesToTree(chat) {
  const linearMessages = Array.isArray(chat.messages) ? chat.messages : [];
  if (linearMessages.length === 0) {
    chat.messageNodes = chat.messageNodes || {};
    chat.rootMessageIds = Array.isArray(chat.rootMessageIds) ? chat.rootMessageIds : [];
    chat.activeRootMessageId = chat.activeRootMessageId || null;
    delete chat.messages;
    return chat;
  }

  const nodes = {};
  let parentId = null;
  let rootId = null;
  let previousNode = null;

  for (const message of linearMessages) {
    const node = createMessageNode({
      createdAt: message.createdAt,
      error: message.error || null,
      id: message.id,
      isEdited: false,
      operation: message.operation || null,
      operationId: message.operationId || message.operation?.id || message.operation?.data?.responseId || null,
      parentId,
      reasoningSummary: message.reasoningSummary || "",
      role: message.role,
      status: message.status || "",
      text: message.text || "",
    });
    nodes[node.id] = node;

    if (!parentId) {
      rootId = node.id;
    } else {
      previousNode.childIds.push(node.id);
      previousNode.activeChildId = node.id;
    }

    parentId = node.id;
    previousNode = node;
  }

  if (previousNode?.role === "assistant" && chat.context) {
    previousNode.context = chat.context;
  }

  chat.messageNodes = nodes;
  chat.rootMessageIds = rootId ? [rootId] : [];
  chat.activeRootMessageId = rootId;
  delete chat.messages;

  return chat;
}

export function normalizeChatTree(chat) {
  if (!chat.messageNodes || typeof chat.messageNodes !== "object" || Array.isArray(chat.messageNodes)) {
    chat.messageNodes = {};
  }

  chat.rootMessageIds = Array.isArray(chat.rootMessageIds) ? chat.rootMessageIds.filter((id) => typeof id === "string") : [];
  chat.activeRootMessageId = typeof chat.activeRootMessageId === "string" ? chat.activeRootMessageId : null;

  for (const [id, node] of Object.entries(chat.messageNodes)) {
    node.id = id;
    node.isEdited = node.isEdited === true;
    node.parentId = typeof node.parentId === "string" ? node.parentId : null;
    node.childIds = Array.isArray(node.childIds) ? node.childIds.filter((childId) => typeof childId === "string") : [];
    node.activeChildId = typeof node.activeChildId === "string" ? node.activeChildId : null;
    node.context = node.context || null;
    node.createdAt = node.createdAt || createTimestamp();
    node.error = node.error || null;
    node.operation = node.operation || null;
    node.operationId = node.operationId || node.operation?.id || node.operation?.data?.responseId || null;
    node.reasoningSummary = node.reasoningSummary || "";
    node.status = node.status || "";
    node.text = typeof node.text === "string" ? node.text : "";
  }

  chat.rootMessageIds = chat.rootMessageIds.filter((id) => chat.messageNodes[id] && chat.messageNodes[id].parentId === null);
  if (!chat.activeRootMessageId || !chat.messageNodes[chat.activeRootMessageId]) {
    chat.activeRootMessageId = chat.rootMessageIds[0] || null;
  }

  for (const node of Object.values(chat.messageNodes)) {
    node.childIds = node.childIds.filter((childId) => chat.messageNodes[childId]?.parentId === node.id);
    if (!node.activeChildId || !node.childIds.includes(node.activeChildId)) {
      node.activeChildId = node.childIds[0] || null;
    }
  }

  return chat;
}

export function getMessageNode(chat, messageId) {
  return chat?.messageNodes?.[messageId] || null;
}

export function getSiblingMessageIds(chat, messageId) {
  const node = getMessageNode(chat, messageId);
  if (!node) {
    return [];
  }

  if (!node.parentId) {
    return chat.rootMessageIds || [];
  }

  return getMessageNode(chat, node.parentId)?.childIds || [];
}

export function getActiveMessageIds(chat) {
  const ids = [];
  let currentId = chat?.activeRootMessageId || null;

  while (currentId) {
    const node = getMessageNode(chat, currentId);
    if (!node) {
      break;
    }

    ids.push(node.id);
    currentId = node.activeChildId || null;
  }

  return ids;
}

export function getActiveMessages(chat) {
  return getActiveMessageIds(chat)
    .map((id) => getMessageNode(chat, id))
    .filter(Boolean);
}

export function getActiveLeafMessage(chat) {
  const activeMessages = getActiveMessages(chat);
  return activeMessages[activeMessages.length - 1] || null;
}

export function selectMessageBranch(chat, messageId) {
  const node = getMessageNode(chat, messageId);
  if (!node) {
    return false;
  }

  if (!node.parentId) {
    chat.activeRootMessageId = node.id;
    return true;
  }

  const parent = getMessageNode(chat, node.parentId);
  if (!parent) {
    return false;
  }

  parent.activeChildId = node.id;
  return true;
}

export function appendChildMessage(chat, parentId, message) {
  const node = createMessageNode({
    ...message,
    parentId,
  });

  chat.messageNodes[node.id] = node;
  linkChild(chat, parentId, node.id);
  return node;
}

export function createSiblingMessage(chat, targetMessageId, message) {
  const target = getMessageNode(chat, targetMessageId);
  if (!target) {
    return null;
  }

  return appendChildMessage(chat, target.parentId, message);
}

export function getBranchContext(chat) {
  const activeMessages = getActiveMessages(chat);

  for (let index = activeMessages.length - 1; index >= 0; index -= 1) {
    if (activeMessages[index]?.isEdited) {
      return null;
    }

    if (activeMessages[index]?.context) {
      return activeMessages[index].context;
    }
  }

  return null;
}

export function isChatLocked(chat) {
  return (chat?.rootMessageIds?.length || 0) > 0;
}
