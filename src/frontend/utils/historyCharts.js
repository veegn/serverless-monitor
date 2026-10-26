// Report-level metrics (GPU, disk, probes) are sparser than CPU/RAM samples.
// Omit absent observations; preserve explicit nulls as real breaks in the curve.
export function historySeries(rows, accessor) {
  return rows.flatMap(row => {
    const y = accessor(row);
    if (y === undefined) return [];
    const point = { x: Number(row.timestamp), y };
    if (row.peaks) point.peak = accessor({ ...row, ...row.peaks });
    if (row.averages) point.average = accessor({ ...row, ...row.averages });
    return [point];
  }).sort((a, b) => a.x - b.x);
}
