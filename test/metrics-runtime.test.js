import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('workerd meters one ordinary write, atomic cross-hour retries and hourly compaction', { timeout: 60_000 }, async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const bundle = await build({ entryPoints: [path.join(root, 'test/fixtures/runtime-worker.js')],
    bundle: true, format: 'esm', platform: 'browser', external: ['node:*', 'cloudflare:*'], write: false });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { METRICS_BROADCASTER: { className: 'RuntimeBroadcaster', useSQLite: true } } });
  try {
    const probe = async body => {
      const response = await mf.dispatchFetch('https://test/test/store-probe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const HOUR = 3600_000;
    const origin = Math.floor(Date.now() / HOUR) * HOUR;
    const send = (now, key, samples = [[now - 1000, 10]]) => probe({ action: 'ingest',
      updates: [{ serverId: 'metered', samples: samples.map(([ts, cpu]) => ({ ts, data: { cpu } })) }],
      options: { now, reportKey: key, fingerprint: key } });
    await send(origin + 10_000, 'warm');
    const normal = await send(origin + 70_000, 'minute', [[origin + 59_000, 10], [origin + 69_000, 90]]);
    assert.equal(normal.writes, 1, 'history, latest and retry ID must share one physical row');
    const duplicate = await send(origin + 70_000, 'minute', [[origin + 59_000, 10], [origin + 69_000, 90]]);
    assert.equal(duplicate.writes, 0);
    assert.equal(duplicate.result.duplicate, true);
    const boundary = await send(origin + HOUR + 10_000, 'boundary', [[origin + HOUR - 10_000, 20], [origin + HOUR + 9000, 30]]);
    assert.equal(boundary.writes, 3, 'a packet straddling two hours commits both rows and the new hour index entry');
    const retry = await send(origin + HOUR + 11_000, 'minute', [[origin + 59_000, 10]]);
    assert.equal(retry.result.duplicate, false, 'expired IDs do not suppress fresh retries');
    const compacted = await probe({ action: 'cleanup', now: origin + 3 * HOUR });
    assert.equal(compacted.writes, 2, 'fine samples and closed-hour journals compact once per row');
    const archived = await probe({ action: 'history', serverId: 'metered', options: { hours: 6, now: origin + 3 * HOUR } });
    assert.ok(archived.result.some(row => row.peaks.cpu === 90));
    const expired = await probe({ action: 'cleanup', now: origin + 8 * 24 * HOUR });
    assert.equal(expired.writes, 2, 'one hourly row expires and stale payload clears; latest heartbeat remains');
    const stats = await probe({ action: 'stats' });
    assert.equal(stats.result.blocks, 1);
  } finally { await mf.dispose(); }
});
