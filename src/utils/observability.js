/**
 * Cloudflare Workers & Durable Objects Observability Logger
 * Formats high-readability log lines and structured metadata for Cloudflare Dashboard,
 * Logpush, Tail Workers, and Observability Metrics.
 */

export const LogLevel = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error'
};

/**
 * Emit a structured WSS observability event.
 * In Cloudflare Workers Observability:
 * - The first argument (`summary`) is rendered in the main log stream for instant human readability.
 * - The second argument (`metadata`) is parsed as a JSON payload for structured filtering and querying.
 *
 * @param {string} category - e.g. 'Agent', 'Frontend', 'Mode', 'D1', 'Alert'
 * @param {string} action - e.g. 'REPORT', 'CONNECT', 'AUTH_OK', 'HINT', 'BATCH_WRITE'
 * @param {string} message - Human-readable summary
 * @param {Record<string, any>} [metadata={}] - Structured attributes
 * @param {string} [level=LogLevel.INFO] - Log severity
 */
export function logWssEvent(category, action, message, metadata = {}, level = LogLevel.INFO) {
  const timestamp = new Date().toISOString();
  const summary = `[WSS:${category}] ${action} | ${message}`;
  const payload = {
    source: 'cfsm.wss',
    category,
    action,
    timestamp,
    ...metadata
  };

  switch (level) {
    case LogLevel.DEBUG:
      console.debug(summary, payload);
      break;
    case LogLevel.WARN:
      console.warn(summary, payload);
      break;
    case LogLevel.ERROR:
      console.error(summary, payload);
      break;
    case LogLevel.INFO:
    default:
      console.info(summary, payload);
      break;
  }
}

export function logAgentConnect(metadata) {
  const { serverId = 'unknown', ip = '', agentVersion = '', isHibernating = false } = metadata;
  logWssEvent(
    'Agent',
    'CONNECT',
    `Agent connected: server=${serverId} v=${agentVersion || 'unknown'} ip=${ip || 'unknown'}${isHibernating ? ' (hibernating)' : ''}`,
    metadata,
    LogLevel.INFO
  );
}

export function logAgentAuth(metadata, success = true, reason = '') {
  const { serverId, agentVersion, ip } = metadata;
  if (success) {
    logWssEvent(
      'Agent',
      'AUTH_OK',
      `Authenticated server=${serverId} v=${agentVersion || 'unknown'} ip=${ip || 'unknown'}`,
      metadata,
      LogLevel.INFO
    );
  } else {
    logWssEvent(
      'Agent',
      'AUTH_FAIL',
      `Auth failed for server=${serverId || 'unknown'}: ${reason}`,
      { ...metadata, reason },
      LogLevel.WARN
    );
  }
}

export function logAgentReport(metadata) {
  const {
    serverId,
    mode = 'realtime',
    sampleCount = 1,
    reportId = null,
    persisted = false,
    durationMs = 0
  } = metadata;
  logWssEvent(
    'Agent',
    'REPORT',
    `Report: server=${serverId} mode=${mode} samples=${sampleCount}${reportId ? ` reportId=${reportId}` : ''} persisted=${persisted ? 'yes' : 'no'} (${durationMs}ms)`,
    metadata,
    LogLevel.INFO
  );
}

export function logModeTransition(metadata) {
  const { isFrontendActive, subscribers = 0, hintedAgents = 0, modeRevision = 0, reason = '' } = metadata;
  const targetMode = isFrontendActive ? 'REALTIME' : 'IDLE_BATCH';
  logWssEvent(
    'Mode',
    'HINT',
    `Mode -> ${targetMode} (subscribers=${subscribers}, hintedAgents=${hintedAgents}, rev=${modeRevision})${reason ? ` reason=${reason}` : ''}`,
    { ...metadata, targetMode },
    LogLevel.INFO
  );
}

export function logFrontendConnect(metadata) {
  const { scope = 'all', ip = '', subscribers = 1 } = metadata;
  logWssEvent(
    'Frontend',
    'CONNECT',
    `Visitor WS connected: scope=${scope} ip=${ip || 'unknown'} totalSubscribers=${subscribers}`,
    metadata,
    LogLevel.INFO
  );
}

export function logFrontendSubscribe(metadata) {
  const { scope = 'all', serverCount = 0, subscribers = 1 } = metadata;
  logWssEvent(
    'Frontend',
    'SUBSCRIBE',
    `Visitor scope updated: scope=${scope} servers=${serverCount} totalSubscribers=${subscribers}`,
    metadata,
    LogLevel.INFO
  );
}

export function logFrontendDisconnect(metadata) {
  const { scope = 'all', remainingSubscribers = 0, reason = '' } = metadata;
  logWssEvent(
    'Frontend',
    'DISCONNECT',
    `Visitor WS disconnected: scope=${scope} remainingSubscribers=${remainingSubscribers}${reason ? ` (${reason})` : ''}`,
    metadata,
    LogLevel.INFO
  );
}

export function logMetricsPersist(metadata, success = true, err = null) {
  const { serverId, sampleCount = 0, durationMs = 0 } = metadata;
  if (success) {
    logWssEvent(
      'Storage',
      'BATCH_WRITE_OK',
      `Saved ${sampleCount} samples for server=${serverId} in ${durationMs}ms`,
      metadata,
      LogLevel.INFO
    );
  } else {
    logWssEvent(
      'Storage',
      'BATCH_WRITE_FAIL',
      `Failed to save ${sampleCount} samples for server=${serverId}: ${err?.message || err}`,
      { ...metadata, error: err?.message || String(err) },
      LogLevel.ERROR
    );
  }
}
