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
import { createChat, createEmptyVault, isChatLocked } from "./lib/state.js";

const pollInFlight = new Set();
const streamInFlight = new Set();
const streamControllers = new Map();
let renderQueued = false;
let persistQueue = Promise.resolve();
let catalog = {
  providers: [],
  defaultChatConfig: DEFAULT_CHAT_CONFIG,
};

const uiState = {
  authMessage: "",
  authMode: "login",
  session: null,
  vault: createEmptyVault(),
};

const elements = {
  appShell: document.querySelector("#app-shell"),
  authMessage: document.querySelector("#auth-message"),
  authScreen: document.querySelector("#auth-screen"),
  authSubtitle: document.querySelector("#auth-subtitle"),
  cancelButton: document.querySelector("#cancel-button"),
  chatCount: document.querySelector("#chat-count"),
  chatList: document.querySelector("#chat-list"),
  chatLockIndicator: document.querySelector("#chat-lock-indicator"),
  chatTitle: document.querySelector("#chat-title"),
  composer: document.querySelector("#composer"),
  composerMeta: document.querySelector("#composer-meta"),
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
  sendButton: document.querySelector("#send-button"),
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
    chat.messages = Array.isArray(chat.messages) ? chat.messages : [];
    chat.isSubmitting = Boolean(chat.isSubmitting);
    chat.lastResponseId = chat.lastResponseId || null;
    chat.pendingResponseId = chat.pendingResponseId || null;
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

  if (shouldRender) {
    requestRender();
  }
}

function updateChat(chatId, updater) {
  mutateChat(chatId, updater);
}

function setActiveChat(chatId) {
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
  elements.providerSelect.disabled = locked;
  elements.modelSelect.disabled = locked;
  elements.reasoningSelect.disabled = locked;
  elements.chatLockIndicator.textContent = locked ? "Config locked after first turn" : "Config unlocked";
  elements.chatTitle.textContent = chat.title;
  elements.currentUsername.textContent = uiState.session?.username || "";
  elements.composerMeta.textContent = hasApiKey
    ? `Background mode enabled for ${activeModel?.label || "this chat"}.`
    : `Configure the ${getProviderById(chat.config.providerId)?.apiKeyLabel || "API key"} in settings to send messages.`;
  elements.cancelButton.hidden = !chat.pendingResponseId;
  elements.cancelButton.disabled = false;
  elements.messageInput.disabled = !hasApiKey;
  elements.sendButton.disabled = Boolean(!hasApiKey || chat.isSubmitting || chat.pendingResponseId);
}

function renderMessages(chat) {
  elements.messages.replaceChildren();

  for (const message of chat.messages) {
    const fragment = elements.messageTemplate.content.cloneNode(true);
    const node = fragment.querySelector(".message");
    node.classList.add(`message--${message.role}`);
    if (message.error) {
      node.classList.add("message--error");
    }
    fragment.querySelector(".message__role").textContent = capitalize(message.role);
    fragment.querySelector(".message__status").textContent = buildStatusLabel(message);
    const messageBody = fragment.querySelector(".message__body");
    messageBody.innerHTML = renderMessageContent(message.error || message.text || "");

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

  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderApp() {
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
  renderMessages(activeChat);
}

function render() {
  renderAuth();
  renderApp();
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
      const firstUserEntry = chat.messages.find((message) => message.role === "user");
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

function setPendingAssistant(chat, responseId) {
  chat.pendingResponseId = responseId;
}

function clearPendingAssistant(chat) {
  chat.pendingResponseId = null;
}

function applyProviderResponse(chat, placeholderMessageId, providerResponse) {
  const message = chat.messages.find((entry) => entry.id === placeholderMessageId);
  if (!message) {
    return;
  }

  message.responseId = providerResponse.id;
  message.status = providerResponse.status;
  message.text = providerResponse.text || message.text;
  message.reasoningSummary = providerResponse.reasoningSummary || message.reasoningSummary || "";
  message.error = providerResponse.error?.message || null;

  if (providerResponse.isTerminal) {
    clearPendingAssistant(chat);
    if (!providerResponse.error) {
      chat.lastResponseId = providerResponse.id;
    }
  } else {
    setPendingAssistant(chat, providerResponse.id);
  }
}

async function sendMessage(event) {
  event.preventDefault();

  const activeChat = getActiveChat();
  if (!uiState.session || !activeChat) {
    return;
  }

  const messageText = elements.messageInput.value.trim();

  if (!hasConfiguredApiKey(activeChat.config.providerId) || !messageText || activeChat.isSubmitting || activeChat.pendingResponseId) {
    return;
  }

  const userMessage = {
    id: crypto.randomUUID(),
    role: "user",
    text: messageText,
    status: "",
    createdAt: new Date().toISOString(),
  };
  const assistantMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    text: "",
    reasoningSummary: "",
    status: "queued",
    error: null,
    responseId: null,
    createdAt: new Date().toISOString(),
  };
  const shouldSummarizeTitle = !activeChat.messages.some((message) => message.role === "user");

  updateChat(activeChat.id, (chat) => {
    chat.isSubmitting = true;
    chat.messages.push(userMessage, assistantMessage);
    return chat;
  });

  if (shouldSummarizeTitle) {
    void summarizeTitleForChat(activeChat.id, activeChat.config.providerId, messageText);
  }

  elements.messageInput.value = "";

  const streamController = new AbortController();
  streamInFlight.add(activeChat.id);
  streamControllers.set(activeChat.id, streamController);

  try {
    const streamResponse = await createProviderResponseStream(activeChat.config.providerId, {
      chatConfig: activeChat.config,
      message: messageText,
      previousResponseId: activeChat.lastResponseId,
    }, streamController.signal);

    const finalResponse = await consumeProviderStream(streamResponse, {
      onUpdate(providerResponse, { persist }) {
        mutateChat(activeChat.id, (chat) => {
          applyProviderResponse(chat, assistantMessage.id, providerResponse);
          chat.isSubmitting = true;
          return chat;
        }, { persist, render: true });
      },
    });

    updateChat(activeChat.id, (chat) => {
      chat.isSubmitting = false;
      applyProviderResponse(chat, assistantMessage.id, finalResponse);
      return chat;
    });
  } catch (error) {
    if (streamController.signal.aborted) {
      updateChat(activeChat.id, (chat) => {
        chat.isSubmitting = false;
        return chat;
      });
      return;
    }

    updateChat(activeChat.id, (chat) => {
      chat.isSubmitting = false;
      const message = chat.messages.find((entry) => entry.id === assistantMessage.id);
      if (message) {
        message.error = error.message;
        message.status = "failed";
      }
      clearPendingAssistant(chat);
      return chat;
    });
  } finally {
    streamInFlight.delete(activeChat.id);
    streamControllers.delete(activeChat.id);
  }
}

async function pollPendingChats() {
  if (!uiState.session) {
    return;
  }

  for (const chat of uiState.vault.chats) {
    if (!chat.pendingResponseId) {
      continue;
    }

    if (streamInFlight.has(chat.id)) {
      continue;
    }

    const requestKey = `${chat.id}:${chat.pendingResponseId}`;
    if (pollInFlight.has(requestKey)) {
      continue;
    }

    pollInFlight.add(requestKey);
    try {
      const payload = await retrieveProviderResponse(chat.config.providerId, chat.pendingResponseId);

      updateChat(chat.id, (currentChat) => {
        const pendingAssistant = [...currentChat.messages]
          .reverse()
          .find((message) => message.role === "assistant" && message.responseId === chat.pendingResponseId);

        if (pendingAssistant) {
          applyProviderResponse(currentChat, pendingAssistant.id, payload.response);
        }

        return currentChat;
      });
    } catch (error) {
      updateChat(chat.id, (currentChat) => {
        const pendingAssistant = [...currentChat.messages]
          .reverse()
          .find((message) => message.role === "assistant" && message.responseId === chat.pendingResponseId);

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
  if (!uiState.session || !activeChat?.pendingResponseId) {
    return;
  }

  elements.cancelButton.disabled = true;

  try {
    const payload = await cancelProviderResponse(activeChat.config.providerId, activeChat.pendingResponseId);

    updateChat(activeChat.id, (chat) => {
      const pendingAssistant = [...chat.messages]
        .reverse()
        .find((message) => message.role === "assistant" && message.responseId === chat.pendingResponseId);

      if (pendingAssistant) {
        applyProviderResponse(chat, pendingAssistant.id, payload.response);
      }

      return chat;
    });
  } catch (error) {
    updateChat(activeChat.id, (chat) => {
      const pendingAssistant = [...chat.messages]
        .reverse()
        .find((message) => message.role === "assistant" && message.responseId === chat.pendingResponseId);

      if (pendingAssistant) {
        pendingAssistant.error = error.message;
        pendingAssistant.status = "failed";
      }

      clearPendingAssistant(chat);
      return chat;
    });
  } finally {
    streamControllers.get(activeChat.id)?.abort();
    elements.cancelButton.disabled = false;
  }
}

function applyAuthenticatedState(payload) {
  uiState.session = payload.authenticated
    ? {
        username: payload.username,
      }
    : null;
  uiState.vault = payload.authenticated ? payload.vault || createEmptyVault() : createEmptyVault();
  uiState.authMessage = "";
  normalizeVault();
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
    pollPendingChats();
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
    pollPendingChats();
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
  elements.composer.addEventListener("submit", sendMessage);
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
  elements.cancelButton.addEventListener("click", cancelActiveRun);
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
  window.setInterval(pollPendingChats, 2500);
}

bootstrap().catch((error) => {
  uiState.authMessage = error.message;
  renderAuth();
});
