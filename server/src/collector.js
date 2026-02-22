import fetch from "node-fetch";

const VATSIM_URL = "https://data.vatsim.net/v3/vatsim-data.json";

export async function fetchPilots() {
  const res = await fetch(VATSIM_URL, {
    headers: {
      "User-Agent": "vatsim-traffic-replay/1.0 (+https://example.local)"
    }
  });
  if (!res.ok) {
    throw new Error(`VATSIM fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  // VATSIM v3: pilots under data.pilots
  const pilots = Array.isArray(data?.pilots) ? data.pilots : [];
  // Normalize just what we store
  return pilots
    .filter(p => typeof p.callsign === "string" && typeof p.latitude === "number" && typeof p.longitude === "number")
    .map(p => ({
      callsign: p.callsign,
      cid: p.cid,
      latitude: p.latitude,
      longitude: p.longitude,
      altitude: p.altitude,
      groundspeed: p.groundspeed,
      heading: p.heading,
      departure: p.flight_plan?.departure,
      destination: p.flight_plan?.arrival
    }));
}

export async function fetchAtcPositions() {
  const res = await fetch(VATSIM_URL, {
    headers: {
      "User-Agent": "vatsim-traffic-replay/1.0 (+https://example.local)"
    }
  });
  if (!res.ok) {
    throw new Error(`VATSIM fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  // VATSIM v3: controllers under data.controllers
  const controllers = Array.isArray(data?.controllers) ? data.controllers : [];
  // Normalize: extract callsign and facility (ATC position/sector)
  return controllers
    .filter(c => typeof c.callsign === "string")
    .map(c => ({
      callsign: c.callsign,
      cid: c.cid,
      frequency: c.frequency,
      facility: c.facility,
      latitude: c.latitude,
      longitude: c.longitude
    }));
}
