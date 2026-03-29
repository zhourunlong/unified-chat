async function parseErrorResponse(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      const payload = await response.json();
      return payload?.error?.message || "Request failed.";
    } catch {
      return "Request failed.";
    }
  }

  try {
    const text = await response.text();
    return text || "Request failed.";
  } catch {
    return "Request failed.";
  }
}

async function request(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await parseErrorResponse(response));
  }

  return response.json();
}

export async function fetchCatalog() {
  const response = await fetch("/api/catalog");

  if (!response.ok) {
    throw new Error("Failed to load catalog.");
  }

  return response.json();
}

export async function fetchSession() {
  const response = await fetch("/api/session");

  if (!response.ok) {
    throw new Error("Failed to load session.");
  }

  return response.json();
}

export async function registerUser(body) {
  return request("/api/auth/register", body);
}

export async function loginUser(body) {
  return request("/api/auth/login", body);
}

export async function logoutUser() {
  return request("/api/auth/logout", {});
}

export async function saveVault(vault) {
  return request("/api/session/vault", { vault });
}

export async function summarizeChatTitle(body) {
  return request("/api/chats/summarize-title", body);
}

export async function createProviderResponse(providerId, body) {
  return request(`/api/providers/${providerId}/responses`, body);
}

export async function createProviderResponseStream(providerId, body, signal) {
  const response = await fetch(`/api/providers/${providerId}/responses/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(await parseErrorResponse(response));
  }

  return response;
}

export async function retrieveProviderResponse(providerId, responseId) {
  return request(`/api/providers/${providerId}/responses/${responseId}/retrieve`, {});
}

export async function cancelProviderResponse(providerId, responseId) {
  return request(`/api/providers/${providerId}/responses/${responseId}/cancel`, {});
}
