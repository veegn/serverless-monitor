import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerlessMonitorApp } from '../src/app.js';
import { DatabaseService } from '../src/database/DatabaseService.js';
import { NotificationService } from '../src/services/NotificationService.js';
import { UpdateController } from '../src/handlers/UpdateController.js';
import { DashboardController } from '../src/handlers/DashboardController.js';
import { AdminController } from '../src/handlers/AdminController.js';
import { FrontendController } from '../src/handlers/FrontendController.js';
import { ThemeController } from '../src/handlers/ThemeController.js';
import appEntry, { MetricsBroadcaster } from '../src/index.js';

test('ES6 Class Architecture: ServerlessMonitorApp initialization and dependency injection', () => {
  const mockDb = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) };
  const mockEnv = {
    DB: mockDb,
    API_SECRET: 'test_secret_123',
    DEBUG: 0
  };
  const mockCtx = { waitUntil: () => {} };

  const app = new ServerlessMonitorApp(mockEnv, mockCtx);

  assert.ok(app instanceof ServerlessMonitorApp);
  assert.equal(app.env, mockEnv);
  assert.equal(app.ctx, mockCtx);
  assert.equal(app.db, mockDb);

  // Verify service and controller instances
  assert.ok(app.dbService instanceof DatabaseService);
  assert.ok(app.notificationService instanceof NotificationService);
  assert.ok(app.updateController instanceof UpdateController);
  assert.ok(app.dashboardController instanceof DashboardController);
  assert.ok(app.adminController instanceof AdminController);
  assert.ok(app.frontendController instanceof FrontendController);
  assert.ok(app.themeController instanceof ThemeController);
});

test('ES6 Class Architecture: ServerlessMonitorApp request handling and routing', async () => {
  const mockEnv = {
    DB: {
      prepare: () => ({
        first: async () => null,
        bind: () => ({
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({})
        }),
        all: async () => ({ results: [] }),
        run: async () => ({})
      })
    },
    API_SECRET: 'test_secret_123',
    DEBUG: 0
  };

  const app = new ServerlessMonitorApp(mockEnv);

  // Missing API_SECRET check
  const appNoSecret = new ServerlessMonitorApp({ DB: mockEnv.DB });
  const resNoSecret = await appNoSecret.fetch(new Request('https://monitor.test/api/config'));
  assert.equal(resNoSecret.status, 400);

  // OPTIONS CORS preflight check
  const optionsReq = new Request('https://monitor.test/api/servers', { method: 'OPTIONS' });
  const optionsRes = await app.fetch(optionsReq);
  assert.equal(optionsRes.status, 204);

  // /admin/ 302 redirect check
  const adminRedirectReq = new Request('https://monitor.test/admin/?foo=bar', { method: 'GET' });
  const adminRedirectRes = await app.fetch(adminRedirectReq);
  assert.equal(adminRedirectRes.status, 302);
  assert.equal(adminRedirectRes.headers.get('Location'), 'https://monitor.test/admin#/admin?foo=bar');
});

test('ES6 Class Architecture: src/index.js entry point exports', async () => {
  assert.ok(typeof appEntry.fetch === 'function');
  assert.ok(typeof appEntry.scheduled === 'function');
  assert.ok(typeof MetricsBroadcaster === 'function');

  // Verify fetch delegates to ServerlessMonitorApp
  const mockEnv = {
    DB: { prepare: () => ({ first: async () => null }) },
    API_SECRET: 'secret'
  };
  const res = await appEntry.fetch(new Request('https://monitor.test/api/servers', { method: 'OPTIONS' }), mockEnv, {});
  assert.equal(res.status, 204);
});
