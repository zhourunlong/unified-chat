import fs from "node:fs/promises";
import path from "node:path";

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

export async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");

  try {
    return JSON.parse(raw);
  } catch {
    throw createHttpError(400, "Malformed JSON body.");
  }
}

export function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

export function parseCookies(request) {
  const raw = request.headers.cookie || "";
  const cookies = {};

  for (const entry of raw.split(";")) {
    const [name, ...rest] = entry.trim().split("=");
    if (!name) {
      continue;
    }
    cookies[name] = decodeURIComponent(rest.join("="));
  }

  return cookies;
}

export function setCookie(response, { name, value, maxAge, httpOnly = true, sameSite = "Strict", path = "/" }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `SameSite=${sameSite}`,
  ];

  if (httpOnly) {
    parts.push("HttpOnly");
  }

  if (maxAge !== undefined) {
    parts.push(`Max-Age=${maxAge}`);
  }

  response.setHeader("Set-Cookie", parts.join("; "));
}

export function clearCookie(response, name) {
  setCookie(response, {
    maxAge: 0,
    name,
    value: "",
  });
}

export function sendError(response, statusCode, message, details = null) {
  sendJson(response, statusCode, {
    error: {
      message,
      ...(details ? { details } : {}),
    },
  });
}

export async function serveStaticFile(response, rootDirectory, requestPath) {
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const resolvedPath = path.normalize(path.join(rootDirectory, normalizedPath));
  const safeRoot = `${rootDirectory}${path.sep}`;

  if (resolvedPath !== rootDirectory && !resolvedPath.startsWith(safeRoot)) {
    return false;
  }

  try {
    const content = await fs.readFile(resolvedPath);
    const extension = path.extname(resolvedPath);

    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extension] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(content);
    return true;
  } catch {
    return false;
  }
}

export function createHttpError(statusCode, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}
