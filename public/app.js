import { DEFAULT_CHAT_CONFIG, getProviderById } from "../shared/model-catalog.js";
import { cancelProviderResponse, createProviderResponse, fetchCatalog, retrieveProviderResponse } from "./lib/api.js";
import { createChat, createEmptyVault, isChatLocked } from "./lib/state.js";
import { loadDatabase } from "./lib/storage.js";
import { listUsers, loginUser, persistUserVault, registerUser } from "./lib/user-vault.js";

const database = loadDatabase();
const pollInFlight = new Set();
let persistQueue = Promise.resolve();
let catalog = {
  providers: [],
  defaultChatConfig: DEFAULT_CHAT_CONFIG,
};

const uiState = {
  authMessage: "",
  authMode: Object.keys(database.users || {}).length > 0 ? "login" : "register",
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
  knownUsers: document.querySelector("#known-users"),
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
  providerCards: document.querySelector("#provider-cards"),
  providerSelect: document.querySelector("#provider-select"),
  reasoningSelect: document.querySelector("#reasoning-select"),
  registerConfirm: document.querySelector("#register-confirm"),
  registerForm: document.querySelector("#register-form"),
  registerPassword: document.querySelector("#register-password"),
  registerTab: document.querySelector("#register-tab"),
  registerUsername: document.querySelector("#register-username"),
  sendButton: document.querySelector("#send-button"),
  settingsClose: document.querySelector("#settings-close"),
  settingsFields: document.querySelector("#settings-fields"),
  settingsPanel: document.querySelector("#settings-panel"),
  settingsToggle: document.querySelector("#settings-toggle"),
  systemPrompt: document.querySelector("#system-prompt"),
};

function persistVault() {
  if (!uiState.session) {
    return Promise.resolve();
  }

  const snapshot = structuredClone(uiState.vault);
  const { masterKey, userId } = uiState.session;
  persistQueue = persistQueue
    .catch(() => {})
    .then(() => persistUserVault(database, userId, masterKey, snapshot))
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

function updateChat(chatId, updater) {
  const index = uiState.vault.chats.findIndex((chat) => chat.id === chatId);

  if (index === -1) {
    return;
  }

  const nextChat = updater(structuredClone(uiState.vault.chats[index]));
  nextChat.updatedAt = new Date().toISOString();
  uiState.vault.chats[index] = nextChat;
  persistVault();
  render();
}

function setActiveChat(chatId) {
  uiState.vault.activeChatId = chatId;
  persistVault();
  render();
}

function getModels(providerId) {
  return getProviderById(providerId)?.models || [];
}

function getApiKey(providerId) {
  return uiState.vault.providerKeys[providerId] || "";
}

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

function renderKnownUsers() {
  const users = listUsers(database);
  elements.knownUsers.replaceChildren();

  if (users.length === 0) {
    const copy = document.createElement("p");
    copy.className = "auth-copy";
    copy.textContent = "No local users yet. Create the first encrypted workspace.";
    elements.knownUsers.append(copy);
    return;
  }

  for (const username of users) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost-button ghost-button--small";
    button.textContent = username;
    button.addEventListener("click", () => {
      uiState.authMode = "login";
      elements.loginUsername.value = username;
      elements.loginPassword.focus();
      renderAuth();
    });
    elements.knownUsers.append(button);
  }
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
    ? "Unlock your local encrypted vault to access provider keys and chats."
    : "Create a local user. Your vault key is sealed with your password and never leaves this browser.";

  if (!elements.loginUsername.value && database.lastUsername) {
    elements.loginUsername.value = database.lastUsername;
  }

  renderKnownUsers();
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

function renderProviderCards() {
  elements.providerCards.replaceChildren();

  for (const provider of catalog.providers) {
    const card = document.createElement("article");
    card.className = "provider-card";
    card.innerHTML = `
      <div class="sidebar__heading">
        <p class="provider-card__title">${escapeHtml(provider.label)}</p>
        <span class="provider-card__status">${escapeHtml(provider.status.replaceAll("_", " "))}</span>
      </div>
      <p class="provider-card__copy">${escapeHtml(provider.tagline)}</p>
    `;
    elements.providerCards.append(card);
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
        placeholder="${escapeHtml(provider.envKeyName)} fallback works too"
        value="${escapeHtml(getApiKey(provider.id))}"
      />
    `;

    const input = label.querySelector("input");
    if (!disabled && input) {
      input.addEventListener("change", (event) => {
        uiState.vault.providerKeys[provider.id] = event.target.value.trim();
        persistVault();
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

  elements.systemPrompt.value = chat.config.systemPrompt || "";

  const locked = isChatLocked(chat);
  elements.providerSelect.disabled = locked;
  elements.modelSelect.disabled = locked;
  elements.reasoningSelect.disabled = locked;
  elements.systemPrompt.disabled = locked;
  elements.chatLockIndicator.textContent = locked ? "Config locked after first turn" : "Config unlocked";
  elements.chatTitle.textContent = chat.title;
  elements.currentUsername.textContent = uiState.session?.username || "";
  elements.composerMeta.textContent = `Background mode enabled for ${activeModel?.label || "this chat"}.`;
  elements.cancelButton.hidden = !chat.pendingResponseId;
  elements.cancelButton.disabled = false;
  elements.sendButton.disabled = Boolean(chat.isSubmitting || chat.pendingResponseId);
}

function renderMessages(chat) {
  elements.messages.replaceChildren();

  if (chat.messages.length === 0) {
    const emptyState = document.createElement("article");
    emptyState.className = "message";
    emptyState.innerHTML = `
      <div class="message__meta">
        <span class="message__role">Ready</span>
      </div>
      <div class="message__body">Your provider keys are encrypted inside this user's local vault. Configure this chat, then send the first turn.</div>
    `;
    elements.messages.append(emptyState);
    return;
  }

  for (const message of chat.messages) {
    const fragment = elements.messageTemplate.content.cloneNode(true);
    const node = fragment.querySelector(".message");
    node.classList.add(`message--${message.role}`);
    if (message.error) {
      node.classList.add("message--error");
    }
    fragment.querySelector(".message__role").textContent = capitalize(message.role);
    fragment.querySelector(".message__status").textContent = buildStatusLabel(message);
    fragment.querySelector(".message__body").textContent = message.error || message.text || "";
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
  renderProviderCards();
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
    chat.config.systemPrompt = elements.systemPrompt.value.trim();
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

  const providerId = activeChat.config.providerId;
  const apiKey = getApiKey(providerId);
  const messageText = elements.messageInput.value.trim();

  if (!messageText || activeChat.isSubmitting || activeChat.pendingResponseId) {
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
    status: "queued",
    error: null,
    responseId: null,
    createdAt: new Date().toISOString(),
  };

  updateChat(activeChat.id, (chat) => {
    if (chat.title === "New chat") {
      chat.title = messageText.slice(0, 40);
    }
    chat.isSubmitting = true;
    chat.messages.push(userMessage, assistantMessage);
    return chat;
  });

  elements.messageInput.value = "";

  try {
    const payload = await createProviderResponse(providerId, {
      apiKey,
      chatConfig: activeChat.config,
      message: messageText,
      previousResponseId: activeChat.lastResponseId,
    });

    updateChat(activeChat.id, (chat) => {
      chat.isSubmitting = false;
      applyProviderResponse(chat, assistantMessage.id, payload.response);
      return chat;
    });
  } catch (error) {
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

    const requestKey = `${chat.id}:${chat.pendingResponseId}`;
    if (pollInFlight.has(requestKey)) {
      continue;
    }

    pollInFlight.add(requestKey);
    try {
      const payload = await retrieveProviderResponse(chat.config.providerId, chat.pendingResponseId, {
        apiKey: getApiKey(chat.config.providerId),
      });

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
    const payload = await cancelProviderResponse(activeChat.config.providerId, activeChat.pendingResponseId, {
      apiKey: getApiKey(activeChat.config.providerId),
    });

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
    elements.cancelButton.disabled = false;
  }
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
    const { session, vault } = await registerUser(database, { username, password });
    uiState.session = session;
    uiState.vault = vault;
    uiState.authMessage = "";
    normalizeVault();
    elements.registerForm.reset();
    elements.loginPassword.value = "";
    render();
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
    const { session, vault } = await loginUser(database, { username, password });
    uiState.session = session;
    uiState.vault = vault;
    uiState.authMessage = "";
    normalizeVault();
    elements.loginPassword.value = "";
    render();
    pollPendingChats();
  } catch (error) {
    uiState.authMessage = error.message;
    renderAuth();
  }
}

async function handleLogout() {
  await persistVault().catch(() => {});
  uiState.session = null;
  uiState.vault = createEmptyVault();
  uiState.authMode = "login";
  uiState.authMessage = "";
  render();
}

function attachEventListeners() {
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
  elements.systemPrompt.addEventListener("change", updateConfigFromInputs);
  elements.settingsToggle.addEventListener("click", () => {
    elements.settingsPanel.classList.remove("settings-panel--hidden");
  });
  elements.settingsClose.addEventListener("click", () => {
    elements.settingsPanel.classList.add("settings-panel--hidden");
  });
  elements.cancelButton.addEventListener("click", cancelActiveRun);
}

async function bootstrap() {
  catalog = await fetchCatalog();
  attachEventListeners();
  render();
  window.setInterval(pollPendingChats, 2500);
}

bootstrap().catch((error) => {
  uiState.authMessage = error.message;
  renderAuth();
});
