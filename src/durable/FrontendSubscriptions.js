import { loadSettingsScope } from '../utils/settings.js';
import { getWebSocketIdentity } from '../middleware/auth.js';
import { AppError } from '../utils/errors.js';
import { ensureServerSchema } from '../database/ServerRepository.js';

// The browser's subscription is a filter, never an authorization grant.
export class FrontendSubscriptions {
  constructor(env, storage) {
    this.env = env;
    this.storage = storage;
    this.sessions = new Map();
    this.policy = null;
    this.loading = null;
    this.revision = 0;
  }

  invalidate() {
    this.policy = null;
    this.revision++;
  }

  remember(sessionId, state) {
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, state);
    while (this.sessions.size > 256) this.sessions.delete(this.sessions.keys().next().value);
  }

  async save(ws, state) {
    const sessionId = ws.deserializeAttachment()?.sessionId || crypto.randomUUID();
    // Store large permission/subscription lists outside the size-limited WebSocket attachment.
    await this.storage.put(`cfsm:frontend-session:${sessionId}`, state);
    ws.serializeAttachment({ sessionId, scope: state.scope, kind: 'frontend' });
    this.remember(sessionId, state);
  }

  async load(ws) {
    const attachment = ws.deserializeAttachment();
    if (!attachment?.sessionId) return attachment;
    const cached = this.sessions.get(attachment.sessionId);
    if (cached) return cached;
    const state = await this.storage.get(`cfsm:frontend-session:${attachment.sessionId}`);
    if (state) this.remember(attachment.sessionId, state);
    return state;
  }

  async remove(ws) {
    const sessionId = ws.deserializeAttachment()?.sessionId;
    if (!sessionId) return;
    this.sessions.delete(sessionId);
    await this.storage.delete(`cfsm:frontend-session:${sessionId}`);
  }

  async cleanup(activeSockets) {
    if (!this.storage?.list) return false;
    const active = new Set(activeSockets.map(ws => ws.deserializeAttachment()?.sessionId));
    const cursorKey = 'cfsm:frontend-session-cursor';
    const startAfter = await this.storage.get(cursorKey);
    const entries = await this.storage.list({ prefix: 'cfsm:frontend-session:', limit: 64, ...(startAfter ? { startAfter } : {}) });
    for (const key of entries.keys()) {
      if (!active.has(key.slice('cfsm:frontend-session:'.length))) await this.storage.delete(key);
    }
    if (entries.size === 64) await this.storage.put(cursorKey, [...entries.keys()].at(-1));
    else await this.storage.delete(cursorKey);
    return entries.size === 64;
  }

  async loadPolicy() {
    if (this.policy && this.policy.expiresAt > Date.now()) return this.policy;
    if (this.loading) return this.loading;
    const revision = this.revision;
    this.loading = (async () => {
      const settings = await loadSettingsScope(this.env.DB, 'access', { forceRefresh: true });
      await ensureServerSchema(this.env.DB);
      const { results } = await this.env.DB.prepare('SELECT id, is_hidden FROM servers').all();
      return { settings, servers: results, expiresAt: Date.now() + 60_000, revision };
    })();
    try {
      const policy = await this.loading;
      if (revision !== this.revision) throw new AppError('Permissions changed; reconnect', 503);
      this.policy = policy;
      return policy;
    } finally {
      this.loading = null;
    }
  }

  async authorize(request) {
    const { settings, servers, expiresAt, revision } = await this.loadPolicy();
    const identity = await getWebSocketIdentity(request, this.env, settings);
    if (revision !== this.revision) throw new AppError('Permissions changed; reconnect', 503);
    if (settings.is_public !== 'true' && !identity.authenticated) {
      throw new AppError('Unauthorized', 401);
    }
    return {
      allowedServerIds: servers.filter(server => identity.authenticated || String(server.is_hidden) !== '1')
        .map(server => String(server.id)),
      authorizationExpiresAt: identity.expiresAt,
      authorizationToken: identity.token || '',
      accessValidUntil: expiresAt,
      accessVersion: 1
    };
  }

  async refresh(attachment) {
    const headers = attachment.authorizationToken ? { Authorization: `Bearer ${attachment.authorizationToken}` } : {};
    return { ...attachment, ...await this.authorize(new Request('https://internal/ws', { headers })) };
  }

  allowedIds(attachment) {
    if (attachment?.accessVersion !== 1 ||
      (attachment.accessValidUntil && Date.now() >= attachment.accessValidUntil) ||
      (attachment.authorizationExpiresAt && Date.now() >= attachment.authorizationExpiresAt)) return [];
    return Array.isArray(attachment.allowedServerIds) ? attachment.allowedServerIds : [];
  }

  canSubscribe(attachment, scope, ids = []) {
    const allowed = new Set(this.allowedIds(attachment));
    return scope === 'all' ? ids.every(id => allowed.has(id)) : allowed.has(scope);
  }
}
