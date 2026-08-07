const SESSION_CACHE_KEY = "casa-clara-demo-session-v1";

function readCachedSession() {
  try {
    const cached = JSON.parse(localStorage.getItem(SESSION_CACHE_KEY) || "null");
    if (!cached?.user || Number(cached.expiresAt) <= Date.now()) {
      localStorage.removeItem(SESSION_CACHE_KEY);
      return null;
    }
    return cached;
  } catch {
    return null;
  }
}

function cacheSession(user, expiresAt) {
  try {
    if (user && Number(expiresAt) > Date.now()) localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify({ user, expiresAt }));
    else localStorage.removeItem(SESSION_CACHE_KEY);
  } catch {
    // La sesión online sigue siendo válida aunque el navegador bloquee storage.
  }
}

async function parseJsonResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "No se pudo completar la autenticación demo");
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function restoreDemoSession() {
  try {
    const response = await fetch("./api/demo/session", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (response.status === 401) {
      cacheSession(null);
      return { user: null, offline: false };
    }
    const payload = await parseJsonResponse(response);
    cacheSession(payload.user, payload.expiresAt);
    return { user: payload.user, expiresAt: payload.expiresAt, offline: false };
  } catch (error) {
    const cached = readCachedSession();
    if (cached && !error.status) return { user: cached.user, expiresAt: cached.expiresAt, offline: true };
    throw error;
  }
}

export async function loginDemoUser(email, password) {
  const response = await fetch("./api/demo/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const payload = await parseJsonResponse(response);
  cacheSession(payload.user, payload.expiresAt);
  return { user: payload.user, expiresAt: payload.expiresAt };
}

export async function logoutDemoUser() {
  try {
    const response = await fetch("./api/demo/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    await parseJsonResponse(response);
  } finally {
    cacheSession(null);
  }
}

export async function listDemoAccounts() {
  const response = await fetch("./api/demo/accounts", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  return (await parseJsonResponse(response)).accounts || [];
}
