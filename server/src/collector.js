import fetch from "node-fetch";

const VATSIM_URL = "https://data.vatsim.net/v3/vatsim-data.json";
const FETCH_TIMEOUT_MS = 12000;
const FETCH_RETRIES = 2;
const RETRY_DELAY_MS = 750;
const STALE_CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

const EMPTY_VATSIM_DATA = {
  pilots: [],
  controllers: []
};

let lastGoodVatsimData = null;
let lastGoodVatsimDataAtMs = 0;
let lastFetchFailedAtMs = 0;
let consecutiveFailures = 0;
let inFlightVatsimFetchPromise = null;
const CIRCUIT_BREAKER_THRESHOLD = 2; // Open after 2 consecutive failures
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

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
  const now = Date.now();
  const timeSinceLastFailure = now - lastFetchFailedAtMs;
  const circuitBreakerOpen = consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && timeSinceLastFailure < CIRCUIT_BREAKER_COOLDOWN_MS;

  if (circuitBreakerOpen) {
    const cacheAgeMs = now - lastGoodVatsimDataAtMs;
    if (lastGoodVatsimData) {
      const cacheAgeSeconds = Math.floor(cacheAgeMs / 1000);
      if (cacheAgeMs <= STALE_CACHE_MAX_AGE_MS) {
        console.warn(`[collector] circuit breaker open; using cached VATSIM data (${cacheAgeSeconds}s old)`);
      } else {
        console.warn(`[collector] circuit breaker open; using stale cached VATSIM data (${cacheAgeSeconds}s old)`);
      }
      return lastGoodVatsimData;
    }
  }

  let lastError = null;

  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
    try {
      const data = await fetchJsonWithTimeout(VATSIM_URL, FETCH_TIMEOUT_MS);
      lastGoodVatsimData = data;
      lastGoodVatsimDataAtMs = Date.now();
      consecutiveFailures = 0;
      return data;
    } catch (error) {
      lastError = error;
      consecutiveFailures += 1;
      lastFetchFailedAtMs = Date.now();
      if (attempt < FETCH_RETRIES) {
        await delay(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  const cacheAgeMs = now - lastGoodVatsimDataAtMs;
  if (lastGoodVatsimData) {
    const cacheAgeSeconds = Math.floor(cacheAgeMs / 1000);
    if (cacheAgeMs <= STALE_CACHE_MAX_AGE_MS) {
      console.warn(`[collector] fetch failed; using cached VATSIM data (${cacheAgeSeconds}s old): ${lastError?.message || lastError}`);
    } else {
      console.warn(`[collector] fetch failed; using stale cached VATSIM data (${cacheAgeSeconds}s old): ${lastError?.message || lastError}`);
    }
    return lastGoodVatsimData;
  }

  console.error(`[collector] exhausted retries with no cache; using empty VATSIM data: ${lastError?.message || lastError}`);
  return EMPTY_VATSIM_DATA;
}

async function fetchVatsimDataShared() {
  if (!inFlightVatsimFetchPromise) {
    inFlightVatsimFetchPromise = fetchVatsimData().finally(() => {
      inFlightVatsimFetchPromise = null;
    });
  }
  return inFlightVatsimFetchPromise;
}

export async function fetchPilots() {
  const data = await fetchVatsimDataShared();
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
  const data = await fetchVatsimDataShared();
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
