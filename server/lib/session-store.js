import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomToken } from "./crypto.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const dataDirectory = path.join(projectRoot, "data");
const storePath = path.join(dataDirectory, "session-store.json");

async function ensureDataDirectory() {
  await fs.mkdir(dataDirectory, { recursive: true });
}

async function loadSessionStore() {
  await ensureDataDirectory();

  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      version: 1,
    };
  } catch {
    return {
      sessions: [],
      version: 1,
    };
  }
}

async function saveSessionStore(store) {
  await ensureDataDirectory();
  await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function serializeSession(session) {
  return {
    ...session,
    userVaultKey: session.userVaultKey.toString("base64"),
  };
}

function deserializeSession(session) {
  return {
    ...session,
    userVaultKey: Buffer.from(session.userVaultKey, "base64"),
  };
}

function pruneExpiredSessionsInStore(store) {
  const now = Date.now();
  store.sessions = store.sessions.filter((session) => session.expiresAt > now);
}

export function createSessionCookie(session) {
  return {
    maxAge: Math.floor((session.expiresAt - Date.now()) / 1000),
    name: "uc_session",
    value: session.token,
  };
}

export async function createSession(payload) {
  const store = await loadSessionStore();
  pruneExpiredSessionsInStore(store);

  const session = {
    ...payload,
    expiresAt: Date.now() + SESSION_TTL_MS,
    token: randomToken(),
  };

  store.sessions.push(serializeSession(session));
  await saveSessionStore(store);
  return session;
}

export async function getSession(token) {
  if (!token) {
    return null;
  }

  const store = await loadSessionStore();
  pruneExpiredSessionsInStore(store);

  const serializedSession = store.sessions.find((session) => session.token === token);
  if (!serializedSession) {
    await saveSessionStore(store);
    return null;
  }

  serializedSession.expiresAt = Date.now() + SESSION_TTL_MS;
  await saveSessionStore(store);
  return deserializeSession(serializedSession);
}

export async function updateSession(session) {
  const store = await loadSessionStore();
  pruneExpiredSessionsInStore(store);

  const index = store.sessions.findIndex((entry) => entry.token === session.token);
  if (index === -1) {
    return;
  }

  store.sessions[index] = serializeSession(session);
  await saveSessionStore(store);
}

export async function destroySession(token) {
  if (!token) {
    return;
  }

  const store = await loadSessionStore();
  store.sessions = store.sessions.filter((session) => session.token !== token);
  await saveSessionStore(store);
}
