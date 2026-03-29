import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createCredentialProbe, createUsernameProbe, decryptJson, deriveUserVaultKey, encryptJson, randomSalt, safeEqualBase64 } from "./crypto.js";
import { createHttpError } from "./http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const dataDirectory = path.join(projectRoot, "data");
const storePath = path.join(dataDirectory, "vault-store.json");

function createEmptyVault() {
  return {
    activeChatId: null,
    chats: [],
    providerKeys: {},
  };
}

function normalizeUsername(username) {
  return username.trim().toLowerCase();
}

function validateUsername(username) {
  const trimmed = username.trim();

  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(trimmed)) {
    throw createHttpError(400, "Username must be 3-32 chars and use letters, numbers, dots, dashes, or underscores.");
  }

  return trimmed;
}

function validatePassword(password) {
  if (typeof password !== "string") {
    throw createHttpError(400, "Password must be a string.");
  }
}

function sanitizeVault(vault) {
  return {
    activeChatId: vault?.activeChatId || null,
    chats: Array.isArray(vault?.chats) ? vault.chats : [],
    providerKeys: vault?.providerKeys || {},
  };
}

async function ensureDataDirectory() {
  await fs.mkdir(dataDirectory, { recursive: true });
}

async function loadStore() {
  await ensureDataDirectory();

  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      records: Array.isArray(parsed.records) ? parsed.records : [],
      version: 2,
    };
  } catch {
    return {
      records: [],
      version: 2,
    };
  }
}

async function saveStore(store) {
  await ensureDataDirectory();
  await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function buildEncryptedRecord({ username, password, vault }) {
  const normalizedUsername = normalizeUsername(username);
  const usernameProbe = createUsernameProbe(normalizedUsername);
  const credentialProbe = createCredentialProbe(normalizedUsername, password);
  const vaultSalt = randomSalt(16);
  const userVaultKey = deriveUserVaultKey(normalizedUsername, password, Buffer.from(vaultSalt, "base64"));
  const vaultCiphertext = encryptJson(sanitizeVault(vault), userVaultKey);

  return {
    createdAt: new Date().toISOString(),
    credentialProbe,
    id: randomUUID(),
    usernameProbe,
    vaultCiphertext,
    vaultSalt,
  };
}

function unlockRecord(record, { username, password }) {
  const normalizedUsername = normalizeUsername(username);
  const expectedProbe = createCredentialProbe(normalizedUsername, password);

  if (!safeEqualBase64(record.credentialProbe, expectedProbe)) {
    throw createHttpError(401, "Unable to unlock this vault. Check the username and password.");
  }

  const userVaultKey = deriveUserVaultKey(
    normalizedUsername,
    password,
    Buffer.from(record.vaultSalt, "base64"),
  );
  const vault = decryptJson(record.vaultCiphertext, userVaultKey);

  return {
    userVaultKey,
    vault: sanitizeVault(vault),
  };
}

export async function registerLocalUser({ username, password }) {
  const validatedUsername = validateUsername(username);
  validatePassword(password);

  const store = await loadStore();
  const normalizedUsername = normalizeUsername(validatedUsername);
  const usernameProbe = createUsernameProbe(normalizedUsername);

  if (store.records.some((record) => record.usernameProbe === usernameProbe)) {
    throw createHttpError(409, "That username is already registered on this device.");
  }

  const vault = createEmptyVault();
  const record = buildEncryptedRecord({
    password,
    username: validatedUsername,
    vault,
  });

  store.records.push(record);
  await saveStore(store);

  const unlocked = unlockRecord(record, {
    password,
    username: validatedUsername,
  });

  return {
    recordId: record.id,
    userVaultKey: unlocked.userVaultKey,
    username: validatedUsername,
    vault,
  };
}

export async function loginLocalUser({ username, password }) {
  const validatedUsername = validateUsername(username);
  validatePassword(password);

  const store = await loadStore();
  const normalizedUsername = normalizeUsername(validatedUsername);
  const usernameProbe = createUsernameProbe(normalizedUsername);
  const candidates = store.records.filter((record) => record.usernameProbe === usernameProbe);

  for (const record of candidates) {
    try {
      const unlocked = unlockRecord(record, {
        password,
        username: validatedUsername,
      });

      return {
        recordId: record.id,
        userVaultKey: unlocked.userVaultKey,
        username: validatedUsername,
        vault: unlocked.vault,
      };
    } catch (error) {
      if (error.statusCode && error.statusCode !== 401) {
        throw error;
      }
    }
  }

  throw createHttpError(401, "Unable to unlock this vault. Check the username and password.");
}

export async function saveUserVault({ recordId, userVaultKey, vault }) {
  const store = await loadStore();
  const index = store.records.findIndex((record) => record.id === recordId);

  if (index === -1) {
    throw createHttpError(404, "Unable to locate the local encrypted vault.");
  }

  const existing = store.records[index];
  existing.vaultCiphertext = encryptJson(sanitizeVault(vault), userVaultKey);
  await saveStore(store);

  return sanitizeVault(vault);
}

export async function inspectStoredVaults() {
  return loadStore();
}
