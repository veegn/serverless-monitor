import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSecretAuthorization, handleUpdate } from '../src/handlers/update.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { withoutPrivateServerFields } from '../src/handlers/dashboard.js';
import { clearSiteSettingsCache } from '../src/utils/settings.js';
import { clearServersListCache } from '../src/utils/cache.js';
import { generateToken } from '../src/middleware/auth.js';

function makeEnv(siteSettings, { changes = 1 } = {}) {
  const writes = [];
  const env = {
    API_SECRET: 'master_secret',
    DB: {
      prepare(sql) {
        return {
          _sql: sql,
          bind(...args) { this._args = args; return this; },
          async first() {
            if (sql.includes("key = 'site_options'")) return { value: JSON.stringify(siteSettings) };
            return null;
          },
          async all() { return { results: [] }; },
          async run() {
            writes.push({ sql, args: this._args || [] });
            return { success: true, meta: { changes } };
          }
        };
      }
    }
  };
  return { env, writes };
}

test('checkSecretAuthorization: validates master secret, server secret, and token with 30-min expiration', () => {
  const env = { API_SECRET: 'master_secret_123' };
  const now = Date.now();

  // 1. Master secret
  const authMaster = checkSecretAuthorization('master_secret_123', null, {}, env);
  assert.equal(authMaster.isMaster, true);
  assert.equal(authMaster.isAuthorizedForExisting, true);
  assert.equal(authMaster.isAuthorizedForNew, true);

  // 2. Server's registered secret
  const serverDetail = { id: 'srv-1', secret: 'server_specific_secret' };
  const authServer = checkSecretAuthorization('server_specific_secret', serverDetail, {}, env);
  assert.equal(authServer.isServer, true);
  assert.equal(authServer.isAuthorizedForExisting, true);
  assert.equal(authServer.isAuthorizedForNew, false);

  // 3. Valid token (expires in 30 minutes)
  const validSettings = {
    auto_register_token: 'cfsm_valid_token',
    auto_register_token_expires: now + 30 * 60 * 1000
  };
  const authTokenValid = checkSecretAuthorization('cfsm_valid_token', null, validSettings, env);
  assert.equal(authTokenValid.isTokenMatch, true);
  assert.equal(authTokenValid.isTokenExpired, false);
  assert.equal(authTokenValid.isTokenValid, true);
  assert.equal(authTokenValid.isAuthorizedForNew, true);

  // 4. Expired token (expired 1 second ago)
  const expiredSettings = {
    auto_register_token: 'cfsm_expired_token',
    auto_register_token_expires: now - 1000
  };
  const authTokenExpired = checkSecretAuthorization('cfsm_expired_token', null, expiredSettings, env);
  assert.equal(authTokenExpired.isTokenMatch, true);
  assert.equal(authTokenExpired.isTokenExpired, true);
  assert.equal(authTokenExpired.isTokenValid, false);
  assert.equal(authTokenExpired.isAuthorizedForNew, false);
  assert.equal(authTokenExpired.isAuthorizedForExisting, false);

  // 5. Wrong secret
  const authWrong = checkSecretAuthorization('wrong_secret', null, validSettings, env);
  assert.equal(authWrong.isMaster, false);
  assert.equal(authWrong.isServer, false);
  assert.equal(authWrong.isTokenMatch, false);
  assert.equal(authWrong.isAuthorizedForNew, false);
});

test('handleUpdate: auto registration rejects when disabled', async () => {
  clearSiteSettingsCache();
  clearServersListCache();
  const { env } = makeEnv({
    jwt_secret: 'a'.repeat(64),
    auto_register_enabled: 'false',
    auto_register_token: 'token123',
    auto_register_token_expires: Date.now() + 30 * 60 * 1000
  });

  const req = new Request('https://example.com/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'new-server-1', secret: 'token123' })
  });

  const res = await handleUpdate(req, env, { waitUntil() {} });
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.text, 'server_not_found');
});

test('handleUpdate: auto registration rejects when token is expired (> 30 min)', async () => {
  clearSiteSettingsCache();
  clearServersListCache();
  const { env } = makeEnv({
    jwt_secret: 'a'.repeat(64),
    auto_register_enabled: 'true',
    auto_register_token: 'token123',
    auto_register_token_expires: Date.now() - 5000 // expired
  });

  const req = new Request('https://example.com/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'new-server-2', secret: 'token123' })
  });

  const res = await handleUpdate(req, env, { waitUntil() {} });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.text, 'auto_register_key_expired');
});

test('handleAdminAPI: generate_auto_register_token creates token with 30-min validity', async () => {
  clearSiteSettingsCache();
  const sys = {
    jwt_secret: 'a'.repeat(64),
    password: 'password_hash',
    auto_register_enabled: 'true'
  };
  const { env, writes } = makeEnv(sys);

  const token = await generateToken(env, sys);

  const req = new Request('https://example.com/admin/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ action: 'generate_auto_register_token' })
  });

  const res = await handleAdminAPI(req, env, sys, async () => sys);
  const data = await res.json();

  assert.equal(data.success, true);
  assert.match(data.token, /^cfsm_[0-9a-f]{32}$/);
  const diffMinutes = (data.expires_at - Date.now()) / 60000;
  assert.ok(diffMinutes > 29.5 && diffMinutes <= 30.1);

  const siteOptionWrite = writes.find(w => w.args && w.args[0] === 'site_options');
  assert.ok(siteOptionWrite);
  const savedOptions = JSON.parse(siteOptionWrite.args[1]);
  assert.equal(savedOptions.auto_register_token, data.token);
  assert.equal(savedOptions.auto_register_token_expires, data.expires_at);
});

test('handleAdminAPI: save_settings preserves and returns auto_register_enabled and auto_register_default_group', async () => {
  clearSiteSettingsCache();
  const sys = {
    jwt_secret: 'a'.repeat(64),
    password: 'password_hash',
    auto_register_enabled: 'false',
    auto_register_default_group: 'Default'
  };
  const { env, writes } = makeEnv(sys);
  const token = await generateToken(env, sys);

  const saveReq = new Request('https://example.com/admin/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      action: 'save_settings',
      settings: {
        auto_register_enabled: 'true',
        auto_register_default_group: 'Hong Kong Cluster'
      }
    })
  });

  const saveRes = await handleAdminAPI(saveReq, env, sys, async () => sys);
  const saveData = await saveRes.json();
  assert.equal(saveData.success, true);

  const siteOptionWrite = writes.find(w => w.args && w.args[0] === 'site_options');
  assert.ok(siteOptionWrite);
  const savedOptions = JSON.parse(siteOptionWrite.args[1]);
  assert.equal(savedOptions.auto_register_enabled, 'true');
  assert.equal(savedOptions.auto_register_default_group, 'Hong Kong Cluster');
});

test('withoutPrivateServerFields: strips secret from public response', () => {
  const server = {
    id: 'test-srv',
    name: 'My Node',
    secret: 'cfsm_super_secret_key',
    bandwidth: 100,
    note: 'secret note',
    auto_update: '1'
  };

  const publicServer = withoutPrivateServerFields(server);
  assert.equal(publicServer.id, 'test-srv');
  assert.equal(publicServer.name, 'My Node');
  assert.equal('secret' in publicServer, false);
  assert.equal('bandwidth' in publicServer, false);
  assert.equal('note' in publicServer, false);
  assert.equal('auto_update' in publicServer, false);
});
