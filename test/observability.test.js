import test from 'node:test';
import assert from 'node:assert/strict';
import { logEvent, logError, logAgentReport, ReportLogSummary, withLogContext,
  getLogContext, getLogCounts, requestLogContext, correlationHeaders } from '../src/utils/observability.js';
import { AppError, createErrorResponse } from '../src/utils/errors.js';
import { ServerlessMonitorApp } from '../src/app.js';
import { setDebug } from '../src/utils/settings.js';
import { NotificationService } from '../src/services/NotificationService.js';
import { applyCors } from '../src/utils/cors.js';

function capture(t) {
  const calls = [];
  for (const level of ['debug', 'info', 'warn', 'error']) {
    t.mock.method(console, level, (...args) => calls.push({ level, args, entry: args[0] }));
  }
  return calls;
}

test('one JSON record has readable identifiers and reserved fields cannot be overridden', t => {
  const calls = capture(t);
  withLogContext({ runtime: 'worker', requestId: 'trace-1', serverId: 'node-1' }, () => {
    logEvent('storage', 'metrics.committed', 'Metrics committed', { reportId: 'report-1', sampleCount: 30,
      durationMs: 12, source: 'spoofed', level: 'fatal', message: 'spoofed', event: 'spoofed' });
  });
  const { entry, args } = calls[0];
  assert.equal(args.length, 1);
  assert.equal(entry.source, 'cfsm');
  assert.equal(entry.event, 'metrics.committed');
  assert.equal(entry.level, 'info');
  assert.equal(entry.requestId, 'trace-1');
  assert.match(entry.message, /node=node-1.*report=report-1.*12ms/);
  assert.equal(entry.sampleCount, 30);
  assert.doesNotThrow(() => JSON.stringify(entry));
});

test('parallel async operations keep their request IDs and log levels isolated', async t => {
  const calls = capture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await Promise.all([
    withLogContext({ requestId: 'debug-request' }, async () => {
      await gate;
      logAgentReport({ serverId: 'debug-node', sampleCount: 2 });
      assert.equal(getLogContext().requestId, 'debug-request');
    }, { DEBUG: '1' }),
    withLogContext({ requestId: 'quiet-request' }, async () => {
      release(); await Promise.resolve();
      logAgentReport({ serverId: 'quiet-node' });
      logEvent('auth', 'auth.rejected', 'Denied', {}, 'warn');
    }, { LOG_LEVEL: 'warn', DEBUG: '1' })
  ]);
  assert.deepEqual(calls.map(call => [call.entry.event, call.entry.requestId]).sort(),
    [['agent.report', 'debug-request'], ['auth.rejected', 'quiet-request']]);
  assert.deepEqual(getLogContext(), {});
});

test('debug toggles emit no per-request switch messages and explicit levels take priority', t => {
  const calls = capture(t);
  setDebug(true); setDebug(true); setDebug(false);
  assert.equal(calls.length, 0);
  withLogContext({}, () => {
    logAgentReport({ serverId: 'node-1' });
    logError('storage', 'storage.failed', 'Failure', new Error('disk'));
  }, { LOG_LEVEL: 'error', DEBUG: true });
  assert.deepEqual(calls.map(call => call.level), ['error']);
  withLogContext({}, () => logError('test', 'test', 'Hidden', new Error('hidden')), { LOG_LEVEL: 'silent' });
  assert.equal(calls.length, 1);
});

test('credentials, request bodies and URL credentials are redacted, including nested error causes', t => {
  const calls = capture(t);
  const cause = new Error('Failed https://user:mail-password@example.com/private-key?token=url-secret Bearer bearer-secret');
  const error = new Error('password=inline-secret api_key="inline-api-key"', { cause });
  logError('notification', 'notification.failed', 'Notification failed', error, {
    apiSecret: 'api-secret', authorization: 'Bearer auth-secret', cookie: 'auth=cookie-secret',
    nested: { token: 'nested-token', payload: { password: 'payload-secret' } },
    samples: [{ metrics: { secret: 'raw-metrics' } }]
  });
  const serialized = JSON.stringify(calls[0].entry);
  for (const secret of ['mail-password', 'private-key', 'url-secret', 'bearer-secret', 'inline-secret', 'inline-api-key',
    'api-secret', 'auth-secret', 'cookie-secret', 'nested-token', 'payload-secret', 'raw-metrics']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.equal(calls[0].entry.error.name, 'Error');
  assert.ok(calls[0].entry.error.cause.message.includes('[redacted]'));
});

test('oversized, cyclic and non-JSON metadata cannot break the request or exceed the log budget', t => {
  const calls = capture(t);
  const circular = { count: 1n }; circular.self = circular;
  Object.defineProperty(circular, 'broken', { enumerable: true, get() { throw new Error('getter'); } });
  assert.equal(logEvent('test', 'test.metadata', 'Metadata', { circular }), true);
  assert.equal(calls[0].entry.circular.count, '1');
  assert.equal(calls[0].entry.circular.self, '[circular]');
  assert.equal(calls[0].entry.circular.broken, '[unavailable]');
  const large = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, '字'.repeat(2000)]));
  logEvent('storage', 'storage.failed', 'Large diagnostic', { ...large, status: 503 });
  const entry = calls[1].entry;
  assert.equal(entry.truncated, true);
  assert.equal(entry.status, 503);
  assert.ok(new TextEncoder().encode(JSON.stringify(entry)).byteLength <= 12 * 1024);
  const maxIdentifiers = Object.fromEntries(['runtime', 'trigger', 'requestId', 'rayId', 'connectionId', 'serverId', 'reportId', 'transport', 'method', 'path', 'task', 'cron']
    .map(key => [key, '字'.repeat(1000)]));
  logError('storage', 'storage.failed', '字'.repeat(1000), new Error('字'.repeat(1000)), { ...maxIdentifiers, ...large });
  assert.ok(new TextEncoder().encode(JSON.stringify(calls[2].entry)).byteLength <= 12 * 1024);
  t.mock.method(console, 'error', () => { throw new Error('logging unavailable'); });
  assert.doesNotThrow(() => logError('test', 'test.failed', 'Failure', new Error('original')));
});

test('minute summaries collapse reports, count retries separately, and omit individual request attribution', t => {
  const calls = capture(t);
  const summary = new ReportLogSummary();
  const start = Math.floor(Date.now() / 60_000) * 60_000;
  withLogContext({ requestId: 'current-request', serverId: 'current-node' }, () => {
    for (let i = 0; i < 300; i++) summary.record({ serverIds: [`node-${i % 5}`], sampleCount: 2,
      duplicate: i < 10, durationMs: 4, transport: i % 2 ? 'wss' : 'http', now: start + i });
    assert.equal(calls.length, 0);
    summary.record({ serverIds: ['next-node'], sampleCount: 1, now: start + 60_000 });
    assert.equal(calls.length, 1);
    summary.flush(); summary.flush();
  });
  const entry = calls[0].entry;
  assert.equal(entry.event, 'metrics.summary');
  assert.equal(entry.reportCount, 300);
  assert.equal(entry.sampleCount, 600);
  assert.equal(entry.duplicateCount, 10);
  assert.equal(entry.serverCount, 5);
  assert.equal(entry.httpReports, 150);
  assert.equal(entry.wssReports, 150);
  assert.equal(entry.requestId, undefined);
  assert.equal(entry.serverId, undefined);
  assert.equal(calls.length, 2);
});

test('request IDs ignore unsafe forwarded values and URLs never include query credentials', () => {
  const request = new Request('https://monitor.test/update?token=secret', {
    headers: { 'X-CFSM-Request-ID': 'forwarded-123', 'cf-ray': 'abc123-HKG' }
  });
  const worker = requestLogContext(request);
  assert.equal(worker.requestId, 'abc123-HKG');
  assert.equal(worker.path, '/update');
  assert.equal(requestLogContext(request, 'durable-object').requestId, 'forwarded-123');
  const unsafe = new Request(request, { headers: { 'X-CFSM-Request-ID': 'invalid id with spaces', 'cf-ray': 'abc123-HKG' } });
  assert.equal(requestLogContext(unsafe, 'durable-object').requestId, 'abc123-HKG');
  withLogContext(worker, () => assert.equal(correlationHeaders()['X-CFSM-Request-ID'], worker.requestId));
});

test('client rejections are warnings without stacks, while unexpected errors retain diagnostic causes', t => {
  const calls = capture(t);
  assert.equal(createErrorResponse(new AppError('Conflicting reportId', 409)).status, 409);
  assert.equal(calls[0].level, 'warn');
  assert.equal(calls[0].entry.error.stack, undefined);
  const error = new Error('Storage failed', { cause: new Error('SQLite full') });
  assert.equal(createErrorResponse(error).status, 500);
  assert.equal(calls[1].level, 'error');
  assert.match(calls[1].entry.error.cause.message, /SQLite full/);
  assert.ok(calls[1].entry.error.stack);
});

test('HTTP errors log once and return the same request ID for client-side correlation', async t => {
  const calls = capture(t);
  const app = new ServerlessMonitorApp({});
  app.handleRequest = async () => { throw new AppError('Storage unavailable', 503); };
  const response = await app.fetch(new Request('https://monitor.test/update?token=not-for-logs', {
    method: 'POST', headers: { 'cf-ray': 'trace-123-HKG' }
  }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('X-Request-ID'), 'trace-123-HKG');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].entry.requestId, 'trace-123-HKG');
  assert.equal(JSON.stringify(calls).includes('not-for-logs'), false);
});

test('allowed cross-origin clients can read request IDs without duplicating exposed headers', async t => {
  capture(t);
  const request = new Request('https://monitor.test/api/servers', { headers: { Origin: 'https://frontend.test' } });
  const allowed = ['https://frontend.test'];
  const app = new ServerlessMonitorApp({ CORS_ALLOWED_ORIGINS: allowed[0] });
  app.handleRequest = async () => applyCors(new Response('OK', { headers: { 'Access-Control-Expose-Headers': 'X-Custom' } }), request, allowed);
  const response = await app.fetch(request);
  assert.ok(response.headers.get('X-Request-ID'));
  const exposed = response.headers.get('Access-Control-Expose-Headers').split(',').map(value => value.trim());
  assert.ok(exposed.includes('X-Request-ID'));
  assert.ok(exposed.includes('X-Custom'));
  assert.equal(exposed.length, new Set(exposed).size);
});

test('cron detects failures handled inside a task instead of reporting a false successful run', async t => {
  const calls = capture(t);
  const app = new ServerlessMonitorApp({});
  app.notificationService.checkOfflineNodes = async () => logError('alert', 'alert.offline.failed', 'Offline check failed', new Error('DB unavailable'));
  app.notificationService.checkResourceAlerts = async () => {};
  await app.scheduled({ cron: '*/1 * * * *', scheduledTime: Date.now() });
  const result = calls.find(call => call.entry.event === 'cron.completed').entry;
  assert.equal(result.outcome, 'partial_failure');
  assert.equal(result.errors, 1);
  assert.equal(result.level, 'warn');
  assert.equal(calls[0].entry.requestId, result.requestId);
  withLogContext({}, () => assert.deepEqual(getLogCounts(), { warnings: 0, errors: 0 }));
});

test('slow successful requests are visible at info configuration without logging every success', async t => {
  const calls = capture(t);
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const app = new ServerlessMonitorApp({ LOG_SLOW_MS: 1000 });
  app.handleRequest = async () => { clock += 1200; return new Response('OK'); };
  const result = await app.fetch(new Request('https://monitor.test/api/servers'));
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].entry.event, 'http.request.slow');
  assert.equal(calls[0].entry.status, 200);
  assert.equal(calls[0].entry.durationMs, 1200);
  assert.equal(calls[0].level, 'warn');
});

test('notification logging preserves delivery results and exceptions without logging message bodies', async t => {
  const calls = capture(t);
  t.mock.method(NotificationService, 'deliverNotification', async () => 'Send failed token=hidden-key');
  const settings = { notification_webhook_enabled: 'true' };
  const result = await NotificationService.sendNotification(settings, 'private message content', { event: 'offline', count: 2 });
  assert.equal(result, 'Send failed token=hidden-key');
  assert.equal(calls[0].entry.channel, 'webhook');
  assert.equal(calls[0].entry.clientCount, 2);
  assert.equal(JSON.stringify(calls).includes('private message content'), false);
  assert.equal(JSON.stringify(calls).includes('hidden-key'), false);
  const original = new Error('Delivery exception');
  t.mock.method(NotificationService, 'deliverNotification', async () => { throw original; });
  await assert.rejects(NotificationService.sendNotification(settings, 'private message content'), error => error === original);
});
