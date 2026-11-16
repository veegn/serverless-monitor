import assert from 'node:assert/strict';
import test from 'node:test';
import { TIME } from '../src/frontend/utils/constants.js';
import { getServerMetricsForDisplay, getServerStatus } from '../src/frontend/utils/serverMetrics.js';

test('expired reports display zero usage while preserving traffic, capacity, and original samples', () => {
  const reportedAt = Date.UTC(2026, 0, 1);
  const expiresAt = reportedAt + TIME.ONLINE_THRESHOLD_MS;
  const usage = {
    cpu: 42, ram_used: 1024, swap_used: 10, disk_used: 2048,
    net_in_speed: 3100, net_out_speed: 1120, load_avg: '0.75 0.50 0.25',
    processes: 25, tcp_conn: 16, udp_conn: 4
  };
  const retained = {
    ram_total: 4096, disk_total: 8192, swap_total: 1024,
    net_rx: 32000, net_tx: 57000, net_rx_monthly: 12000, net_tx_monthly: 44000,
    traffic_limit: 120, traffic_calc_type: 'max'
  };
  const server = Object.freeze({
    ...usage,
    ...retained,
    report_timestamp: reportedAt,
    // Playback can update the sample display time without a new report.
    last_updated: expiresAt - 1
  });
  const displayAt = (server, time) => getServerMetricsForDisplay(server, getServerStatus(server, time));

  assert.equal(displayAt(server, expiresAt - 1), server);
  assert.deepEqual(displayAt(server, expiresAt), {
    ...server,
    cpu: 0, ram_used: 0, swap_used: 0, disk_used: 0,
    net_in_speed: 0, net_out_speed: 0, load_avg: '0.00 0.00 0.00',
    processes: 0, tcp_conn: 0, udp_conn: 0
  });
  assert.equal(server.cpu, 42);

  const recovered = { ...server, cpu: 63, report_timestamp: expiresAt + 1000 };
  assert.equal(displayAt(recovered, expiresAt + 1000).cpu, 63);
  assert.equal(displayAt(recovered, expiresAt + 1000).net_in_speed, usage.net_in_speed);
});

test('unknown metrics state remains distinct from offline', () => {
  const server = { metricsUnavailable: true, cpu: 45 };
  const status = getServerStatus(server);
  assert.equal(status, 'unknown');
  assert.equal(getServerMetricsForDisplay(server, status), server);
  assert.equal(getServerStatus({}), 'offline');
});
