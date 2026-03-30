import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CHAT_CONFIG, PROVIDERS } from "../shared/model-catalog.js";
import { requireConfiguredProviderKey } from "./lib/provider-auth.js";
import { clearCookie, createHttpError, parseCookies, readJsonBody, sendError, sendJson, serveStaticFile, setCookie } from "./lib/http.js";
import { endSse, writeSseEvent } from "./lib/sse.js";
import { createSession, createSessionCookie, destroySession, getSession, updateSession } from "./lib/session-store.js";
import { loginLocalUser, registerLocalUser, saveUserVault } from "./lib/user-store.js";
import { getProviderCapabilities, getProviderHandler, getProviderModels } from "./providers/index.js";

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

  const providerModelsMatch = pathname.match(/^\/api\/providers\/([^/]+)\/models$/);
  if (request.method === "GET" && providerModelsMatch) {
    const providerId = providerModelsMatch[1];
    const provider = PROVIDERS.find((entry) => entry.id === providerId);

    if (!provider) {
      throw createHttpError(404, `Unknown provider '${providerId}'.`);
    }

    sendJson(response, 200, {
      capabilities: getProviderCapabilities(providerId),
      models: getProviderModels(providerId),
      providerId,
      providerLabel: provider.label,
    });
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

  if (request.method === "POST" && pathname === "/api/chats/summarize-title") {
    const session = await requireSession(request);
    const body = await readJsonBody(request);
    const providerId = body.providerId;
    const firstUserMessage = String(body.firstUserMessage || "").trim();

    if (!firstUserMessage) {
      throw createHttpError(400, "First user message is required.");
    }

    const provider = getProviderHandler(providerId);
    const apiKey = requireConfiguredProviderKey(providerId, session.vault?.providerKeys?.[providerId]);
    const summary = await provider.summarizeTitle({
      apiKey,
      firstUserMessage,
    });

    sendJson(response, 200, summary);
    return;
  }

  const streamMatch = pathname.match(/^\/api\/providers\/([^/]+)\/responses\/stream$/);
  if (request.method === "POST" && streamMatch) {
    const session = await requireSession(request);
    const body = await readJsonBody(request);
    const providerId = streamMatch[1];
    const provider = getProviderHandler(providerId);
    const apiKey = requireConfiguredProviderKey(providerId, session.vault?.providerKeys?.[providerId]);
    const abortController = new AbortController();
    request.on("close", () => abortController.abort());

    const stream = provider.streamResponse({
      apiKey,
      chatConfig: body.chatConfig,
      context: body.context,
      history: body.history,
      message: body.message,
      signal: abortController.signal,
    });

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    try {
      for await (const event of stream) {
        writeSseEvent(response, event);
      }
      endSse(response);
    } catch (error) {
      if (error?.name === "AbortError") {
        if (!response.writableEnded) {
          endSse(response);
        }
      } else if (!response.writableEnded) {
        writeSseEvent(response, {
          type: "response.error",
          message: error.message || "Provider stream failed.",
        });
        endSse(response);
      }
    }
    return;
  }

  const retrieveMatch = pathname.match(/^\/api\/providers\/([^/]+)\/responses\/retrieve$/);
  if (request.method === "POST" && retrieveMatch) {
    const session = await requireSession(request);
    const body = await readJsonBody(request);
    const providerId = retrieveMatch[1];
    const provider = getProviderHandler(providerId);
    const apiKey = requireConfiguredProviderKey(providerId, session.vault?.providerKeys?.[providerId]);
    const result = await provider.retrieveResponse({
      apiKey,
      operation: body.operation,
    });
    sendJson(response, 200, { response: result });
    return;
  }

  const cancelMatch = pathname.match(/^\/api\/providers\/([^/]+)\/responses\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const session = await requireSession(request);
    const body = await readJsonBody(request);
    const providerId = cancelMatch[1];
    const provider = getProviderHandler(providerId);
    const apiKey = requireConfiguredProviderKey(providerId, session.vault?.providerKeys?.[providerId]);
    const result = await provider.cancelResponse({
      apiKey,
      operation: body.operation,
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
