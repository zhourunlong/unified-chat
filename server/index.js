import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CHAT_CONFIG, PROVIDERS } from "../shared/model-catalog.js";
import { createHttpError, readJsonBody, sendError, sendJson, serveStaticFile } from "./lib/http.js";
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

async function handleApiRequest(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/catalog") {
    sendJson(response, 200, buildCatalog());
    return;
  }

  const createMatch = pathname.match(/^\/api\/providers\/([^/]+)\/responses$/);
  if (request.method === "POST" && createMatch) {
    const body = await readJsonBody(request);
    const providerId = createMatch[1];
    const provider = getProviderHandler(providerId);
    const result = await provider.createResponse({
      apiKey: body.apiKey,
      chatConfig: body.chatConfig,
      message: body.message,
      previousResponseId: body.previousResponseId,
    });
    sendJson(response, 200, { response: result });
    return;
  }

  const retrieveMatch = pathname.match(/^\/api\/providers\/([^/]+)\/responses\/([^/]+)\/retrieve$/);
  if (request.method === "POST" && retrieveMatch) {
    const body = await readJsonBody(request);
    const providerId = retrieveMatch[1];
    const responseId = retrieveMatch[2];
    const provider = getProviderHandler(providerId);
    const result = await provider.retrieveResponse({
      apiKey: body.apiKey,
      responseId,
    });
    sendJson(response, 200, { response: result });
    return;
  }

  const cancelMatch = pathname.match(/^\/api\/providers\/([^/]+)\/responses\/([^/]+)\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const body = await readJsonBody(request);
    const providerId = cancelMatch[1];
    const responseId = cancelMatch[2];
    const provider = getProviderHandler(providerId);
    const result = await provider.cancelResponse({
      apiKey: body.apiKey,
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
