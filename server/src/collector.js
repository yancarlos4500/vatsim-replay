import fetch from "node-fetch";

const VATSIM_URL = "https://data.vatsim.net/v3/vatsim-data.json";
const VATSIM_FALLBACK_URLS = [
  VATSIM_URL,
  "https://data.vatsim.net/v3/vatsim-data-backup.json"
];
const FETCH_TIMEOUT_MS = 12000;
const FETCH_RETRIES = 2;
const RETRY_DELAY_MS = 750;
const STALE_CACHE_MAX_AGE_MS = 10 * 60 * 1000;

let lastGoodVatsimData = null;
let lastGoodVatsimDataAtMs = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "vatsim-traffic-replay/1.0 (+https://example.local)"
      },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`VATSIM fetch failed: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchVatsimData() {
  let lastError = null;

  for (const url of VATSIM_FALLBACK_URLS) {
    for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
      try {
        const data = await fetchJsonWithTimeout(url, FETCH_TIMEOUT_MS);
        lastGoodVatsimData = data;
        lastGoodVatsimDataAtMs = Date.now();
        return data;
      } catch (error) {
        lastError = error;
        if (attempt < FETCH_RETRIES) {
          await delay(RETRY_DELAY_MS * (attempt + 1));
        }
      }
    }
  }

  const cacheAgeMs = Date.now() - lastGoodVatsimDataAtMs;
  if (lastGoodVatsimData && cacheAgeMs <= STALE_CACHE_MAX_AGE_MS) {
    console.warn(`[collector] fetch failed; using cached VATSIM data (${Math.floor(cacheAgeMs / 1000)}s old): ${lastError?.message || lastError}`);
    return lastGoodVatsimData;
  }

  throw lastError;
}

export async function fetchPilots() {
  const data = await fetchVatsimData();
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
  const data = await fetchVatsimData();
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
