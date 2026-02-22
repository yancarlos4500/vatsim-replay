export async function getMeta() {
  const r = await fetch("/api/meta");
  if (!r.ok) throw new Error("meta failed");
  return r.json();
}

export async function getSnapshot(ts, airspaces = "", airports = "", minAltitude = null, maxAltitude = null) {
  const params = new URLSearchParams({ ts: String(ts) });
  if (airspaces) params.set("airspaces", airspaces);
  if (airports) params.set("airports", airports);
  if (minAltitude !== null && minAltitude >= 0) params.set("minAltitude", String(minAltitude));
  if (maxAltitude !== null && maxAltitude >= 0) params.set("maxAltitude", String(maxAltitude));
  const r = await fetch(`/api/snapshot?${params.toString()}`);
  if (!r.ok) throw new Error("snapshot failed");
  return r.json();
}

export async function getCallsigns(since, until, airspaces = "", airports = "", minAltitude = null, maxAltitude = null) {
  const params = new URLSearchParams({ since: String(since), until: String(until), limit: "2000" });
  if (airspaces) params.set("airspaces", airspaces);
  if (airports) params.set("airports", airports);
  if (minAltitude !== null && minAltitude >= 0) params.set("minAltitude", String(minAltitude));
  if (maxAltitude !== null && maxAltitude >= 0) params.set("maxAltitude", String(maxAltitude));
  const r = await fetch(`/api/callsigns?${params.toString()}`);
  if (!r.ok) throw new Error("callsigns failed");
  return r.json();
}

export async function getTrack(callsign, since, until, step = 15, airspaces = "", airports = "", minAltitude = null, maxAltitude = null) {
  const params = new URLSearchParams({ since: String(since), until: String(until), step: String(step) });
  if (airspaces) params.set("airspaces", airspaces);
  if (airports) params.set("airports", airports);
  if (minAltitude !== null && minAltitude >= 0) params.set("minAltitude", String(minAltitude));
  if (maxAltitude !== null && maxAltitude >= 0) params.set("maxAltitude", String(maxAltitude));
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
  // Check browser cache first
  const cached = localStorage.getItem("airspace_cache");
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      // Invalid cache, continue to fetch
    }
  }

  const r = await fetch("/api/airspace");
  if (!r.ok) throw new Error("airspace failed");
  const data = await r.json();
  
  // Cache for 24 hours
  try {
    localStorage.setItem("airspace_cache", JSON.stringify(data));
  } catch (e) {
    // Storage full or not available, continue without caching
  }
  
  return data;
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
  // Check browser cache first
  const cached = localStorage.getItem("tracon_cache");
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      // Invalid cache, continue to fetch
    }
  }

  const r = await fetch("/api/tracon");
  if (!r.ok) throw new Error("tracon failed");
  const data = await r.json();
  
  // Cache for 24 hours
  try {
    localStorage.setItem("tracon_cache", JSON.stringify(data));
  } catch (e) {
    // Storage full or not available, continue without caching
  }
  
  return data;
}
