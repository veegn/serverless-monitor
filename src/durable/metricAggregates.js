import { NUMERIC_METRIC_FIELDS, PROBE_METRIC_FIELDS, HISTORY_AGGREGATION_MAX_FIELDS } from '../utils/historyFields.js';
import { DISK_IO_FIELD_TO_COLUMN } from '../utils/metrics.js';

const FIELDS = new Set([...NUMERIC_METRIC_FIELDS, ...PROBE_METRIC_FIELDS]);
const MAX_FIELDS = new Set(HISTORY_AGGREGATION_MAX_FIELDS);
const LAST_FIELDS = new Set(['ram_total', 'swap_total', 'disk_total', 'cpu_cores',
  'net_rx', 'net_tx', 'net_rx_monthly', 'net_tx_monthly']);
const isLastField = field => LAST_FIELDS.has(field) || (field.startsWith('gpu:') && /"(?:mem_total|power_limit)"\]$/.test(field));
const GPU_FIELDS = ['info', 'mem_used', 'mem_total', 'sm_clock', 'mem_clock', 'temp', 'temperature', 'power', 'power_limit', 'fan'];
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const disabled = value => value === false || value === 'false';
const number = value => value === null || value === undefined || value === '' || disabled(value)
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export function emptyAggregate() { return { t: 0, n: 0, a: {}, s: [] }; }
export function emptyBlock() { return { m: {}, f: {}, g: {}, l: null, r: [] }; }

export function metricPrecision(field) {
  if (field.startsWith('ping_')) return 0;
  if (field.startsWith('loss_') || field === 'cpu' || field === 'disk_util' || field === 'disk_await_ms' || field.endsWith('_iops') || field.endsWith('_percent')) return 1;
  if (field.startsWith('load_') || /^(ram|swap|disk)_(used|total)$/.test(field)) return 2;
  if (field.startsWith('gpu:')) {
    const property = JSON.parse(field.slice(4))[1];
    return property.startsWith('mem_') && property !== 'mem_clock' ? 2 : property.endsWith('_clock') ? 0 : 1;
  }
  return 0;
}

function rounded(value, field) {
  const factor = 10 ** metricPrecision(field);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function metricValues(data, profiles) {
  const values = {};
  for (const field of FIELDS) if (own(data, field)) values[field] = data[field];
  for (const [field, column] of Object.entries(DISK_IO_FIELD_TO_COLUMN)) {
    if (data.disk && own(data.disk, field)) values[column] = data.disk[field];
  }
  for (const name of ['ram', 'swap', 'disk']) {
    const total = number(data[`${name}_total`]);
    const used = number(data[`${name}_used`]);
    if (total > 0 && used !== null) values[`${name}_percent`] = used / total * 100;
  }
  const load = data.load_avg ?? data.load;
  if (load !== undefined && load !== null) {
    const parts = Array.isArray(load) ? load : String(load).trim().split(/[\s,]+/);
    for (let i = 0; i < 3; i++) if (number(parts[i]) !== null) values[`load_${i}`] = Number(parts[i]);
  }
  let gpus = data.gpu_info;
  if (typeof gpus === 'string') { try { gpus = JSON.parse(gpus); } catch { gpus = []; } }
  for (const [index, gpu] of (Array.isArray(gpus) ? gpus : []).entries()) {
    if (!gpu || typeof gpu !== 'object') continue;
    const id = String(gpu.id ?? index);
    profiles[JSON.stringify(id)] = { id, ...(gpu.name !== undefined ? { name: String(gpu.name) } : {}) };
    for (const field of GPU_FIELDS) {
      if (own(gpu, field)) values[`gpu:${JSON.stringify([id, field])}`] = gpu[field];
    }
  }
  return values;
}

// A cell is [sum, count, max, last timestamp, last value], using scaled integers.
// Quantize each input once, then keep exact sums/counts until the final query.
export function addValues(state, ts, values) {
  state.t = Math.max(state.t, ts);
  state.n++;
  for (const [field, raw] of Object.entries(values)) {
    const rawValue = number(raw);
    const value = rawValue === null ? null : Math.round(rawValue * 10 ** metricPrecision(field));
    const last = disabled(raw) ? false : value;
    const cell = state.a[field] ||= [0, 0, null, 0, null];
    if (isLastField(field)) {
      if (ts >= cell[3]) { cell[0] = value ?? 0; cell[1] = value === null ? 0 : 1; cell[2] = value; cell[3] = ts; cell[4] = last; }
      continue;
    }
    if (value !== null) {
      cell[0] += value;
      cell[1]++;
      cell[2] = cell[2] === null ? value : Math.max(cell[2], value);
    }
    if (ts >= cell[3]) { cell[3] = ts; cell[4] = last; }
  }
}

export function mergeAggregate(target, source) {
  target.t = Math.max(target.t, source.t);
  target.n += source.n;
  for (const [field, cell] of Object.entries(source.a)) {
    const previous = target.a[field];
    if (!previous) { target.a[field] = [...cell]; continue; }
    if (isLastField(field)) {
      if (cell[3] >= previous[3]) target.a[field] = [...cell];
      continue;
    }
    previous[0] += cell[0];
    previous[1] += cell[1];
    if (cell[2] !== null) previous[2] = previous[2] === null ? cell[2] : Math.max(previous[2], cell[2]);
    if (cell[3] >= previous[3]) { previous[3] = cell[3]; previous[4] = cell[4]; }
  }
  return target;
}

function setValue(result, field, value, profiles) {
  if (field.startsWith('load_')) {
    result.load_avg ||= [null, null, null];
    result.load_avg[Number(field.slice(5))] = value;
  } else if (field.startsWith('gpu:')) {
    const [id, property] = JSON.parse(field.slice(4));
    result.gpu_info ||= {};
    const key = JSON.stringify(id);
    result.gpu_info[key] ||= { ...(profiles[key] || { id }) };
    result.gpu_info[key][property] = value;
  } else result[field] = value;
}

function finishShape(result) {
  if (result.load_avg) result.load_avg = result.load_avg.map(value => value ?? 0).join(' ');
  if (result.gpu_info) result.gpu_info = Object.values(result.gpu_info);
  for (const [field, column] of Object.entries(DISK_IO_FIELD_TO_COLUMN)) {
    if (own(result, column)) { result.disk ||= {}; result.disk[field] = result[column]; }
  }
  return result;
}

export function materializeAggregate(state, profiles = {}) {
  const data = { timestamp: state.t };
  const peaks = {};
  const averages = {};
  for (const [field, cell] of Object.entries(state.a)) {
    const [sum, count, max, , last] = cell;
    const isLast = isLastField(field);
    const factor = 10 ** metricPrecision(field);
    const avg = count ? rounded(sum / count / factor, field) : null;
    const peak = max === null ? null : rounded(max / factor, field);
    // Explicit disabled/timeout markers survive aggregation. Missing fields do not
    // turn into zero, and counters/capacities remain last-known values.
    const value = last === false || last === null ? last
      : isLast ? rounded(last / factor, field) : MAX_FIELDS.has(field) ? peak : avg;
    setValue(data, field, value, profiles);
    if (!isLast && count) {
      setValue(peaks, field, peak, profiles);
      if (MAX_FIELDS.has(field)) setValue(averages, field, avg, profiles);
    }
  }
  data.peaks = finishShape(peaks);
  if (Object.keys(averages).length) data.averages = finishShape(averages);
  return finishShape(data);
}

export function legacyAggregate(legacy) {
  const state = emptyAggregate();
  const data = legacy.data || {};
  const profiles = {};
  addValues(state, Number(legacy.timestamp), metricValues(data, profiles));
  for (const [field, value] of Object.entries(legacy.max || {})) {
    const scaled = Math.round(value * 10 ** metricPrecision(field));
    const cell = state.a[field] ||= [scaled, 1, scaled, state.t, scaled];
    cell[2] = scaled;
  }
  for (const [field, value] of Object.entries(legacy.avg || {})) {
    const cell = state.a[field] ||= [0, 0, null, state.t, null];
    cell[0] = Math.round(value.sum * 10 ** metricPrecision(field));
    cell[1] = value.count;
    cell[2] = value.count ? Math.round(cell[0] / value.count) : null;
    if (cell[4] !== false && cell[4] !== null) cell[4] = cell[2];
  }
  state.s = [...(legacy.seen || [legacy.timestamp])];
  state.n = state.s.length;
  return { state, profiles };
}
