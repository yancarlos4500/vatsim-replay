export function fmt(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

export function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
