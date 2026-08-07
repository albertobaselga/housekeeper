import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const COOKIE_NAME = "casa_clara_demo_session";
const MAX_BODY_BYTES = 8_192;
const LOGIN_WINDOW_MS = 10 * 60 * 1_000;
const MAX_LOGIN_ATTEMPTS = 10;

const PUBLIC_FILES = new Set([
  "index.html", "styles.css", "app.js", "auth.js", "data.js", "logic.js", "offline.js",
  "sw.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png",
  "apple-touch-icon.png",
]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
};

export function parseEnvFile(contents = "") {
  return String(contents).split(/\r?\n/).reduce((values, rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return values;
    const separator = line.indexOf("=");
    if (separator < 1) return values;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
    return values;
  }, {});
}

export function loadEnvironment(envPath = resolve(ROOT, ".env")) {
  let fileValues = {};
  try {
    fileValues = parseEnvFile(readFileSync(envPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { ...fileValues, ...process.env };
}

export function loadDemoUsers(environment) {
  const definitions = [
    ["ADMIN", "family_admin"],
    ["MEMBER", "family_member"],
    ["EMPLOYEE", "employee_live_in"],
    ["HELPER", "helper"],
    ["VIEWER", "viewer"],
  ];
  return definitions.map(([prefix, role]) => {
    const name = String(environment[`DEMO_${prefix}_NAME`] || "").trim();
    const email = String(environment[`DEMO_${prefix}_EMAIL`] || "").trim().toLowerCase();
    const password = String(environment[`DEMO_${prefix}_PASSWORD`] || "");
    if (!name || !email || !password) throw new Error(`Falta configurar DEMO_${prefix}_NAME/EMAIL/PASSWORD en .env`);
    return {
      id: createHash("sha256").update(email).digest("hex").slice(0, 16),
      name,
      email,
      password,
      role,
    };
  });
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

function parseCookies(header = "") {
  return String(header).split(";").reduce((cookies, part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = value; }
    return cookies;
  }, {});
}

function json(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(Object.assign(new Error("Petición demasiado grande"), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { rejectBody(Object.assign(new Error("JSON no válido"), { status: 400 })); }
    });
    request.on("error", rejectBody);
  });
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; }
  catch { return false; }
}

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(self)",
  };
}

export function createDemoServer({ environment = loadEnvironment(), root = ROOT } = {}) {
  const users = loadDemoUsers(environment);
  const sessions = new Map();
  const attempts = new Map();
  const configuredTtl = Number(environment.DEMO_SESSION_TTL_MINUTES);
  const ttlMinutes = Number.isFinite(configuredTtl) ? Math.max(5, configuredTtl) : 480;
  const ttlMs = ttlMinutes * 60 * 1_000;

  function pruneSessions() {
    const now = Date.now();
    sessions.forEach((session, token) => {
      if (session.expiresAt <= now) sessions.delete(token);
    });
  }

  function currentSession(request) {
    pruneSessions();
    const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
    const session = token && sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return { token, ...session };
  }

  function rateLimitKey(request) {
    return request.socket.remoteAddress || "unknown";
  }

  function loginAllowed(request) {
    const key = rateLimitKey(request);
    const now = Date.now();
    const recent = (attempts.get(key) || []).filter((timestamp) => now - timestamp < LOGIN_WINDOW_MS);
    attempts.set(key, recent);
    return recent.length < MAX_LOGIN_ATTEMPTS;
  }

  function registerFailedLogin(request) {
    const key = rateLimitKey(request);
    attempts.set(key, [...(attempts.get(key) || []), Date.now()]);
  }

  async function handleApi(request, response, url) {
    if (url.pathname === "/api/demo/accounts" && request.method === "GET") {
      json(response, 200, { accounts: users.map(publicUser) }, securityHeaders());
      return true;
    }
    if (url.pathname === "/api/demo/session" && request.method === "GET") {
      const session = currentSession(request);
      json(response, session ? 200 : 401, session ? { user: publicUser(session.user), expiresAt: session.expiresAt } : { error: "Sesión no iniciada" }, securityHeaders());
      return true;
    }
    if (url.pathname === "/api/demo/login" && request.method === "POST") {
      if (!isSameOrigin(request)) {
        json(response, 403, { error: "Origen no permitido" }, securityHeaders());
        return true;
      }
      if (!loginAllowed(request)) {
        json(response, 429, { error: "Demasiados intentos. Espera diez minutos." }, securityHeaders());
        return true;
      }
      try {
        pruneSessions();
        const body = await readJsonBody(request);
        const email = String(body.email || "").trim().toLowerCase();
        const user = users.find((candidate) => candidate.email === email);
        if (!user || !safeEqual(user.password, body.password || "")) {
          registerFailedLogin(request);
          json(response, 401, { error: "Correo o contraseña incorrectos" }, securityHeaders());
          return true;
        }
        attempts.delete(rateLimitKey(request));
        const token = randomBytes(32).toString("hex");
        const expiresAt = Date.now() + ttlMs;
        sessions.set(token, { user, expiresAt });
        const secure = request.socket.encrypted || environment.COOKIE_SECURE === "true";
        const cookie = `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}${secure ? "; Secure" : ""}`;
        json(response, 200, { user: publicUser(user), expiresAt }, { ...securityHeaders(), "Set-Cookie": cookie });
      } catch (error) {
        if (!response.headersSent) json(response, error.status || 400, { error: error.message }, securityHeaders());
      }
      return true;
    }
    if (url.pathname === "/api/demo/logout" && request.method === "POST") {
      if (!isSameOrigin(request)) {
        json(response, 403, { error: "Origen no permitido" }, securityHeaders());
        return true;
      }
      const session = currentSession(request);
      if (session) sessions.delete(session.token);
      json(response, 200, { ok: true }, {
        ...securityHeaders(),
        "Set-Cookie": `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      });
      return true;
    }
    if (url.pathname.startsWith("/api/")) {
      json(response, 404, { error: "Endpoint no encontrado" }, securityHeaders());
      return true;
    }
    return false;
  }

  return createServer(async (request, response) => {
    const host = request.headers.host || "localhost";
    let url;
    try { url = new URL(request.url, `http://${host}`); }
    catch { json(response, 400, { error: "URL no válida" }, securityHeaders()); return; }

    if (await handleApi(request, response, url)) return;
    if (!['GET', 'HEAD'].includes(request.method)) {
      json(response, 405, { error: "Método no permitido" }, { ...securityHeaders(), Allow: "GET, HEAD" });
      return;
    }

    let fileName;
    try { fileName = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html"; }
    catch { json(response, 400, { error: "Ruta no válida" }, securityHeaders()); return; }
    if (!PUBLIC_FILES.has(fileName) || fileName.includes("..") || fileName.includes(sep)) {
      json(response, 404, { error: "Recurso no encontrado" }, securityHeaders());
      return;
    }
    const filePath = resolve(root, fileName);
    if (!filePath.startsWith(`${resolve(root)}${sep}`)) {
      json(response, 404, { error: "Recurso no encontrado" }, securityHeaders());
      return;
    }
    try {
      const stat = statSync(filePath);
      response.writeHead(200, {
        ...securityHeaders(),
        "Content-Type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
        "Content-Length": stat.size,
        "Cache-Control": fileName === "index.html" || fileName === "sw.js" ? "no-cache" : "public, max-age=0, must-revalidate",
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(filePath).pipe(response);
    } catch {
      json(response, 404, { error: "Recurso no encontrado" }, securityHeaders());
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const environment = loadEnvironment();
  const host = environment.HOST || "127.0.0.1";
  const port = Number(environment.PORT) || 4173;
  const server = createDemoServer({ environment });
  server.listen(port, host, () => {
    process.stdout.write(`Casa Clara demo: http://${host}:${port}/#today\n`);
  });
}
