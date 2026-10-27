import { ensureServerSchema } from '../src/database/ServerRepository.js';
import { loadSettingsScope } from '../src/utils/settings.js';
import { makeD1 } from './helpers/d1.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GB,
  getTrafficUsageBytes,
  normalizePct,
  normalizePctOrNull,
  normalizeTrafficLimitGb
} from '../src/utils/traffic.js';
import { NotificationService } from '../src/services/NotificationService.js';
const { evaluateTrafficAlert } = NotificationService;
import { clearSiteSettingsCache } from '../src/utils/settings.js';

// ---- test doubles -------------------------------------------------------

function makeSiteSettings(overrides = {}) {
  return {
    // 合法 jwt_secret 以跳过 loadSiteSettings 的补写路径
    jwt_secret: 'a'.repeat(64),
    notification_webhook_enabled: 'true',
    notification_webhook_url: 'https://example.com/hook',
    notification_webhook_method: 'POST',
    notification_webhook_format: 'json',
    ...overrides
  };
}

function makeServer(overrides = {}) {
  return {
    id: 'srv-1',
    name: 'Box',
    traffic_limit: '1000',
    traffic_calc_type: 'total',
    // null = 跟随全局阈值（新语义）；显式 0 表示该服务器关闭告警
    traffic_alert_percent: null,
    traffic_alert_state: null,
    ...overrides
  };
}

let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  return { ok: true, async text() { return ''; }, async json() { return {}; } };
};

async function run(server, metrics, siteSettings, { changes = 1 } = {}) {
  clearSiteSettingsCache();
  fetchCalls = 0;
  const db = makeD1({ settings: { site_options: siteSettings }, servers: [server] });
  await ensureServerSchema(db);
  await loadSettingsScope(db, 'notifications');
  if (!changes) {
    db.sqlite.prepare(`INSERT INTO server_notification_state(server_id,traffic_used_bytes,traffic_threshold,traffic_limit_gb)
      VALUES(?,?,?,?)`).run(server.id, metrics.net_rx_monthly, Number(siteSettings.traffic_alert_threshold), Number(server.traffic_limit));
  }
  const start = db.writes.length;
  const patches = [];
  await evaluateTrafficAlert({ DB: db }, server, metrics, { patchCache: (id, value) => patches.push({ id, value }) });
  const stored = db.sqlite.prepare('SELECT traffic_alert_state FROM server_details WHERE id=?').get(server.id).traffic_alert_state;
  return { writes: db.writes.slice(start).filter(write => write.changes > 0), patches, fetchCalls, stored: stored ? JSON.parse(stored) : null };
}

// ---- pure utils ---------------------------------------------------------

test('normalizeTrafficLimitGb / normalizePct 消除格式差异', () => {
  assert.equal(normalizeTrafficLimitGb('1000'), 1000);
  assert.equal(normalizeTrafficLimitGb('1000.00'), 1000);
  assert.equal(normalizeTrafficLimitGb(1000), 1000);
  assert.equal(normalizeTrafficLimitGb(''), 0);
  assert.equal(normalizeTrafficLimitGb('abc'), 0);
  assert.equal(normalizePct('80'), 80);
  assert.equal(normalizePct(150), 100);
  assert.equal(normalizePct(80.5), 80);
  assert.equal(normalizePctOrNull(80.5), 80);
  assert.equal(normalizePct(-5), 0);
  assert.equal(normalizePct('x'), 0);
  // 三态：空值 → null（跟随全局），数字含 0 → 夹取整数
  assert.equal(normalizePctOrNull(null), null);
  assert.equal(normalizePctOrNull(undefined), null);
  assert.equal(normalizePctOrNull(''), null);
  assert.equal(normalizePctOrNull('x'), null);
  assert.equal(normalizePctOrNull(0), 0);
  assert.equal(normalizePctOrNull('70'), 70);
  assert.equal(normalizePctOrNull(150), 100);
  assert.equal(normalizePctOrNull(-5), 0);
});

test('getTrafficUsageBytes 与前端算法逐模式对齐', () => {
  const ref = (rxM, txM, calcType) => {
    const rx = parseFloat(rxM) || 0;
    const tx = parseFloat(txM) || 0;
    const t = calcType || 'total';
    if (t === 'dl') return rx;
    if (t === 'ul') return tx;
    if (t === 'max') return Math.max(rx, tx);
    return rx + tx;
  };
  const cases = [['300', '200'], ['0', '999'], ['12.5', '7.5']];
  for (const [rx, tx] of cases) {
    for (const t of ['total', 'ul', 'dl', 'max', undefined]) {
      assert.equal(getTrafficUsageBytes(rx, tx, t), ref(rx, tx, t), `case ${rx}/${tx}/${t}`);
    }
  }
});

// ---- evaluateTrafficAlert ----------------------------------------------

test('未设流量限制：不发送、不写', async () => {
  const { writes, fetchCalls: f } = await run(
    makeServer({ traffic_limit: '' }),
    { net_rx_monthly: 900 * GB, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 0);
  assert.equal(writes.length, 0);
});

test('未达阈值：不发送、不写', async () => {
  const { writes, fetchCalls: f } = await run(
    makeServer(),
    { net_rx_monthly: 500 * GB, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 0);
  assert.equal(writes.length, 0);
});

test('首次跨阈值：发一条通知并写入 {u,th,lim}', async () => {
  const used = 820 * GB;
  const { writes, patches, stored, fetchCalls: f } = await run(
    makeServer(),
    { net_rx_monthly: used, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 1, '应发送一次');
  assert.equal(writes.length, 2, 'claim and successful delivery each write the state row once');
  assert.deepEqual(stored, { u: used, th: 80, lim: 1000 });
  assert.equal(patches.length, 1);
  assert.deepEqual(JSON.parse(patches[0].value), stored);
});

test('同账期已发（th/lim 一致且未回落）：抑制', async () => {
  const used = 820 * GB;
  const state = JSON.stringify({ u: used, th: 80, lim: 1000 });
  const { writes, fetchCalls: f } = await run(
    makeServer({ traffic_alert_state: state }),
    { net_rx_monthly: used, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 0);
  assert.equal(writes.length, 0);
});

test('阈值变更（th 失配）：重新可发', async () => {
  const used = 820 * GB;
  const state = JSON.stringify({ u: used, th: 70, lim: 1000 });
  const { fetchCalls: f } = await run(
    makeServer({ traffic_alert_state: state }),
    { net_rx_monthly: used, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 1);
});

test('限额变更（lim 失配）：重新可发', async () => {
  const used = 820 * GB;
  const state = JSON.stringify({ u: used, th: 80, lim: 900 });
  const { fetchCalls: f } = await run(
    makeServer({ traffic_alert_state: state }),
    { net_rx_monthly: used, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 1);
});

test('回落 < 0.5u：持久清零写且不发送，刷新缓存为 null', async () => {
  const state = JSON.stringify({ u: 820 * GB, th: 80, lim: 1000 });
  const { writes, patches, fetchCalls: f } = await run(
    makeServer({ traffic_alert_state: state }),
    { net_rx_monthly: 100 * GB, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 0, '回落不应发送');
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /DELETE FROM server_notification_state/);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].value, null);
});

test('逐台阈值优先于全局', async () => {
  const used = 750 * GB; // 75%
  const { fetchCalls: f } = await run(
    makeServer({ traffic_alert_percent: 70 }), // 逐台 70 → 应触发
    { net_rx_monthly: used, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' }) // 全局 80 不触发
  );
  assert.equal(f, 1);
});

test('逐台留空（null）跟随全局阈值', async () => {
  const used = 820 * GB; // 82% ≥ 全局 80
  const { fetchCalls: f } = await run(
    makeServer({ traffic_alert_percent: null }),
    { net_rx_monthly: used, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 1);
});

test('逐台显式 0：超过全局阈值也不触发（该服务器关闭告警）', async () => {
  const used = 900 * GB; // 90%
  const { writes, fetchCalls: f } = await run(
    makeServer({ traffic_alert_percent: 0 }),
    { net_rx_monthly: used, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 0);
  assert.equal(writes.length, 0);
});

test('未配置通知渠道：不发也不写', async () => {
  const { writes, fetchCalls: f } = await run(
    makeServer(),
    { net_rx_monthly: 900 * GB, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80', notification_webhook_enabled: 'false', notification_webhook_url: '' })
  );
  assert.equal(f, 0);
  assert.equal(writes.length, 0);
});

test('另一请求已提交通知状态：不重复发送，并修正陈旧缓存', async () => {
  const used = 820 * GB;
  const { patches, fetchCalls: f } = await run(
    makeServer(),
    { net_rx_monthly: used, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' }),
    { changes: 0 }
  );
  assert.equal(f, 0, '已发送状态阻止重复通知');
  assert.equal(patches.length, 1);
  assert.equal(JSON.parse(patches[0].value).u, used);
});
