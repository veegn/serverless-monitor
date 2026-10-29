import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers/d1.js';
import { AdminController } from '../src/handlers/AdminController.js';
import { checkAuth, generateToken, getWebSocketIdentity } from '../src/middleware/auth.js';
import { loadSettings } from '../src/utils/settings.js';

const setup = async () => {
  const db = makeD1({ settings: {
    site_options: { jwt_secret: 'old-login-key-'.repeat(4), password: 'configured',
      cloudflare_account_id: 'account', cloudflare_token: 'analytics-token',
      auto_register_token: 'active-registration-key', auto_register_token_expires: 9876543210 },
    appearance_options: { display_mode: 'table', preferred_theme: 'light', default_language: 'es' }
  } });
  const env = { DB: db };
  const sys = await loadSettings(db);
  const token = await generateToken(env, sys);
  const request = (data, bearer = token) => new Request('https://monitor.test/admin/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(data)
  });
  return { db, env, sys, token, request };
};

test('key rotation rejects unauthenticated callers without changing the key', async () => {
  const { db, env, sys, request } = await setup();
  const before = db.store.get('settings.security');
  const response = await AdminController.handleAdminAPI(request({ action: 'rotate_jwt_secret' }, ''), env, sys);
  assert.equal(response.status, 401);
  assert.equal(db.store.get('settings.security'), before);
});

test('key rotation invalidates old sessions, renews the current cookie, and only changes the signing key', async () => {
  const { db, env, sys, token, request } = await setup();
  const before = Object.fromEntries(db.sqlite.prepare("SELECT key,value FROM settings WHERE key LIKE 'settings.%' AND key != 'settings.security'").all().map(row => [row.key, row.value]));
  const response = await AdminController.handleAdminAPI(request({ action: 'rotate_jwt_secret' }), env, sys);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.token);
  assert.notEqual(body.token, token);
  assert.ok(response.headers.get('Set-Cookie').includes(`cfsm_auth=${encodeURIComponent(body.token)}`));
  assert.ok(!JSON.stringify(body).includes(sys.jwt_secret), 'raw signing key is never returned');
  const persisted = await loadSettings(db, true);
  assert.ok(persisted.jwt_secret.length >= 32);
  assert.equal(await checkAuth(request({}, token), env, persisted), false);
  assert.equal(await checkAuth(request({}, body.token), env, persisted), true);
  const after = Object.fromEntries(db.sqlite.prepare("SELECT key,value FROM settings WHERE key LIKE 'settings.%' AND key != 'settings.security'").all().map(row => [row.key, row.value]));
  assert.deepEqual(after, before);
});

test('renewed HTTP and WebSocket sessions refresh a stale isolate signing key', async () => {
  const { env, sys, request } = await setup();
  const staleHttpSettings = { ...sys };
  const staleWsSettings = { ...sys };
  const response = await AdminController.handleAdminAPI(request({ action: 'rotate_jwt_secret' }), env, sys);
  const { token } = await response.json();
  assert.equal(await checkAuth(request({}, token), env, staleHttpSettings), true);
  assert.equal(staleHttpSettings.jwt_secret, sys.jwt_secret);
  const identity = await getWebSocketIdentity(new Request(`https://monitor.test/api/ws?token=${encodeURIComponent(token)}`), env, staleWsSettings);
  assert.equal(identity.authenticated, true);
  assert.equal(staleWsSettings.jwt_secret, sys.jwt_secret);
});

test('a failed key write leaves existing sessions usable', async () => {
  const { db, env, sys, token, request } = await setup();
  const oldKey = sys.jwt_secret;
  db.failed = true;
  const response = await AdminController.handleAdminAPI(request({ action: 'rotate_jwt_secret' }), env, sys);
  assert.ok(response.status >= 500);
  db.failed = false;
  assert.equal(sys.jwt_secret, oldKey);
  assert.equal((await loadSettings(db, true)).jwt_secret, oldKey);
  assert.equal(await checkAuth(request({}, token), env, sys), true);
});

test('partial settings saves preserve hidden preferences, query credentials, and registration authorization', async () => {
  const { env, sys, request } = await setup();
  const response = await AdminController.handleAdminAPI(request({ action: 'save_settings', settings: { site_title: 'Edited title' } }), env, sys);
  assert.equal(response.status, 200);
  const persisted = await loadSettings(env.DB, true);
  assert.equal(persisted.site_title, 'Edited title');
  assert.equal(persisted.display_mode, 'table');
  assert.equal(persisted.preferred_theme, 'light');
  assert.equal(persisted.default_language, 'es');
  assert.equal(persisted.cloudflare_account_id, 'account');
  assert.equal(persisted.cloudflare_token, 'analytics-token');
  assert.equal(persisted.auto_register_token, 'active-registration-key');
  assert.equal(Number(persisted.auto_register_token_expires), 9876543210);
});
