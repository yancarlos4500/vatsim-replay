export async function getMeta() {
  const r = await fetch("/api/meta");
  if (!r.ok) throw new Error("meta failed");
  return r.json();
}

export async function getSnapshot(ts, airspace = "", airports = "") {
  const params = new URLSearchParams({ ts: String(ts) });
  if (airspace) params.set("airspace", airspace);
  if (airports) params.set("airports", airports);
  const r = await fetch(`/api/snapshot?${params.toString()}`);
  if (!r.ok) throw new Error("snapshot failed");
  return r.json();
}

export async function getCallsigns(since, until, airspace = "", airports = "") {
  const params = new URLSearchParams({ since: String(since), until: String(until), limit: "2000" });
  if (airspace) params.set("airspace", airspace);
  if (airports) params.set("airports", airports);
  const r = await fetch(`/api/callsigns?${params.toString()}`);
  if (!r.ok) throw new Error("callsigns failed");
  return r.json();
}

export async function getTrack(callsign, since, until, step = 15, airspace = "", airports = "") {
  const params = new URLSearchParams({ since: String(since), until: String(until), step: String(step) });
  if (airspace) params.set("airspace", airspace);
  if (airports) params.set("airports", airports);
  const r = await fetch(`/api/track/${encodeURIComponent(callsign)}?${params.toString()}`);
  if (!r.ok) throw new Error("track failed");
  return r.json();
}

export async function getAirspaces(since, until) {
  const r = await fetch(`/api/airspaces?since=${since}&until=${until}&limit=2000`);
  if (!r.ok) throw new Error("airspaces failed");
  return r.json();
}

export async function getAirports(since, until) {
  const r = await fetch(`/api/airports?since=${since}&until=${until}&limit=3000`);
  if (!r.ok) throw new Error("airports failed");
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
