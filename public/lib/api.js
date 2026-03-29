async function request(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message || "Request failed.");
  }

  return payload;
}

export async function fetchCatalog() {
  const response = await fetch("/api/catalog");

  if (!response.ok) {
    throw new Error("Failed to load catalog.");
  }

  return response.json();
}

export async function createProviderResponse(providerId, body) {
  return request(`/api/providers/${providerId}/responses`, body);
}

export async function retrieveProviderResponse(providerId, responseId, body) {
  return request(`/api/providers/${providerId}/responses/${responseId}/retrieve`, body);
}

export async function cancelProviderResponse(providerId, responseId, body) {
  return request(`/api/providers/${providerId}/responses/${responseId}/cancel`, body);
}
