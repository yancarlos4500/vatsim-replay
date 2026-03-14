export function fmt(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

export function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

export function toDateTimeLocalValue(ts) {
  if (!Number.isFinite(ts)) return "";
  const date = new Date(ts * 1000);
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate())
  ].join("-") + `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function fromDateTimeLocalValue(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  const tsMs = parsed.getTime();
  return Number.isFinite(tsMs) ? Math.floor(tsMs / 1000) : null;
}
