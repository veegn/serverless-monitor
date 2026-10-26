import { logError, correlationHeaders } from './observability.js';
export async function notifyAgentConfigChanged(env, serverId) {
  const normalizedServerId = String(serverId || '').trim();
  if (!normalizedServerId || !env?.METRICS_BROADCASTER) return null;

  const id = env.METRICS_BROADCASTER.idFromName('global');
  const stub = env.METRICS_BROADCASTER.get(id);
  return stub.fetch('http://internal/agent-config-changed', {
    method: 'POST',
    headers: correlationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ serverId: normalizedServerId })
  });
}

export async function notifyAgentReportModeChanged(env) {
  if (!env?.METRICS_BROADCASTER) return null;

  const id = env.METRICS_BROADCASTER.idFromName('global');
  const stub = env.METRICS_BROADCASTER.get(id);
  return stub.fetch('http://internal/agent-config-changed', {
    method: 'POST',
    headers: correlationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ agentReportModeChanged: true })
  });
}

export function scheduleAgentConfigChanged(env, ctx, serverId) {
  const promise = notifyAgentConfigChanged(env, serverId).catch(e => {
    logError('agent', 'agent.config.notify_failed', 'Agent configuration change notification failed', e, {}, 'warn');
    return null;
  });

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise);
  }

  return promise;
}

export function scheduleAgentReportModeChanged(env, ctx) {
  const promise = notifyAgentReportModeChanged(env).catch(e => {
    logError('agent', 'agent.mode.notify_failed', 'Agent reporting mode notification failed', e, {}, 'warn');
    return null;
  });

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise);
  }

  return promise;
}

export async function notifyFrontendAccessChanged(env) {
  if (!env?.METRICS_BROADCASTER) return;
  const stub = env.METRICS_BROADCASTER.get(env.METRICS_BROADCASTER.idFromName('global'));
  const response = await stub.fetch('http://internal/frontend-access-changed', { method: 'POST', headers: correlationHeaders() });
  if (!response.ok) throw new Error('Failed to refresh frontend permissions');
}
