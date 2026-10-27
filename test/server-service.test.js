import { makeD1 } from './helpers/d1.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerService } from '../src/services/ServerService.js';
import { clearServersListCache } from '../src/utils/cache.js';

test('ServerService: admin mode retains real IPs, hidden nodes, and private note while stripping secret', async () => {
  clearServersListCache();
  const now = Date.now();

  const publicServer = {
    id: 'srv-admin-pub-1',
    name: 'Public Node',
    is_hidden: 0,
    secret: 'super-secret-1',
    bandwidth: 1000,
    note: 'Sensitive rack location note',
    auto_update: 1,
    region: 'US'
  };

  const hiddenServer = {
    id: 'srv-admin-hid-1',
    name: 'Hidden Node',
    is_hidden: 1,
    secret: 'super-secret-2',
    note: 'Internal gateway',
    auto_update: 0,
    region: 'HK'
  };

  const fakeBroadcaster = {
    async fetch(request) {
      const url = new URL(typeof request === 'string' ? request : request.url);
      if (url.pathname === '/latest-report-updates') {
        return new Response(JSON.stringify({
          updates: [
            {
              serverId: 'srv-admin-pub-1',
              reportTs: now,
              samples: [{
                ts: now,
                data: {
                  cpu: 25.5,
                  net_in_speed: 1024,
                  net_out_speed: 2048,
                  ip_v4: '198.51.100.10',
                  ip_v6: '2001:db8::10',
                  os: 'Ubuntu 24.04',
                  arch: 'x86_64'
                }
              }]
            }
          ]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }
  };

  const fakeEnv = {
    DB: makeD1({ servers: [publicServer, hiddenServer] }),
    METRICS_BROADCASTER: {
      idFromName() { return 'global'; },
      get() { return fakeBroadcaster; }
    }
  };

  const result = await ServerService.getServersWithState(fakeEnv, {
    includeHidden: true,
    maskPublicIp: false,
    stripPrivateFields: false,
    includeLatencyHistory: false
  });

  assert.equal(result.servers.length, 2, 'Admin mode must return both public and hidden servers');

  const pub = result.servers.find(s => s.id === 'srv-admin-pub-1');
  assert.ok(pub);
  assert.equal(pub.is_online, true);
  assert.equal(pub.ip_v4, '198.51.100.10', 'Admin must receive unmasked real IPv4');
  assert.equal(pub.ip_v6, '2001:db8::10', 'Admin must receive unmasked real IPv6');
  assert.equal(pub.note, 'Sensitive rack location note', 'Admin must retain note');
  assert.equal(pub.auto_update, '1', 'Admin must retain auto_update');
  assert.equal(pub.secret, undefined, 'Secret must never be exposed');
  assert.equal(pub.bandwidth, undefined, 'Deprecated bandwidth must be stripped');

  const hid = result.servers.find(s => s.id === 'srv-admin-hid-1');
  assert.ok(hid);
  assert.equal(hid.is_online, false);
  assert.equal(hid.note, 'Internal gateway');
  assert.equal(hid.secret, undefined);

  assert.equal(result.stats.total, 2);
  assert.equal(result.stats.online, 1);
  assert.equal(result.stats.offline, 1);
  assert.equal(result.stats.total_cpu, 25.5);
  assert.equal(result.stats.avg_cpu, '25.50');
});

test('ServerService: visitor mode masks public IPs, filters hidden nodes, and strips private fields', async () => {
  clearServersListCache();
  const now = Date.now();

  const publicServer = {
    id: 'srv-vis-pub-1',
    name: 'Public Node',
    is_hidden: 0,
    secret: 'super-secret-1',
    note: 'Internal note',
    auto_update: 1,
    region: 'JP'
  };

  const hiddenServer = {
    id: 'srv-vis-hid-1',
    name: 'Hidden Node',
    is_hidden: 1,
    secret: 'super-secret-2',
    region: 'US'
  };

  const fakeBroadcaster = {
    async fetch(request) {
      const url = new URL(typeof request === 'string' ? request : request.url);
      if (url.pathname === '/latest-report-updates') {
        return new Response(JSON.stringify({
          updates: [
            {
              serverId: 'srv-vis-pub-1',
              reportTs: now,
              samples: [{
                ts: now,
                data: {
                  cpu: 10,
                  ip_v4: '203.0.113.50',
                  ip_v6: '2001:db8::50'
                }
              }]
            }
          ]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }
  };

  const fakeEnv = {
    DB: makeD1({ servers: [publicServer, hiddenServer] }),
    METRICS_BROADCASTER: {
      idFromName() { return 'global'; },
      get() { return fakeBroadcaster; }
    }
  };

  const result = await ServerService.getServersWithState(fakeEnv, {
    includeHidden: false,
    maskPublicIp: true,
    stripPrivateFields: true,
    includeLatencyHistory: false
  });

  assert.equal(result.servers.length, 1, 'Visitor mode must filter hidden servers');
  const pub = result.servers[0];
  assert.equal(pub.id, 'srv-vis-pub-1');
  assert.equal(pub.is_online, true);
  assert.equal(pub.ip_v4, '1', 'Visitor IPv4 must be reachability mask 1');
  assert.equal(pub.ip_v6, '1', 'Visitor IPv6 must be reachability mask 1');
  assert.equal(pub.note, undefined, 'Visitor must not see note');
  assert.equal(pub.auto_update, undefined, 'Visitor must not see auto_update');
  assert.equal(pub.secret, undefined);
  assert.equal(result.regionStats['JP'], 1);
});

test('ServerService: instance method delegates to static getServersWithState', async () => {
  clearServersListCache();
  const fakeEnv = {
    DB: makeD1({ servers: [] }),
    METRICS_BROADCASTER: null
  };

  const service = new ServerService(fakeEnv);
  const result = await service.getServersWithState();
  assert.deepEqual(result.servers, []);
  assert.equal(result.stats.total, 0);
});
