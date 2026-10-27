import test from 'node:test';
import assert from 'node:assert/strict';
import { makeD1 } from './helpers/d1.js';
import { SETTINGS_GROUPS, APPEARANCE_FIELDS } from '../src/utils/settingFields.js';
import { SITE_FIELDS, migrateSettings, loadSettings, loadSiteSettings, saveSettings, saveThemeOptions } from '../src/utils/settings.js';
import { clearGroupedSettingsCache } from '../src/database/GroupedSettings.js';

const secret = 'persistent-jwt-secret-'.repeat(2);
const group = (db, key) => JSON.parse(db.store.get(`settings.${key}`));

test('every supported setting belongs to exactly one functional group', () => {
  const fields = Object.values(SETTINGS_GROUPS).flat();
  assert.equal(new Set(fields).size, fields.length);
  assert.deepEqual([...new Set([...SITE_FIELDS, ...APPEARANCE_FIELDS])].sort(), [...fields].sort());
  assert.ok(fields.length + Object.keys(SETTINGS_GROUPS).length + 4 <= 100, 'D1 bindings remain within the per-statement limit');
});

test('legacy JSON settings migrate with typed values, credentials and runtime state preserved', async () => {
  const theme = { dark: false, empty: null, nested: { color: null }, list: [0, false, null] };
  const db = makeD1({ settings: {
    site_options: { is_public: 'false', jwt_secret: secret, password: 'pbkdf2_sha256$hash', username: 'owner',
      traffic_alert_threshold: 80, resource_alert_rules: [{ id: 'cpu', thresholds: [80, 90] }],
      auto_register_token: 'agent-token', custom_ct: '0', notification_webhook_enabled: true },
    appearance_options: { site_title: 'My monitor', theme_options: theme, csp_api: 'https://api.example.com' },
    tg_chat_id: 'legacy-chat', is_public: 'true', servers_optimized: 'true',
    alert_state: { a: true }, resource_alert_state: { a: { active: true } }, custom_runtime_key: 'keep'
  } });
  const values = await migrateSettings(db);
  assert.equal(values.is_public, 'false');
  assert.equal(values.jwt_secret, secret);
  assert.equal(values.password, 'pbkdf2_sha256$hash');
  assert.equal(values.tg_chat_id, 'legacy-chat');
  assert.equal(values.notification_webhook_enabled, true);
  assert.equal(values.custom_ct, '0');
  assert.deepEqual(values.theme_options, theme);
  assert.deepEqual(group(db, 'alerts').resource_alert_rules, [{ id: 'cpu', thresholds: [80, 90] }]);
  assert.deepEqual(JSON.parse(db.store.get('alert_state')), { a: true });
  assert.deepEqual(JSON.parse(db.store.get('resource_alert_state')), { a: { active: true } });
  assert.equal(db.store.get('custom_runtime_key'), 'keep');
  for (const key of ['site_options', 'appearance_options', 'is_public', 'tg_chat_id', 'servers_optimized']) assert.equal(db.store.has(key), false);
  const flat = await loadSettings(db);
  assert.equal(flat.site_title, 'My monitor');
  assert.equal(flat.jwt_secret, secret);
  assert.equal(flat.is_public, 'false');
  assert.deepEqual(flat.theme_options, theme);
});

test('partially migrated groups take precedence and preserve extensions and explicit nulls', async () => {
  const db = makeD1({ settings: {
    site_options: { jwt_secret: secret, username: 'legacy', password: 'legacy-hash', custom_ct: 'old-target' },
    'settings.account': { username: 'new-owner', extension: { keep: true }, 'extension.flag': false, 'extension.list': [null, true, { a: null }] },
    'settings.probes': { custom_ct: null }, password: 'older-hash'
  } });
  const result = await migrateSettings(db);
  assert.equal(result.username, 'new-owner');
  assert.equal(result.password, 'legacy-hash');
  assert.equal(result.custom_ct, null);
  assert.deepEqual(group(db, 'account').extension, { keep: true });
  assert.equal(group(db, 'account')['extension.flag'], false);
  assert.deepEqual(group(db, 'account')['extension.list'], [null, true, { a: null }]);
  await saveSettings(db, { username: 'changed' });
  assert.equal(group(db, 'account')['extension.flag'], false);
  assert.deepEqual(group(db, 'account')['extension.list'], [null, true, { a: null }]);
});

test('settings migration copies the current values inside its transaction', async () => {
  const db = makeD1({ settings: { site_options: { jwt_secret: secret, is_public: 'true' } } });
  const batch = db.batch.bind(db);
  db.batch = async statements => {
    db.store.set('site_options', JSON.stringify({ jwt_secret: secret, is_public: 'false', username: 'concurrent-owner' }));
    return batch(statements);
  };
  const settings = await migrateSettings(db);
  assert.equal(settings.is_public, 'false');
  assert.equal(settings.username, 'concurrent-owner');
});

test('failed settings migration rolls all groups back and retains both original JSON rows', async () => {
  const db = makeD1({ settings: { site_options: { is_public: 'false', jwt_secret: secret }, appearance_options: { site_title: 'Keep' } } });
  db.sqlite.exec("CREATE TRIGGER fail_settings BEFORE INSERT ON settings WHEN NEW.key='settings.theme' BEGIN SELECT RAISE(ABORT, 'migration fault'); END");
  await assert.rejects(migrateSettings(db), /migration fault/);
  assert.equal(db.store.has('settings.schema'), false);
  assert.equal(db.store.has('settings.account'), false);
  assert.equal(JSON.parse(db.store.get('site_options')).is_public, 'false');
  assert.equal(JSON.parse(db.store.get('appearance_options')).site_title, 'Keep');
  db.sqlite.exec('DROP TRIGGER fail_settings');
  assert.equal((await migrateSettings(db)).site_title, 'Keep');
});

test('settings patches update only the owning groups and keep explicit nested null values', async () => {
  const db = makeD1({ settings: { site_options: { jwt_secret: secret, is_public: 'false', username: 'owner' },
    appearance_options: { custom_bg: 'old-background', theme_options: { old: true } } } });
  await migrateSettings(db);
  const before = db.writes.length;
  await saveThemeOptions(db, { nested: { value: null }, enabled: false });
  const writes = db.writes.slice(before).filter(write => write.changes > 0);
  assert.deepEqual(writes.map(write => write.args[0]), ['settings.theme']);
  assert.equal(group(db, 'site').is_public, 'false');
  assert.equal(group(db, 'appearance').custom_bg, 'old-background');
  assert.equal(group(db, 'account').username, 'owner');
  assert.deepEqual(group(db, 'theme').theme_options, { nested: { value: null }, enabled: false });
  const unchanged = db.writes.length;
  await saveThemeOptions(db, { nested: { value: null }, enabled: false });
  assert.equal(db.writes.slice(unchanged).filter(write => write.changes > 0).length, 0);
});

test('concurrent settings patches keep independently changed fields, including in the same group', async () => {
  const db = makeD1({ settings: { site_options: { jwt_secret: secret } } });
  await migrateSettings(db);
  await Promise.all([
    saveSettings(db, { username: 'alice', custom_bg: 'first' }),
    saveSettings(db, { password: 'new-hash', csp_api: 'https://api.example.com' })
  ]);
  assert.equal(group(db, 'account').username, 'alice');
  assert.equal(group(db, 'account').password, 'new-hash');
  assert.equal(group(db, 'appearance').custom_bg, 'first');
  assert.equal(group(db, 'appearance').csp_api, 'https://api.example.com');
});

test('multi-group save is atomic when a later group write fails', async () => {
  const db = makeD1({ settings: { site_options: { jwt_secret: secret, username: 'old' } } });
  await migrateSettings(db);
  db.sqlite.exec("CREATE TRIGGER fail_group BEFORE INSERT ON settings WHEN NEW.key='settings.theme' BEGIN SELECT RAISE(ABORT, 'save fault'); END");
  await assert.rejects(saveSettings(db, { username: 'new', theme_options: { changed: true } }), /save fault/);
  assert.equal(group(db, 'account').username, 'old');
  assert.deepEqual(group(db, 'theme').theme_options, {});
});

test('corrupt settings fail closed without deleting source data or silently resetting policy', async () => {
  const corrupt = makeD1({ settings: { site_options: '{broken', appearance_options: {} } });
  await assert.rejects(loadSiteSettings(corrupt), error => error.code === 503);
  assert.equal(corrupt.store.get('site_options'), '{broken');
  assert.equal(corrupt.store.has('settings.schema'), false);

  const db = makeD1({ settings: { site_options: { is_public: 'true', jwt_secret: secret } } });
  await loadSiteSettings(db);
  await saveSettings(db, { is_public: 'false' });
  db.failed = true;
  await assert.rejects(loadSiteSettings(db), error => error.code === 503, 'a pre-save public policy must not be reused');
});

test('missing groups and newer schema versions are rejected', async () => {
  for (const settings of [{ 'settings.schema': { version: 1 } }, { 'settings.schema': { version: 2 } }]) {
    const db = makeD1({ settings });
    await assert.rejects(migrateSettings(db), error => error.code === 503);
    assert.equal(db.store.has('settings.site'), false);
  }
});

test('concurrent cold readers persist one stable JWT secret and grouped reads remain cached', async () => {
  const db = makeD1();
  const otherBinding = { ...db };
  const [first, second] = await Promise.all([loadSiteSettings(db), loadSiteSettings(otherBinding)]);
  assert.equal(first.jwt_secret, second.jwt_secret);
  assert.ok(first.jwt_secret.length >= 32);
  assert.equal(group(db, 'security').jwt_secret, first.jwt_secret);
  const calls = db.calls.length;
  await Promise.all([migrateSettings(db), migrateSettings(db)]);
  assert.equal(db.calls.length, calls);
  clearGroupedSettingsCache(db);
  await Promise.all([migrateSettings(db), migrateSettings(db)]);
  assert.equal(db.calls.length - calls, 1, 'concurrent refreshes share one bounded SELECT');
});
