import { deflateSync, inflateSync } from 'node:zlib';
import { emptyBlock } from './metricAggregates.js';

export const METRIC_PART_MAX_BYTES = 1536 * 1024; // Leave headroom below SQLite's 2 MB row limit.
const RAW_PART_MAX_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(block, hour) {
  const keys = [...new Set([...Object.values(block.m), ...Object.values(block.f)].flatMap(state => Object.keys(state.a)))].sort();
  const indexes = new Map(keys.map((key, index) => [key, index]));
  const pack = (entries, includeSeen) => Object.entries(entries).sort((a, b) => Number(a[0]) - Number(b[0])).map(([bucket, state]) => {
    let previous = hour;
    const seen = includeSeen ? [...state.s].sort((a, b) => a - b).map(ts => { const delta = ts - previous; previous = ts; return delta; }) : [];
    return [Number(bucket), state.t - hour, state.n, seen, Object.entries(state.a).sort((a, b) => indexes.get(a[0]) - indexes.get(b[0]))
      .map(([key, cell]) => [indexes.get(key), cell[0], cell[1], cell[2], cell[3] - hour, cell[4]])];
  });
  const bytes = encoder.encode(JSON.stringify([2, keys, block.g, pack(block.m, true), pack(block.f, false), block.l, block.r]));
  return { rawBytes: bytes.byteLength, bytes: deflateSync(bytes, { level: 3 }) };
}

export function decodeMetricPart(blob, hour) {
  const [version, keys, profiles, minutes, fine, latest, reports] = JSON.parse(decoder.decode(inflateSync(new Uint8Array(blob), { maxOutputLength: RAW_PART_MAX_BYTES * 2 })));
  if (version !== 2) throw new Error(`Unsupported metric block version: ${version}`);
  const unpack = rows => Object.fromEntries(rows.map(([bucket, ts, count, deltas, cells]) => {
    let previous = hour;
    return [bucket, { t: hour + ts, n: count, s: deltas.map(delta => (previous += delta)),
      a: Object.fromEntries(cells.map(([index, sum, count, max, lastTs, last]) => [keys[index], [sum, count, max, hour + lastTs, last]])) }];
  }));
  return { m: unpack(minutes), f: unpack(fine), g: profiles, l: latest, r: reports };
}

export function encodeMetricParts(block, hour) {
  const whole = encode(block, hour);
  if (whole.bytes.byteLength <= METRIC_PART_MAX_BYTES && whole.rawBytes <= RAW_PART_MAX_BYTES) return new Map([[0, whole.bytes]]);
  const metadata = encode({ ...emptyBlock(), g: block.g, l: block.l, r: block.r }, hour);
  if (metadata.bytes.byteLength > METRIC_PART_MAX_BYTES || metadata.rawBytes > RAW_PART_MAX_BYTES) throw new Error('Metric report metadata exceeds storage block limit');
  const parts = new Map([[0, metadata.bytes]]);
  // Unusually large GPU payloads split by time; normal nodes use one hourly row.
  const split = (start, end) => {
    const within = entries => Object.fromEntries(Object.entries(entries).filter(([key]) => Number(key) >= start && Number(key) < end));
    const part = encode({ ...emptyBlock(), m: within(block.m), f: within(block.f) }, hour);
    if (part.bytes.byteLength <= METRIC_PART_MAX_BYTES && part.rawBytes <= RAW_PART_MAX_BYTES) { parts.set(start + 1, part.bytes); return; }
    if (end - start <= 10_000) throw new Error('Metric sample exceeds storage block limit');
    const middle = Math.ceil((start + end) / 20_000) * 10_000;
    split(start, middle);
    split(middle, end);
  };
  split(0, 3600_000);
  return parts;
}

export function equalMetricBytes(a, b) {
  if (!a || a.byteLength !== b.byteLength) return false;
  const left = new Uint8Array(a);
  return b.every((value, index) => value === left[index]);
}
