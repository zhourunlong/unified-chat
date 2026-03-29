import { createEmptyVault } from "./state.js";
import { saveDatabase } from "./storage.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PBKDF2_ITERATIONS = 250000;

function normalizeUsername(username) {
  return username.trim().toLowerCase();
}

function validateUsername(username) {
  const trimmed = username.trim();

  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(trimmed)) {
    throw new Error("Username must be 3-32 chars and use letters, numbers, dots, dashes, or underscores.");
  }

  return trimmed;
}

function validatePassword(password) {
  if (password.length < 10) {
    throw new Error("Password must be at least 10 characters.");
  }
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function toBase64(bytes) {
  let binary = "";

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }

  return btoa(binary);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function derivePasswordKey(password, salt, iterations) {
  const passwordMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    passwordMaterial,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptBytes(key, bytes) {
  const iv = randomBytes(12);
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
    },
    key,
    bytes,
  );

  return {
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(encrypted)),
  };
}

async function decryptBytes(key, payload) {
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(payload.iv),
    },
    key,
    fromBase64(payload.data),
  );

  return new Uint8Array(decrypted);
}

async function encryptText(key, text) {
  return encryptBytes(key, encoder.encode(text));
}

async function decryptText(key, payload) {
  const bytes = await decryptBytes(key, payload);
  return decoder.decode(bytes);
}

async function encryptJson(key, value) {
  return encryptText(key, JSON.stringify(value));
}

async function decryptJson(key, payload) {
  const text = await decryptText(key, payload);
  return JSON.parse(text);
}

async function unwrapVaultKey(passwordKey, wrappedVaultKey) {
  const rawVaultKey = await decryptBytes(passwordKey, wrappedVaultKey);

  return crypto.subtle.importKey(
    "raw",
    rawVaultKey,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );
}

export function listUsers(database) {
  return Object.values(database.users || {})
    .map((record) => record.username)
    .sort((left, right) => left.localeCompare(right));
}

export async function registerUser(database, { username, password }) {
  const validatedUsername = validateUsername(username);
  validatePassword(password);

  const userId = normalizeUsername(validatedUsername);
  if (database.users[userId]) {
    throw new Error("That username already exists on this device.");
  }

  const salt = randomBytes(16);
  const passwordKey = await derivePasswordKey(password, salt, PBKDF2_ITERATIONS);
  const masterKey = await crypto.subtle.generateKey(
    {
      name: "AES-GCM",
      length: 256,
    },
    true,
    ["encrypt", "decrypt"],
  );
  const exportedMasterKey = new Uint8Array(await crypto.subtle.exportKey("raw", masterKey));
  const wrappedVaultKey = await encryptBytes(passwordKey, exportedMasterKey);
  const passwordVerifier = await encryptText(passwordKey, `vault:${userId}`);
  const vault = createEmptyVault();
  const encryptedVault = await encryptJson(masterKey, vault);

  database.users[userId] = {
    createdAt: new Date().toISOString(),
    credentials: {
      iterations: PBKDF2_ITERATIONS,
      passwordVerifier,
      salt: toBase64(salt),
      wrappedVaultKey,
    },
    encryptedVault,
    userId,
    username: validatedUsername,
  };
  database.lastUsername = validatedUsername;
  saveDatabase(database);

  return {
    session: {
      masterKey,
      userId,
      username: validatedUsername,
    },
    vault,
  };
}

export async function loginUser(database, { username, password }) {
  const userId = normalizeUsername(validateUsername(username));
  const record = database.users[userId];

  if (!record) {
    throw new Error("Unknown user on this device.");
  }

  try {
    const passwordKey = await derivePasswordKey(
      password,
      fromBase64(record.credentials.salt),
      record.credentials.iterations,
    );
    const verifier = await decryptText(passwordKey, record.credentials.passwordVerifier);

    if (verifier !== `vault:${userId}`) {
      throw new Error("Incorrect password.");
    }

    const masterKey = await unwrapVaultKey(passwordKey, record.credentials.wrappedVaultKey);
    const vault = await decryptJson(masterKey, record.encryptedVault);
    database.lastUsername = record.username;
    saveDatabase(database);

    return {
      session: {
        masterKey,
        userId,
        username: record.username,
      },
      vault,
    };
  } catch {
    throw new Error("Unable to unlock this vault. Check the username and password.");
  }
}

export async function persistUserVault(database, userId, masterKey, vault) {
  const record = database.users[userId];

  if (!record) {
    throw new Error("Current user is missing from local storage.");
  }

  record.encryptedVault = await encryptJson(masterKey, vault);
  database.lastUsername = record.username;
  saveDatabase(database);
}
