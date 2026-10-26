export function metricFixture(ts, second, full = false) {
  const data = {
    cpu: Number((30 + 20 * Math.sin(second / 17)).toFixed(3)),
    ram_total: 8192, ram_used: 2048 + second % 1000 / 10,
    swap_total: 2048, swap_used: second % 17,
    net_in_speed: (second % 120 === 0 ? 90 : 1) * 1024 * 1024 + second * 3,
    net_out_speed: 10000 + second * 5
  };
  if (full) {
    Object.assign(data, {
      timestamp: ts, os: 'Ubuntu 24.04 LTS', arch: 'x86_64', kernel_version: '6.8.0-71-generic',
      cpu_info: 'AMD EPYC 7763 64-Core Processor', cpu_cores: 8, region: 'HK',
      ip_v4: '192.0.2.10', ip_v6: '2001:db8::1', boot_time: String(ts - 30 * 86400_000),
      load_avg: `${(data.cpu / 20).toFixed(2)} 1.20 0.80`,
      disk_total: 102400, disk_used: 20480 + second / 360,
      disk: { read_bps: second * 12, write_bps: second * 6, read_iops: second % 31,
        write_iops: second % 17, await_ms: 1.2 + second % 7 / 10, util: second % 25 },
      net_rx: 1_000_000_000_000 + second * 65536, net_tx: 500_000_000_000 + second * 32768,
      net_rx_monthly: 3_000_000_000_000 + second * 65536, net_tx_monthly: 2_000_000_000_000 + second * 32768,
      processes: 150 + second % 30, tcp_conn: 120 + second % 17, udp_conn: 8 + second % 7,
      gpu_info: [0, 1].map(id => ({ id: String(id), name: `NVIDIA Tesla T4 ${id}`, info: data.cpu + id,
        mem_used: 1024 + second % 300, mem_total: 16384, sm_clock: 800 + second % 400,
        mem_clock: 5000, temp: 45 + second % 15, power: 30 + second % 35 }))
    });
    for (const [index, probe] of ['ct', 'cu', 'cm', 'bd', 'node_1', 'node_2', 'node_3', 'node_4'].entries()) {
      data[`ping_${probe}`] = 10 + index * 12 + second % 23;
      data[`loss_${probe}`] = second % 599 === 0 ? 1 : 0;
    }
  }
  return data;
}
