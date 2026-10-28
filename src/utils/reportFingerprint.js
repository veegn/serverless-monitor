function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
  }
  return value;
}

// Hash the wire report before adding receipt timestamps, inferred IPs or defaults.
// The same report must keep its identity across retries, transports and restarts.
export async function reportFingerprint(report) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonicalValue(report))));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
