import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CHAT_CONFIG, PROVIDERS } from "../shared/model-catalog.js";
import { clearCookie, createHttpError, parseCookies, readJsonBody, sendError, sendJson, serveStaticFile, setCookie } from "./lib/http.js";
import { createSession, createSessionCookie, destroySession, getSession, updateSession } from "./lib/session-store.js";
import { loginLocalUser, registerLocalUser, saveUserVault } from "./lib/user-store.js";
import { getProviderHandler } from "./providers/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const publicRoot = path.join(projectRoot, "public");
const sharedRoot = path.join(projectRoot, "shared");
const host = process.env.HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "3000", 10);

function buildCatalog() {
  return {
    providers: PROVIDERS,
    defaultChatConfig: DEFAULT_CHAT_CONFIG,
  };
}

function serializeSession(session) {
  return {
    authenticated: true,
    username: session.username,
    vault: session.vault,
  };
}

async function requireSession(request) {
  const cookies = parseCookies(request);
  const session = await getSession(cookies.uc_session);

  if (!session) {
    throw createHttpError(401, "Log in to use the local encrypted vault.");
  }

  return session;
}

async function handleApiRequest(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/catalog") {
    sendJson(response, 200, buildCatalog());
    return;
  }

  if (request.method === "GET" && pathname === "/api/session") {
    const cookies = parseCookies(request);
    const session = await getSession(cookies.uc_session);

    if (!session) {
      clearCookie(response, "uc_session");
      sendJson(response, 200, { authenticated: false });
      return;
    }

    setCookie(response, createSessionCookie(session));
    sendJson(response, 200, serializeSession(session));
    return;
  }

  if (request.method === "POST" && pathname === "/api/auth/register") {
    const body = await readJsonBody(request);
    const localUser = await registerLocalUser({
      password: body.password,
      username: body.username,
    });
    const session = await createSession(localUser);
    setCookie(response, createSessionCookie(session));
    sendJson(response, 200, serializeSession(session));
    return;
  }

  if (request.method === "POST" && pathname === "/api/auth/login") {
    const body = await readJsonBody(request);
    const localUser = await loginLocalUser({
      password: body.password,
      username: body.username,
    });
    const session = await createSession(localUser);
    setCookie(response, createSessionCookie(session));
    sendJson(response, 200, serializeSession(session));
    return;
  }

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    const cookies = parseCookies(request);
    await destroySession(cookies.uc_session);
    clearCookie(response, "uc_session");
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && pathname === "/api/session/vault") {
    const session = await requireSession(request);
    const body = await readJsonBody(request);
    session.vault = await saveUserVault({
      recordId: session.recordId,
      userVaultKey: session.userVaultKey,
      vault: body.vault,
    });
    await updateSession(session);
    sendJson(response, 200, { ok: true });
    return;
  }

  const createMatch = pathname.match(/^\/api\/providers\/([^/]+)\/responses$/);
  if (request.method === "POST" && createMatch) {
    const session = await requireSession(request);
    const body = await readJsonBody(request);
    const providerId = createMatch[1];
    const provider = getProviderHandler(providerId);
    const apiKey = session.vault?.providerKeys?.[providerId] || "";
    const result = await provider.createResponse({
      apiKey,
      chatConfig: body.chatConfig,
      message: body.message,
      previousResponseId: body.previousResponseId,
    });
    sendJson(response, 200, { response: result });
    return;
  }

  const retrieveMatch = pathname.match(/^\/api\/providers\/([^/]+)\/responses\/([^/]+)\/retrieve$/);
  if (request.method === "POST" && retrieveMatch) {
    const session = await requireSession(request);
    const providerId = retrieveMatch[1];
    const responseId = retrieveMatch[2];
    const provider = getProviderHandler(providerId);
    const result = await provider.retrieveResponse({
      apiKey: session.vault?.providerKeys?.[providerId] || "",
      responseId,
    });
    sendJson(response, 200, { response: result });
    return;
  }

  const cancelMatch = pathname.match(/^\/api\/providers\/([^/]+)\/responses\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const session = await requireSession(request);
    const providerId = cancelMatch[1];
    const responseId = cancelMatch[2];
    const provider = getProviderHandler(providerId);
    const result = await provider.cancelResponse({
      apiKey: session.vault?.providerKeys?.[providerId] || "",
      responseId,
    });
    sendJson(response, 200, { response: result });
    return;
  }

  throw createHttpError(404, "API route not found.");
}

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    sendError(response, 400, "Missing request URL.");
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const { pathname } = url;

  try {
    if (pathname.startsWith("/api/")) {
      await handleApiRequest(request, response, pathname);
      return;
    }

    if (pathname.startsWith("/shared/")) {
      const sharedPath = pathname.replace(/^\/shared/, "");
      const served = await serveStaticFile(response, sharedRoot, sharedPath);
      if (served) {
        return;
      }
    } else {
      const served = await serveStaticFile(response, publicRoot, pathname);
      if (served) {
        return;
      }
    }

    sendError(response, 404, "Route not found.");
  } catch (error) {
    const statusCode = error.statusCode || 500;
    sendError(response, statusCode, error.message || "Unexpected server error.", error.details || null);
  }
});

server.listen(port, host, () => {
  console.log(`Unified chat listening at http://${host}:${port}`);
});
