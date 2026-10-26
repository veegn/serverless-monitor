import { LATEST_REPORT_CACHE_MAX_SERVERS } from './config.js';

// Bound retained payloads as well as node count; a large batch must not grow the isolate indefinitely.
export class ReportReplayCache extends Map {
  constructor({ maxServers = LATEST_REPORT_CACHE_MAX_SERVERS, maxBytes = 8 * 1024 * 1024 } = {}) {
    super();
    this.maxServers = maxServers;
    this.maxBytes = maxBytes;
    this.estimatedBytes = 0;
    this.entryBytes = new Map();
  }

  set(key, value) {
    const bytes = JSON.stringify(value.samples || []).length * 2;
    this.delete(key);
    super.set(key, value);
    this.entryBytes.set(key, bytes);
    this.estimatedBytes += bytes;
    while (this.size > this.maxServers || this.estimatedBytes > this.maxBytes) this.delete(this.keys().next().value);
    return this;
  }

  delete(key) {
    this.estimatedBytes -= this.entryBytes.get(key) || 0;
    this.entryBytes.delete(key);
    return super.delete(key);
  }

  clear() {
    super.clear();
    this.entryBytes.clear();
    this.estimatedBytes = 0;
  }
}
