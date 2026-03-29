const STORAGE_KEY = "unified-chat-users:v1";
const DEFAULT_DATABASE = {
  users: {},
  lastUsername: "",
};

export function loadDatabase() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return structuredClone(DEFAULT_DATABASE);
    }

    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULT_DATABASE),
      ...parsed,
      users: parsed?.users || {},
    };
  } catch {
    return structuredClone(DEFAULT_DATABASE);
  }
}

export function saveDatabase(database) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(database));
}
