import { DEFAULT_CHAT_CONFIG, getProviderById } from "../shared/model-catalog.js";
import {
  cancelProviderResponse,
  createProviderResponseStream,
  fetchCatalog,
  fetchSession,
  loginUser,
  logoutUser,
  registerUser,
  retrieveProviderResponse,
  saveVault,
  summarizeChatTitle,
} from "./lib/api.js";
import { renderMessageContent } from "./lib/markdown.js";
import { consumeProviderStream } from "./lib/response-stream.js";
import {
  appendChildMessage,
  createChat,
  createEmptyVault,
  createSiblingMessage,
  getActiveLeafMessage,
  getActiveMessages,
  getMessageNode,
  getSiblingMessageIds,
  isChatLocked,
  migrateLinearMessagesToTree,
  normalizeChatTree,
  selectMessageBranch,
} from "./lib/state.js";

const pollInFlight = new Set();
const streamInFlight = new Set();
const streamControllers = new Map();
const POLL_INTERVAL_MS = 2500;
let renderQueued = false;
let persistQueue = Promise.resolve();
let pollTimer = null;
let catalog = {
  providers: [],
  defaultChatConfig: DEFAULT_CHAT_CONFIG,
};

const uiState = {
  authMessage: "",
  authMode: "login",
  editing: null,
  session: null,
  vault: createEmptyVault(),
};

const ACTION_BUTTON_CONTENT = {
  cancel: {
    ariaLabel: "Stop response",
    icon: `
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <rect x="5" y="5" width="14" height="14" rx="2.5" ry="2.5"></rect>
      </svg>
    `,
    title: "Stop response",
  },
  send: {
    ariaLabel: "Send message",
    icon: `
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <path d="M12 3.75c-.58 0-1.13.24-1.53.67L4.94 10.3c-.79.84-.2 2.2.94 2.2H9.2v4.82a2.8 2.8 0 0 0 5.6 0V12.5h3.32c1.14 0 1.73-1.36.94-2.2l-5.55-5.88c-.4-.43-.95-.67-1.51-.67Z"></path>
      </svg>
    `,
    title: "Send message",
  },
};

const elements = {
  appShell: document.querySelector("#app-shell"),
  authMessage: document.querySelector("#auth-message"),
  authScreen: document.querySelector("#auth-screen"),
  authSubtitle: document.querySelector("#auth-subtitle"),
  chatCount: document.querySelector("#chat-count"),
  chatList: document.querySelector("#chat-list"),
  chatTitle: document.querySelector("#chat-title"),
  composerActionButton: document.querySelector("#composer-action-button"),
  composerActionIcon: document.querySelector("#composer-action-icon"),
  composerActionLabel: document.querySelector("#composer-action-label"),
  composer: document.querySelector("#composer"),
  currentUsername: document.querySelector("#current-username"),
  loginForm: document.querySelector("#login-form"),
  loginPassword: document.querySelector("#login-password"),
  loginTab: document.querySelector("#login-tab"),
  loginUsername: document.querySelector("#login-username"),
  logoutButton: document.querySelector("#logout-button"),
  messageInput: document.querySelector("#message-input"),
  messages: document.querySelector("#messages"),
  messageTemplate: document.querySelector("#message-template"),
  modelSelect: document.querySelector("#model-select"),
  newChatButton: document.querySelector("#new-chat-button"),
  providerSelect: document.querySelector("#provider-select"),
  reasoningSelect: document.querySelector("#reasoning-select"),
  registerConfirm: document.querySelector("#register-confirm"),
  registerForm: document.querySelector("#register-form"),
  registerPassword: document.querySelector("#register-password"),
  registerTab: document.querySelector("#register-tab"),
  registerUsername: document.querySelector("#register-username"),
  markdownItScript: document.querySelector("#markdown-it-script"),
  katexScript: document.querySelector("#katex-script"),
  settingsClose: document.querySelector("#settings-close"),
  settingsFields: document.querySelector("#settings-fields"),
  settingsPanel: document.querySelector("#settings-panel"),
  settingsToggle: document.querySelector("#settings-toggle"),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getModels(providerId) {
  return getProviderById(providerId)?.models || [];
}

function getProviderCapabilities(providerId) {
  return getProviderById(providerId)?.capabilities || {};
}

function getApiKey(providerId) {
  return uiState.vault.providerKeys[providerId] || "";
}

function hasConfiguredApiKey(providerId) {
  return getApiKey(providerId).trim().length > 0;
}

function persistVault() {
  if (!uiState.session) {
    return Promise.resolve();
  }

  const snapshot = structuredClone(uiState.vault);
  persistQueue = persistQueue
    .catch(() => {})
    .then(() => saveVault(snapshot))
    .catch((error) => {
      uiState.authMessage = error.message || "Failed to save encrypted vault.";
      renderAuth();
    });

  return persistQueue;
}

function clearEditingState({ render: shouldRender = true } = {}) {
  uiState.editing = null;

  if (shouldRender) {
    requestRender();
  }
}

function normalizeVault() {
  uiState.vault.providerKeys = uiState.vault.providerKeys || {};
  uiState.vault.chats = Array.isArray(uiState.vault.chats) ? uiState.vault.chats : [];

  for (const chat of uiState.vault.chats) {
    const provider = getProviderById(chat.config?.providerId) || getProviderById(catalog.defaultChatConfig.providerId);
    const model = provider?.models.find((entry) => entry.id === chat.config?.modelId) || provider?.models[0];
    const reasoningEffort = model?.reasoningEfforts.includes(chat.config?.reasoningEffort)
      ? chat.config.reasoningEffort
      : model?.reasoningEfforts[0] || catalog.defaultChatConfig.reasoningEffort;

    chat.config = {
      ...catalog.defaultChatConfig,
      ...(chat.config || {}),
      providerId: provider?.id || catalog.defaultChatConfig.providerId,
      modelId: model?.id || catalog.defaultChatConfig.modelId,
      reasoningEffort,
    };

    migrateLinearMessagesToTree(chat);
    normalizeChatTree(chat);
    chat.isSubmitting = Boolean(chat.isSubmitting);
    chat.context = chat.context || null;
    chat.pendingMessageId = chat.pendingMessageId || null;
    chat.pendingOperation = chat.pendingOperation || null;
    chat.pendingOperationId = chat.pendingOperationId || chat.pendingOperation?.id || chat.pendingOperation?.data?.responseId || null;
  }

  if (uiState.editing) {
    const activeChat = uiState.vault.chats.find((chat) => chat.id === uiState.editing.chatId);
    if (!activeChat || !getMessageNode(activeChat, uiState.editing.messageId)) {
      clearEditingState({ render: false });
    }
  }
}

function ensureActiveChat() {
  if (uiState.vault.chats.length === 0) {
    const chat = createChat(catalog.defaultChatConfig);
    uiState.vault.chats.push(chat);
    uiState.vault.activeChatId = chat.id;
    persistVault();
  }

  if (!uiState.vault.activeChatId || !uiState.vault.chats.some((chat) => chat.id === uiState.vault.activeChatId)) {
    uiState.vault.activeChatId = uiState.vault.chats[0].id;
    persistVault();
  }
}

function getActiveChat() {
  return uiState.vault.chats.find((chat) => chat.id === uiState.vault.activeChatId) || null;
}

function getEditingMessage(chat = getActiveChat()) {
  if (!uiState.editing || !chat || chat.id !== uiState.editing.chatId) {
    return null;
  }

  return getMessageNode(chat, uiState.editing.messageId);
}

function hasEditablePendingState(chat = getActiveChat()) {
  return Boolean(chat?.isSubmitting || chat?.pendingOperation);
}

function getActivePendingAssistant(chat) {
  return chat?.pendingMessageId
    ? getMessageNode(chat, chat.pendingMessageId)
    : null;
}

function getMessageBranchPosition(chat, messageId) {
  const siblingIds = getSiblingMessageIds(chat, messageId);
  const siblingIndex = siblingIds.indexOf(messageId);

  return {
    count: siblingIds.length,
    index: siblingIndex,
    siblingIds,
  };
}

function setEditingMessage(chatId, messageId) {
  uiState.editing = { chatId, messageId };
  requestRender();
}

function hasPendingOperations() {
  if (!uiState.session) {
    return false;
  }

  return uiState.vault.chats.some((chat) => chat.pendingOperation && chat.pendingOperationId);
}

function stopPollingPendingChats() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function syncPendingChatPolling({ immediate = false } = {}) {
  const shouldPoll = document.visibilityState === "visible" && hasPendingOperations();

  if (!shouldPoll) {
    stopPollingPendingChats();
    return;
  }

  if (pollTimer === null) {
    pollTimer = window.setInterval(() => {
      void pollPendingChats();
    }, POLL_INTERVAL_MS);
  }

  if (immediate) {
    void pollPendingChats();
  }
}

function buildChatHistory(chat) {
  if (!chat) {
    return [];
  }

  return getActiveMessages(chat)
    .filter((message) => (message.role === "user" || message.role === "assistant") && typeof message.text === "string" && message.text.trim())
    .map((message) => ({
      role: message.role,
      text: message.text.trim(),
    }));
}

function getRequestContext(chat) {
  const activeMessages = getActiveMessages(chat);
  let contextIndex = -1;

  for (let index = activeMessages.length - 1; index >= 0; index -= 1) {
    if (activeMessages[index]?.context) {
      contextIndex = index;
      break;
    }
  }

  if (contextIndex === -1) {
    return null;
  }

  const trailingMessages = activeMessages
    .slice(contextIndex + 1)
    .filter((message, index, list) => {
      const isTrailingPlaceholder = index === list.length - 1
        && message.role === "assistant"
        && message.status === "queued"
        && !message.text
        && !message.operationId;

      return !isTrailingPlaceholder;
    });

  if (trailingMessages.length === 0) {
    return activeMessages[contextIndex].context;
  }

  if (trailingMessages.length === 1 && trailingMessages[0].role === "user") {
    return activeMessages[contextIndex].context;
  }

  return null;
}

function requestRender() {
  if (renderQueued) {
    return;
  }

  renderQueued = true;
  window.requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function mutateChat(chatId, updater, { persist = true, render: shouldRender = true } = {}) {
  const index = uiState.vault.chats.findIndex((chat) => chat.id === chatId);

  if (index === -1) {
    return;
  }

  const nextChat = updater(structuredClone(uiState.vault.chats[index]));
  nextChat.updatedAt = new Date().toISOString();
  uiState.vault.chats[index] = nextChat;

  if (persist) {
    persistVault();
  }

  syncPendingChatPolling();

  if (shouldRender) {
    requestRender();
  }
}

function updateChat(chatId, updater) {
  mutateChat(chatId, updater);
}

function setActiveChat(chatId) {
  if (uiState.editing?.chatId && uiState.editing.chatId !== chatId) {
    clearEditingState({ render: false });
  }
  uiState.vault.activeChatId = chatId;
  persistVault();
  render();
}

function buildStatusLabel(message) {
  if (message.error) {
    return "Error";
  }

  if (!message.status) {
    return "";
  }

  return message.status.replaceAll("_", " ");
}

function setAuthMode(mode) {
  uiState.authMode = mode;
  uiState.authMessage = "";
  renderAuth();
}

function renderAuth() {
  const loggedIn = Boolean(uiState.session);
  elements.authScreen.classList.toggle("auth-screen--hidden", loggedIn);
  elements.appShell.classList.toggle("shell--hidden", !loggedIn);
  elements.loginTab.classList.toggle("auth-tab--active", uiState.authMode === "login");
  elements.registerTab.classList.toggle("auth-tab--active", uiState.authMode === "register");
  elements.loginForm.hidden = uiState.authMode !== "login";
  elements.registerForm.hidden = uiState.authMode !== "register";
  elements.authMessage.textContent = uiState.authMessage;
  elements.authSubtitle.textContent = uiState.authMode === "login"
    ? "Log in with your username and password. The local server matches a one-way credential probe against encrypted vault records."
    : "Create a local account. The stored vault record contains no plaintext username, password, or API keys.";
}

function renderChatList() {
  elements.chatCount.textContent = String(uiState.vault.chats.length);
  elements.chatList.replaceChildren();

  for (const chat of uiState.vault.chats) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chat-list__item${chat.id === uiState.vault.activeChatId ? " chat-list__item--active" : ""}`;
    button.innerHTML = `
      <p class="chat-list__title">${escapeHtml(chat.title)}</p>
      <p class="chat-list__meta">${escapeHtml(chat.config.modelId)} · ${escapeHtml(chat.config.reasoningEffort)}</p>
    `;
    button.addEventListener("click", () => setActiveChat(chat.id));
    elements.chatList.append(button);
  }
}

function renderSettings() {
  elements.settingsFields.replaceChildren();

  for (const provider of catalog.providers) {
    const label = document.createElement("label");
    const disabled = provider.status !== "active";
    label.innerHTML = `
      <span>${escapeHtml(provider.apiKeyLabel)}${disabled ? " (coming soon)" : ""}</span>
      <input
        type="password"
        ${disabled ? "disabled" : ""}
        placeholder="${disabled ? "" : "Required"}"
        value="${escapeHtml(getApiKey(provider.id))}"
      />
    `;

    const input = label.querySelector("input");
    if (!disabled && input) {
      input.addEventListener("change", (event) => {
        uiState.vault.providerKeys[provider.id] = event.target.value.trim();
        persistVault();
        requestRender();
      });
    }

    elements.settingsFields.append(label);
  }
}

function createMessageControlButton(label, onClick, { disabled = false, title = label } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "message__control-button";
  button.textContent = label;
  button.title = title;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function handleEditMessage(chatId, messageId) {
  const chat = uiState.vault.chats.find((entry) => entry.id === chatId);
  const message = chat ? getMessageNode(chat, messageId) : null;

  if (!chat || !message || hasEditablePendingState(chat)) {
    return;
  }

  uiState.vault.activeChatId = chatId;
  setEditingMessage(chatId, messageId);
  elements.messageInput.value = message.text || "";
  elements.messageInput.focus();
}

function handleSwitchMessageSibling(chatId, messageId, direction) {
  const chat = uiState.vault.chats.find((entry) => entry.id === chatId);
  if (!chat || hasEditablePendingState(chat)) {
    return;
  }

  const { count, index, siblingIds } = getMessageBranchPosition(chat, messageId);
  if (count <= 1 || index === -1) {
    return;
  }

  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= count) {
    return;
  }

  const previousScrollTop = elements.messages.scrollTop;
  if (!selectMessageBranch(chat, siblingIds[nextIndex])) {
    return;
  }

  clearEditingState({ render: false });
  if (uiState.vault.activeChatId !== chatId) {
    uiState.vault.activeChatId = chatId;
  }
  persistVault();
  render({ preserveScrollTop: previousScrollTop, scrollToBottom: false });
}

function renderConfig(chat) {
  const providerOptions = catalog.providers
    .filter((provider) => provider.status === "active")
    .map((provider) => `<option value="${provider.id}">${escapeHtml(provider.label)}</option>`)
    .join("");
  elements.providerSelect.innerHTML = providerOptions;
  elements.providerSelect.value = chat.config.providerId;

  const models = getModels(chat.config.providerId);
  elements.modelSelect.innerHTML = models
    .map((model) => `<option value="${model.id}">${escapeHtml(model.label)}</option>`)
    .join("");
  const selectedModelId = models.some((model) => model.id === chat.config.modelId)
    ? chat.config.modelId
    : models[0]?.id;
  elements.modelSelect.value = selectedModelId;

  const activeModel = models.find((model) => model.id === selectedModelId) || models[0];
  const efforts = activeModel?.reasoningEfforts || ["medium"];
  elements.reasoningSelect.innerHTML = efforts
    .map((effort) => `<option value="${effort}">${escapeHtml(capitalize(effort))}</option>`)
    .join("");
  elements.reasoningSelect.value = efforts.includes(chat.config.reasoningEffort)
    ? chat.config.reasoningEffort
    : efforts[0];

  const locked = isChatLocked(chat);
  const hasApiKey = hasConfiguredApiKey(chat.config.providerId);
  const capabilities = getProviderCapabilities(chat.config.providerId);
  const hasPendingRun = Boolean(chat.isSubmitting || chat.pendingOperation);
  const canCancelRun = Boolean(
    streamControllers.has(chat.id)
    || (capabilities.runCancellation && chat.pendingOperation && chat.pendingOperationId),
  );
  const actionMode = hasPendingRun ? "cancel" : "send";
  const actionContent = ACTION_BUTTON_CONTENT[actionMode];
  const editingMessage = getEditingMessage(chat);
  const canEditHistory = !hasPendingRun;
  const requiresApiKey = !editingMessage || editingMessage.role === "user";

  elements.providerSelect.disabled = locked;
  elements.modelSelect.disabled = locked;
  elements.reasoningSelect.disabled = locked;
  elements.chatTitle.textContent = chat.title;
  elements.currentUsername.textContent = uiState.session?.username || "";
  elements.messageInput.disabled = (requiresApiKey && !hasApiKey) || (Boolean(editingMessage) && !canEditHistory);
  elements.messageInput.placeholder = editingMessage
    ? `Edit ${editingMessage.role} message and create a new branch`
    : "Send a message";
  elements.composerActionButton.setAttribute("aria-label", actionContent.ariaLabel);
  elements.composerActionButton.title = actionContent.title;
  elements.composerActionButton.disabled = actionMode === "send"
    ? Boolean((requiresApiKey && !hasApiKey) || chat.isSubmitting || chat.pendingOperation || (editingMessage && !canEditHistory))
    : !canCancelRun;
  elements.composerActionIcon.innerHTML = actionContent.icon;
  elements.composerActionLabel.textContent = actionContent.ariaLabel;
}

function renderMessages(chat, { preserveScrollTop = null, scrollToBottom = true } = {}) {
  elements.messages.replaceChildren();

  for (const message of getActiveMessages(chat)) {
    const fragment = elements.messageTemplate.content.cloneNode(true);
    const node = fragment.querySelector(".message");
    node.classList.add(`message--${message.role}`);
    if (message.error) {
      node.classList.add("message--error");
    }
    fragment.querySelector(".message__role").textContent = capitalize(message.role);
    fragment.querySelector(".message__status").textContent = buildStatusLabel(message);
    const metaActions = fragment.querySelector(".message__meta-actions");
    const messageBody = fragment.querySelector(".message__body");
    messageBody.innerHTML = renderMessageContent(message.error || message.text || "");

    const siblingPosition = getMessageBranchPosition(chat, message.id);
    if (siblingPosition.count > 1) {
      const branchControls = document.createElement("div");
      branchControls.className = "message__branch-controls";
      branchControls.append(
        createMessageControlButton("←", () => {
          handleSwitchMessageSibling(chat.id, message.id, -1);
        }, {
          disabled: hasEditablePendingState(chat) || siblingPosition.index <= 0,
          title: "Previous sibling branch",
        }),
      );

      const position = document.createElement("span");
      position.className = "message__branch-position";
      position.textContent = `${siblingPosition.index + 1}/${siblingPosition.count}`;
      branchControls.append(position);

      branchControls.append(
        createMessageControlButton("→", () => {
          handleSwitchMessageSibling(chat.id, message.id, 1);
        }, {
          disabled: hasEditablePendingState(chat) || siblingPosition.index >= siblingPosition.count - 1,
          title: "Next sibling branch",
        }),
      );

      metaActions.append(branchControls);
    }

    metaActions.append(
      createMessageControlButton("Edit", () => {
        handleEditMessage(chat.id, message.id);
      }, {
        disabled: hasEditablePendingState(chat),
        title: "Edit this node and create a sibling branch",
      }),
    );

    const shouldShowReasoning = message.role === "assistant" && (
      message.reasoningSummary ||
      message.status === "queued" ||
      message.status === "in_progress"
    );

    if (shouldShowReasoning) {
      const reasoningDetails = document.createElement("details");
      reasoningDetails.className = "message__reasoning";
      reasoningDetails.open = Boolean(message.reasoningSummary);
      reasoningDetails.innerHTML = `
        <summary>Reasoning summary</summary>
        <div class="message__reasoning-body${message.reasoningSummary ? "" : " message__reasoning-body--pending"}">
          ${message.reasoningSummary ? renderMessageContent(message.reasoningSummary) : "Waiting for reasoning summary..."}
        </div>
      `;
      messageBody.prepend(reasoningDetails);
    }

    elements.messages.append(fragment);
  }

  if (typeof preserveScrollTop === "number") {
    elements.messages.scrollTop = preserveScrollTop;
    return;
  }

  if (scrollToBottom) {
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }
}

function renderApp(options) {
  if (!uiState.session) {
    return;
  }

  ensureActiveChat();
  const activeChat = getActiveChat();
  if (!activeChat) {
    return;
  }

  renderChatList();
  renderSettings();
  renderConfig(activeChat);
  renderMessages(activeChat, options);
}

function render(options) {
  renderAuth();
  renderApp(options);
}

function updateConfigFromInputs() {
  const activeChat = getActiveChat();
  if (!activeChat || isChatLocked(activeChat)) {
    render();
    return;
  }

  const models = getModels(elements.providerSelect.value);
  const selectedModel = models.find((model) => model.id === elements.modelSelect.value) || models[0];
  const reasoningEffort = selectedModel?.reasoningEfforts.includes(elements.reasoningSelect.value)
    ? elements.reasoningSelect.value
    : selectedModel?.reasoningEfforts[0] || "medium";

  updateChat(activeChat.id, (chat) => {
    chat.config.providerId = elements.providerSelect.value;
    chat.config.modelId = selectedModel?.id || chat.config.modelId;
    chat.config.reasoningEffort = reasoningEffort;
    return chat;
  });
}

function createNewChat() {
  if (!uiState.session) {
    return;
  }

  clearEditingState({ render: false });
  elements.messageInput.value = "";
  const chat = createChat(catalog.defaultChatConfig);
  uiState.vault.chats.unshift(chat);
  uiState.vault.activeChatId = chat.id;
  persistVault();
  render();
  elements.messageInput.focus();
}

async function summarizeTitleForChat(chatId, providerId, firstUserMessage) {
  try {
    const payload = await summarizeChatTitle({
      firstUserMessage,
      providerId,
    });

    if (!payload.title) {
      return;
    }

    updateChat(chatId, (chat) => {
      const firstUserEntry = getActiveMessages(chat).find((message) => message.role === "user");
      if (!firstUserEntry || firstUserEntry.text !== firstUserMessage) {
        return chat;
      }

      if (chat.title === "New chat") {
        chat.title = payload.title;
      }

      return chat;
    });
  } catch {
    // Title summarization is best-effort and should not affect the main chat flow.
  }
}

function applyProviderResponse(chat, placeholderMessageId, providerResponse) {
  const message = getMessageNode(chat, placeholderMessageId);
  if (!message) {
    return;
  }

  message.operation = providerResponse.operation || message.operation || null;
  message.operationId = providerResponse.operationId || message.operationId || null;
  message.status = providerResponse.status;
  message.text = providerResponse.text || message.text;
  message.reasoningSummary = providerResponse.reasoningSummary || message.reasoningSummary || "";
  message.error = providerResponse.error?.message || null;

  if (providerResponse.isTerminal) {
    if (chat.pendingMessageId === placeholderMessageId) {
      clearPendingAssistant(chat);
    }
    if (!providerResponse.error && providerResponse.context) {
      message.context = providerResponse.context;
    }
  } else {
    setPendingAssistant(chat, placeholderMessageId, providerResponse.operation, providerResponse.operationId);
  }
}

function setPendingAssistant(chat, messageId, operation, operationId) {
  chat.pendingMessageId = messageId || null;
  chat.pendingOperation = operation || null;
  chat.pendingOperationId = operationId || null;
}

function clearPendingAssistant(chat) {
  chat.pendingMessageId = null;
  chat.pendingOperation = null;
  chat.pendingOperationId = null;
}

async function runAssistantTurn(chatId, assistantMessageId, requestMessageText) {
  const activeChat = getActiveChat();
  if (!uiState.session || !activeChat || activeChat.id !== chatId) {
    return;
  }

  const streamController = new AbortController();
  streamInFlight.add(chatId);
  streamControllers.set(chatId, streamController);

  try {
    const streamResponse = await createProviderResponseStream(activeChat.config.providerId, {
      chatConfig: activeChat.config,
      context: getRequestContext(activeChat),
      history: buildChatHistory(activeChat),
      message: requestMessageText,
    }, streamController.signal);

    const finalResponse = await consumeProviderStream(streamResponse, {
      onUpdate(providerResponse, { persist }) {
        mutateChat(chatId, (chat) => {
          applyProviderResponse(chat, assistantMessageId, providerResponse);
          chat.isSubmitting = true;
          return chat;
        }, { persist, render: true });
      },
    });

    updateChat(chatId, (chat) => {
      chat.isSubmitting = false;
      applyProviderResponse(chat, assistantMessageId, finalResponse);
      return chat;
    });
  } catch (error) {
    if (streamController.signal.aborted) {
      updateChat(chatId, (chat) => {
        chat.isSubmitting = false;
        return chat;
      });
      return;
    }

    updateChat(chatId, (chat) => {
      chat.isSubmitting = false;
      const message = getMessageNode(chat, assistantMessageId);
      if (message) {
        message.error = error.message;
        message.status = "failed";
      }
      if (chat.pendingMessageId === assistantMessageId) {
        clearPendingAssistant(chat);
      }
      return chat;
    });
  } finally {
    streamInFlight.delete(chatId);
    streamControllers.delete(chatId);
  }
}

async function sendMessage() {
  const activeChat = getActiveChat();
  if (!uiState.session || !activeChat) {
    return;
  }

  const messageText = elements.messageInput.value.trim();

  if (!hasConfiguredApiKey(activeChat.config.providerId) || !messageText || activeChat.isSubmitting || activeChat.pendingOperation) {
    return;
  }

  const shouldSummarizeTitle = !getActiveMessages(activeChat).some((message) => message.role === "user");
  let assistantMessageId = null;

  updateChat(activeChat.id, (chat) => {
    chat.isSubmitting = true;
    const parentMessageId = getActiveLeafMessage(chat)?.id || null;
    const userMessage = appendChildMessage(chat, parentMessageId, {
      error: null,
      isEdited: false,
      reasoningSummary: "",
      role: "user",
      status: "",
      text: messageText,
    });
    const assistantMessage = appendChildMessage(chat, userMessage.id, {
      error: null,
      isEdited: false,
      reasoningSummary: "",
      role: "assistant",
      status: "queued",
      text: "",
    });
    assistantMessageId = assistantMessage.id;
    return chat;
  });

  if (shouldSummarizeTitle) {
    void summarizeTitleForChat(activeChat.id, activeChat.config.providerId, messageText);
  }

  elements.messageInput.value = "";
  await runAssistantTurn(activeChat.id, assistantMessageId, messageText);
}

async function submitEditedMessage() {
  const activeChat = getActiveChat();
  const editingMessage = getEditingMessage(activeChat);

  if (!uiState.session || !activeChat || !editingMessage || hasEditablePendingState(activeChat)) {
    return;
  }

  const messageText = elements.messageInput.value.trim();
  if (!messageText) {
    return;
  }

  let createdSiblingId = null;
  let assistantMessageId = null;

  updateChat(activeChat.id, (chat) => {
    const targetMessage = getMessageNode(chat, editingMessage.id);
    if (!targetMessage) {
      return chat;
    }

    const siblingMessage = createSiblingMessage(chat, targetMessage.id, {
      error: null,
      isEdited: true,
      reasoningSummary: "",
      role: targetMessage.role,
      status: "",
      text: messageText,
    });

    if (!siblingMessage) {
      return chat;
    }

    createdSiblingId = siblingMessage.id;

    if (targetMessage.role === "user") {
      chat.isSubmitting = true;
      const assistantMessage = appendChildMessage(chat, siblingMessage.id, {
        error: null,
        isEdited: false,
        reasoningSummary: "",
        role: "assistant",
        status: "queued",
        text: "",
      });
      assistantMessageId = assistantMessage.id;
    }

    return chat;
  });

  clearEditingState({ render: false });
  elements.messageInput.value = "";

  if (!createdSiblingId) {
    render();
    return;
  }

  if (editingMessage.role === "user" && assistantMessageId) {
    await runAssistantTurn(activeChat.id, assistantMessageId, messageText);
    return;
  }

  render();
}

async function pollPendingChats() {
  if (!uiState.session) {
    return;
  }

  for (const chat of uiState.vault.chats) {
    if (!chat.pendingOperation || !chat.pendingOperationId) {
      continue;
    }

    if (streamInFlight.has(chat.id)) {
      continue;
    }

    const requestKey = `${chat.id}:${chat.pendingOperationId}`;
    if (pollInFlight.has(requestKey)) {
      continue;
    }

    pollInFlight.add(requestKey);
    try {
      const payload = await retrieveProviderResponse(chat.config.providerId, chat.pendingOperation);

      updateChat(chat.id, (currentChat) => {
        const pendingAssistant = getActivePendingAssistant(currentChat);

        if (pendingAssistant) {
          applyProviderResponse(currentChat, pendingAssistant.id, payload.response);
        }

        return currentChat;
      });
    } catch (error) {
      updateChat(chat.id, (currentChat) => {
        const pendingAssistant = getActivePendingAssistant(currentChat);

        if (pendingAssistant) {
          pendingAssistant.error = error.message;
          pendingAssistant.status = "failed";
        }

        clearPendingAssistant(currentChat);
        return currentChat;
      });
    } finally {
      pollInFlight.delete(requestKey);
    }
  }
}

async function cancelActiveRun() {
  const activeChat = getActiveChat();
  if (!uiState.session || !activeChat) {
    return;
  }

  const capabilities = getProviderCapabilities(activeChat.config.providerId);
  const controller = streamControllers.get(activeChat.id);
  const canAbortLocalStream = Boolean(controller);
  const canCancelProviderRun = Boolean(capabilities.runCancellation && activeChat.pendingOperation && activeChat.pendingOperationId);

  if (!canAbortLocalStream && !canCancelProviderRun) {
    return;
  }

  elements.composerActionButton.disabled = true;

  try {
    if (canAbortLocalStream) {
      controller.abort();
    }

    if (!canCancelProviderRun) {
      updateChat(activeChat.id, (chat) => {
        chat.isSubmitting = false;
        clearPendingAssistant(chat);
        return chat;
      });
      return;
    }

    const payload = await cancelProviderResponse(activeChat.config.providerId, activeChat.pendingOperation);

    updateChat(activeChat.id, (chat) => {
      const pendingAssistant = getActivePendingAssistant(chat);

      if (pendingAssistant) {
        applyProviderResponse(chat, pendingAssistant.id, payload.response);
      }

      return chat;
    });
  } catch (error) {
    updateChat(activeChat.id, (chat) => {
      const pendingAssistant = getActivePendingAssistant(chat);

      if (pendingAssistant) {
        pendingAssistant.error = error.message;
        pendingAssistant.status = "failed";
      }

      clearPendingAssistant(chat);
      return chat;
    });
  } finally {
    elements.composerActionButton.disabled = false;
  }
}

async function handleComposerSubmit(event) {
  event.preventDefault();

  const activeChat = getActiveChat();
  if (!uiState.session || !activeChat) {
    return;
  }

  if (activeChat.isSubmitting || activeChat.pendingOperation) {
    await cancelActiveRun();
    return;
  }

  if (getEditingMessage(activeChat)) {
    await submitEditedMessage();
    return;
  }

  await sendMessage();
}

function applyAuthenticatedState(payload) {
  uiState.session = payload.authenticated
    ? {
        username: payload.username,
      }
    : null;
  uiState.vault = payload.authenticated ? payload.vault || createEmptyVault() : createEmptyVault();
  uiState.authMessage = "";
  uiState.editing = null;
  elements.messageInput.value = "";
  normalizeVault();
  syncPendingChatPolling({ immediate: true });
  render();
}

async function handleRegister(event) {
  event.preventDefault();

  const username = elements.registerUsername.value.trim();
  const password = elements.registerPassword.value;
  const confirmPassword = elements.registerConfirm.value;

  if (password !== confirmPassword) {
    uiState.authMessage = "Passwords do not match.";
    renderAuth();
    return;
  }

  try {
    const payload = await registerUser({ username, password });
    applyAuthenticatedState(payload);
    elements.registerForm.reset();
    elements.loginPassword.value = "";
  } catch (error) {
    uiState.authMessage = error.message;
    renderAuth();
  }
}

async function handleLogin(event) {
  event.preventDefault();

  const username = elements.loginUsername.value.trim();
  const password = elements.loginPassword.value;

  try {
    const payload = await loginUser({ username, password });
    applyAuthenticatedState(payload);
    elements.loginPassword.value = "";
  } catch (error) {
    uiState.authMessage = error.message;
    renderAuth();
  }
}

async function handleLogout() {
  for (const controller of streamControllers.values()) {
    controller.abort();
  }
  streamControllers.clear();
  streamInFlight.clear();
  await persistVault().catch(() => {});
  await logoutUser().catch(() => {});
  uiState.session = null;
  uiState.vault = createEmptyVault();
  uiState.authMode = "login";
  uiState.authMessage = "";
  uiState.editing = null;
  elements.messageInput.value = "";
  stopPollingPendingChats();
  render();
}

function attachEventListeners() {
  elements.markdownItScript?.addEventListener("load", render);
  elements.katexScript?.addEventListener("load", render);
  elements.loginTab.addEventListener("click", () => setAuthMode("login"));
  elements.registerTab.addEventListener("click", () => setAuthMode("register"));
  elements.loginForm.addEventListener("submit", handleLogin);
  elements.registerForm.addEventListener("submit", handleRegister);
  elements.logoutButton.addEventListener("click", handleLogout);
  elements.newChatButton.addEventListener("click", createNewChat);
  elements.composer.addEventListener("submit", handleComposerSubmit);
  elements.providerSelect.addEventListener("change", () => {
    const models = getModels(elements.providerSelect.value);
    elements.modelSelect.innerHTML = models
      .map((model) => `<option value="${model.id}">${escapeHtml(model.label)}</option>`)
      .join("");
    elements.reasoningSelect.innerHTML = (models[0]?.reasoningEfforts || [])
      .map((effort) => `<option value="${effort}">${escapeHtml(capitalize(effort))}</option>`)
      .join("");
    updateConfigFromInputs();
  });
  elements.modelSelect.addEventListener("change", () => {
    const activeChat = getActiveChat();
    const selectedModel = getModels(elements.providerSelect.value).find((model) => model.id === elements.modelSelect.value);

    if (activeChat && selectedModel) {
      elements.reasoningSelect.innerHTML = selectedModel.reasoningEfforts
        .map((effort) => `<option value="${effort}">${escapeHtml(capitalize(effort))}</option>`)
        .join("");
      elements.reasoningSelect.value = selectedModel.reasoningEfforts.includes(activeChat.config.reasoningEffort)
        ? activeChat.config.reasoningEffort
        : selectedModel.reasoningEfforts[0];
    }

    updateConfigFromInputs();
  });
  elements.reasoningSelect.addEventListener("change", updateConfigFromInputs);
  elements.settingsToggle.addEventListener("click", () => {
    elements.settingsPanel.classList.remove("settings-panel--hidden");
  });
  elements.settingsClose.addEventListener("click", () => {
    elements.settingsPanel.classList.add("settings-panel--hidden");
  });
  document.addEventListener("visibilitychange", () => {
    syncPendingChatPolling({ immediate: document.visibilityState === "visible" });
  });
}

async function bootstrap() {
  const [catalogPayload, sessionPayload] = await Promise.all([
    fetchCatalog(),
    fetchSession(),
  ]);
  catalog = catalogPayload;
  if (sessionPayload.authenticated) {
    applyAuthenticatedState(sessionPayload);
  }
  attachEventListeners();
  render();
  syncPendingChatPolling();
}

bootstrap().catch((error) => {
  uiState.authMessage = error.message;
  renderAuth();
});
