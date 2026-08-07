import test from "node:test";
import assert from "node:assert/strict";

import { createDemoServer, loadDemoUsers, parseEnvFile } from "../server.mjs";

const environment = {
  DEMO_SESSION_TTL_MINUTES: "15",
  DEMO_ADMIN_NAME: "Admin",
  DEMO_ADMIN_EMAIL: "admin@example.test",
  DEMO_ADMIN_PASSWORD: "admin-pass",
  DEMO_MEMBER_NAME: "Member",
  DEMO_MEMBER_EMAIL: "member@example.test",
  DEMO_MEMBER_PASSWORD: "member-pass",
  DEMO_EMPLOYEE_NAME: "Employee",
  DEMO_EMPLOYEE_EMAIL: "employee@example.test",
  DEMO_EMPLOYEE_PASSWORD: "employee-pass",
  DEMO_HELPER_NAME: "Helper",
  DEMO_HELPER_EMAIL: "helper@example.test",
  DEMO_HELPER_PASSWORD: "helper-pass",
  DEMO_VIEWER_NAME: "Viewer",
  DEMO_VIEWER_EMAIL: "viewer@example.test",
  DEMO_VIEWER_PASSWORD: "viewer-pass",
};

async function withServer(run) {
  const server = createDemoServer({ environment });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("parsea .env sin ejecutar ni expandir valores", () => {
  assert.deepEqual(parseEnvFile("# demo\nPORT=4173\nPASSWORD='a$b!c'\n"), {
    PORT: "4173",
    PASSWORD: "a$b!c",
  });
});

test("carga los cinco usuarios y conserva la contraseña solo en servidor", () => {
  const users = loadDemoUsers(environment);
  assert.deepEqual(users.map((user) => user.role), [
    "family_admin", "family_member", "employee_live_in", "helper", "viewer",
  ]);
  assert.equal(users[0].email, "admin@example.test");
  assert.equal(users[0].password, "admin-pass");
});

test("autentica, crea cookie HttpOnly, recupera sesión y cierra sesión", async () => {
  await withServer(async (baseUrl) => {
    const accountsResponse = await fetch(`${baseUrl}/api/demo/accounts`);
    const accountsPayload = await accountsResponse.json();
    assert.equal(accountsPayload.accounts.length, 5);
    assert.equal("password" in accountsPayload.accounts[0], false);

    const invalid = await fetch(`${baseUrl}/api/demo/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ email: "admin@example.test", password: "wrong" }),
    });
    assert.equal(invalid.status, 401);

    const login = await fetch(`${baseUrl}/api/demo/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ email: "admin@example.test", password: "admin-pass" }),
    });
    assert.equal(login.status, 200);
    const loginPayload = await login.clone().json();
    assert.ok(loginPayload.expiresAt > Date.now());
    const cookie = login.headers.get("set-cookie");
    assert.match(cookie, /casa_clara_demo_session=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);

    const session = await fetch(`${baseUrl}/api/demo/session`, { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).user.role, "family_admin");

    const logout = await fetch(`${baseUrl}/api/demo/logout`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: baseUrl },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);

    const ended = await fetch(`${baseUrl}/api/demo/session`, { headers: { Cookie: cookie } });
    assert.equal(ended.status, 401);
  });
});

test("no sirve .env ni archivos internos", async () => {
  await withServer(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/.env`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/server.mjs`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/index.html`)).status, 200);
  });
});
