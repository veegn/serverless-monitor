import { makeD1 } from './helpers/d1.js';
import assert from 'node:assert/strict';
import { AdminController } from '../src/handlers/AdminController.js';
const {
  estimateDurableObjectsBillableRequests,
  sanitizeAdminSettings,
  summarizeDurableObjectsUsage
} = AdminController;
import {
  isValidThemeOptions,
  saveThemeOptions
} from '../src/utils/settings.js';

assert.equal(estimateDurableObjectsBillableRequests(0), 0);
assert.equal(estimateDurableObjectsBillableRequests(1), 1);
assert.equal(estimateDurableObjectsBillableRequests(20), 1);
assert.equal(estimateDurableObjectsBillableRequests(21), 2);
assert.equal(estimateDurableObjectsBillableRequests(100), 5);
assert.equal(estimateDurableObjectsBillableRequests('101'), 6);

assert.equal(estimateDurableObjectsBillableRequests({
  httpRequests: 12,
  hibernationWakeups: 20,
  inboundWebSocketMessages: 21,
  outboundWebSocketMessages: 1000
}), 34);

const usage = summarizeDurableObjectsUsage([
  { dimensions: { type: 'fetch' }, sum: { requests: 10 } },
  { dimensions: { type: 'websocket_message' }, sum: { requests: 21 } },
  { dimensions: { type: 'webSocketHibernation' }, sum: { requests: 20 } }
], [
  { sum: { inboundWebsocketMsgCount: 39, outboundWebsocketMsgCount: 100 } },
  { sum: { inboundWebsocketMsgCount: '1', outboundWebsocketMsgCount: '20' } }
]);

assert.deepEqual(usage, {
  httpRequests: 10,
  hibernationWakeups: 41,
  inboundWebSocketMessages: 40,
  outboundWebSocketMessages: 120,
  rawRequests: 51,
  billableRequests: 53
});

assert.equal(isValidThemeOptions({}), true);
assert.equal(isValidThemeOptions({ layout: 'compact' }), true);
assert.equal(isValidThemeOptions([]), false);
assert.equal(isValidThemeOptions(null), false);
assert.equal(isValidThemeOptions('{"layout":"compact"}'), false);

const safeAdminSettings = sanitizeAdminSettings({
  username: 'admin',
  password: 'pbkdf2_sha256$50000$salt$hash',
  jwt_secret: 'jwt-secret'
});
assert.equal(Object.hasOwn(safeAdminSettings, 'password'), false);
assert.equal(Object.hasOwn(safeAdminSettings, 'jwt_secret'), false);
assert.equal(safeAdminSettings.password_configured, true);
assert.equal(sanitizeAdminSettings({ password: '' }).password_configured, false);

const themeOptionsDb = makeD1({ settings: {
  appearance_options: JSON.stringify({
    site_title: 'Keep Title',
    csp_api: 'https://api.example.com',
    theme_options: { old: true }
  }),
  site_options: JSON.stringify({
    is_public: 'false',
    theme_url: 'https://github.com/example/theme/tree/main'
  })
} });

const savedAppearanceOptions = await saveThemeOptions(themeOptionsDb, {
  layout: 'compact',
  color: 'green'
});

assert.deepEqual(savedAppearanceOptions, {
  layout: 'compact',
  color: 'green'
});
assert.deepEqual(JSON.parse(themeOptionsDb.store.get('settings.theme')), {
  theme_url: 'https://github.com/example/theme/tree/main',
  theme_options: { layout: 'compact', color: 'green' }
});
assert.equal(JSON.parse(themeOptionsDb.store.get('settings.appearance')).csp_api, 'https://api.example.com');
assert.equal(JSON.parse(themeOptionsDb.store.get('settings.site')).site_title, 'Keep Title');
assert.equal(JSON.parse(themeOptionsDb.store.get('settings.site')).is_public, 'false');
assert.equal(themeOptionsDb.store.has('appearance_options'), false);
assert.equal(themeOptionsDb.store.has('site_options'), false);

console.log('admin usage tests passed');
