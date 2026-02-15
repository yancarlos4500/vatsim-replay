export async function getMeta() {
  const r = await fetch("/api/meta");
  if (!r.ok) throw new Error("meta failed");
  return r.json();
}

export async function getSnapshot(ts) {
  const r = await fetch(`/api/snapshot?ts=${ts}`);
  if (!r.ok) throw new Error("snapshot failed");
  return r.json();
}

export async function getCallsigns(since, until) {
  const r = await fetch(`/api/callsigns?since=${since}&until=${until}&limit=2000`);
  if (!r.ok) throw new Error("callsigns failed");
  return r.json();
}

export async function getTrack(callsign, since, until, step = 15) {
  const r = await fetch(`/api/track/${encodeURIComponent(callsign)}?since=${since}&until=${until}&step=${step}`);
  if (!r.ok) throw new Error("track failed");
  return r.json();
}

export async function getAirspace() {
  const r = await fetch("/api/airspace");
  if (!r.ok) throw new Error("airspace failed");
  return r.json();
}

export async function getAtcOnline() {
  const r = await fetch("/api/atc-online");
  if (!r.ok) throw new Error("atc online failed");
  return r.json();
}

export async function getAtcSnapshot(ts) {
  const r = await fetch(`/api/atc-snapshot?ts=${ts}`);
  if (!r.ok) throw new Error("atc snapshot failed");
  return r.json();
}

export async function getTracon() {
  const r = await fetch("/api/tracon");
  if (!r.ok) throw new Error("tracon failed");
  return r.json();
}
