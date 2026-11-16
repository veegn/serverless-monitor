import { TIME } from './constants.js'
import { normalizeTimestamp } from './time.js'

export const getServerReportTimestamp = (server, fallback = null) => {
  return normalizeTimestamp(server?.report_timestamp ?? server?.last_updated, fallback)
}

export const isServerOnline = (server, now = Date.now()) => {
  const reportedAt = getServerReportTimestamp(server)
  return reportedAt !== null && now - reportedAt < TIME.ONLINE_THRESHOLD_MS
}

export const getServerStatus = (server, now = Date.now()) => {
  if (isServerOnline(server, now)) return 'online'
  return server?.metricsUnavailable ? 'unknown' : 'offline'
}

export const getServerMetricsForDisplay = (server, status) => {
  if (status !== 'offline') return server

  return {
    ...server,
    cpu: 0,
    ram_used: 0,
    swap_used: 0,
    disk_used: 0,
    net_in_speed: 0,
    net_out_speed: 0,
    load_avg: '0.00 0.00 0.00',
    processes: 0,
    tcp_conn: 0,
    udp_conn: 0
  }
}
