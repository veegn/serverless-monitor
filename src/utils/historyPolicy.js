// Shared by the API and charts. These are query resolutions, not Agent collection intervals.
export const HISTORY_RANGES = Object.freeze([
  { hours: 0.167, seconds: 600, interval: 10_000, label: '10m' },
  { hours: 0.5, seconds: 1800, interval: 20_000, label: '30m' },
  { hours: 1, seconds: 3600, interval: 30_000, label: '1h' },
  { hours: 6, seconds: 21600, interval: 180_000, label: '6h' },
  { hours: 12, seconds: 43200, interval: 300_000, label: '12h' },
  { hours: 24, seconds: 86400, interval: 600_000, label: '24h' },
  { hours: 48, seconds: 172800, interval: 1200_000, label: '2d' },
  { hours: 96, seconds: 345600, interval: 1800_000, label: '4d' },
  { hours: 168, seconds: 604800, interval: 3600_000, label: '7d' }
]);

export const LONG_HISTORY_POINT_OPTIONS = Object.freeze(['auto', 60, 120, 180, 240]);
export const DEFAULT_LONG_HISTORY_POINTS = 'auto';
export const HISTORY_FINE_INTERVAL_MS = 10_000;
export const HISTORY_BASE_INTERVAL_MS = 60_000;
export const HISTORY_FINE_RETENTION_MS = 3600_000;

export function historySampling(hours = 1, points = null) {
  const boundedHours = Math.max(1 / 60, Math.min(168, Number(hours) || 1));
  const range = HISTORY_RANGES.find(item => Math.abs(item.hours - boundedHours) < 0.0001);
  const durationMs = range ? range.seconds * 1000 : boundedHours * 3600_000;
  const base = durationMs <= HISTORY_FINE_RETENTION_MS ? HISTORY_FINE_INTERVAL_MS : HISTORY_BASE_INTERVAL_MS;
  const explicit = points !== null && points !== '' && Number.isFinite(Number(points)) && Number(points) > 0;
  const limit = explicit ? Math.max(1, Math.min(1000, Math.floor(Number(points)))) : null;
  const intervalMs = limit
    ? Math.max(base, Math.ceil(durationMs / limit / base) * base)
    : range?.interval || Math.max(base, Math.ceil(durationMs / 160 / base) * base);
  return { durationMs, intervalMs, points: Math.ceil(durationMs / intervalMs), sourceIntervalMs: base };
}
