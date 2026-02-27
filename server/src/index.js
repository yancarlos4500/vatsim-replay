import compression from "compression";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fetch from "node-fetch";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AirspaceMatcher } from "./airspaceMatcher.js";
import { fetchAtcPositions, fetchPilots } from "./collector.js";
import { getAirportsInRange, getAirspacesInRange, getAtcSnapshotAt, getAtcSnapshotsAtTimestamps, getCallsingsInRange, getRangeMeta, getSnapshotAt, getSnapshotTimestampsInRange, getSnapshotsAtTimestamps, getStoredEvents, getTrack, insertAtcSnapshots, insertSnapshots, openDb, pruneOld, pruneOldAtc, upsertEvents } from "./db.js";

// Define __dirname for ES modules
const __dirname = fileURLToPath(new URL(".", import.meta.url));

dotenv.config();

const PORT = parseInt(process.env.PORT || "4000", 10);
const POLL_INTERVAL_SECONDS = parseInt(process.env.POLL_INTERVAL_SECONDS || "15", 10);
const RETENTION_HOURS = parseInt(process.env.RETENTION_HOURS || "720", 10);
const MAX_REPLAY_RANGE_SECONDS = 24 * 3600;
const EVENTS_LATEST_NUM = parseInt(process.env.EVENTS_LATEST_NUM || "150", 10);
const EVENT_POLL_INTERVAL_SECONDS = parseInt(process.env.EVENT_POLL_INTERVAL_SECONDS || "3600", 10);
const EVENTS_API_BASE = process.env.EVENTS_API_BASE || "https://my.vatsim.net/api/v2/events/latest";
function resolveDbPath() {
  if (process.env.DB_PATH && process.env.DB_PATH.trim().length > 0) {
    const configured = process.env.DB_PATH.trim();
    return isAbsolute(configured) ? configured : resolve(join(__dirname, ".."), configured);
  }

  const railwayMountedPath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (railwayMountedPath && railwayMountedPath.trim().length > 0) {
    return join(railwayMountedPath.trim(), "vatsim.sqlite");
  }

  if (existsSync("/data")) {
    return "/data/vatsim.sqlite";
  }

  return resolve(join(__dirname, "../data/vatsim.sqlite"));
}

const DB_PATH = resolveDbPath();

const app = express();
app.use(compression());
app.use(cors());
app.use(express.json());

const db = openDb(DB_PATH);
const airspaceMatcher = new AirspaceMatcher();
console.log(`[init] sqlite db path: ${DB_PATH}`);

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function parseAirportList(rawValue) {
  if (typeof rawValue !== "string") return [];
  return Array.from(new Set(
    rawValue
      .split(/[\s,;]+/)
      .map((x) => x.trim().toUpperCase())
      .filter((x) => x.length > 0)
  ));
}

function validateReplayRange(since, until) {
  if (until < since) {
    return { ok: false, error: "until must be >= since", since, until };
  }

  const replayRangeSeconds = until - since;
  if (replayRangeSeconds > MAX_REPLAY_RANGE_SECONDS) {
    return {
      ok: false,
      error: "replay range exceeds 24 hours",
      maxRangeSeconds: MAX_REPLAY_RANGE_SECONDS,
      replayRangeSeconds,
      since,
      until
    };
  }

  return { ok: true };
}

async function pollOnce() {
  const ts = nowTs();
  const pilots = await fetchPilots();
  let pilotsWithAirspace = pilots;
  try {
    await airspaceMatcher.ensureFresh();
    pilotsWithAirspace = pilots.map((p) => ({
      ...p,
      airspace: airspaceMatcher.lookup(p.latitude, p.longitude)
    }));
  } catch (e) {
    console.warn(`[collector] airspace matcher unavailable: ${e?.message || e}`);
  }

  const atc = await fetchAtcPositions();
  const count = insertSnapshots(db, ts, pilotsWithAirspace);
  const atcCount = insertAtcSnapshots(db, ts, atc);
  const cutoff = ts - RETENTION_HOURS * 3600;
  const pruned = pruneOld(db, cutoff);
  const atcPruned = pruneOldAtc(db, cutoff);
  console.log(`[collector] ts=${ts} pilots=${pilots.length} inserted=${count} atc=${atc.length} atc-inserted=${atcCount} pruned=${pruned} atc-pruned=${atcPruned}`);
}

let pollTimer = null;
let pollInProgress = false;
let lastEventsSyncTs = 0;

async function syncEventsOnce(force = false) {
  const ts = nowTs();
  if (!force && ts - lastEventsSyncTs < EVENT_POLL_INTERVAL_SECONDS) {
    return 0;
  }

  const safeNum = Number.isFinite(EVENTS_LATEST_NUM) ? Math.max(1, Math.min(500, EVENTS_LATEST_NUM)) : 150;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const url = `${EVENTS_API_BASE}/${safeNum}`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "vatsim-traffic-replay/1.0 (+https://example.local)" }
    });

    if (!response.ok) {
      throw new Error(`events api ${response.status}`);
    }

    const body = await response.json();
    const items = Array.isArray(body?.data) ? body.data : [];
    const changes = upsertEvents(db, items, ts);
    lastEventsSyncTs = ts;
    console.log(`[events] fetched=${items.length} upserted=${changes} latestNum=${safeNum}`);
    return items.length;
  } finally {
    clearTimeout(timeout);
  }
}

async function warmupGeoJsonCaches() {
  // Pre-warm airspace cache in background
  try {
    const controllerA = new AbortController();
    const timerA = setTimeout(() => controllerA.abort(), 5000);
    const rA = await fetch(AIRSPACE_URLS[0], {
      headers: { "User-Agent": "vatsim-traffic-replay/1.0 (+https://example.local)" },
      signal: controllerA.signal
    });
    clearTimeout(timerA);
    if (rA.ok) {
      const data = await rA.json();
      airspaceCache = { ts: Date.now(), data };
      console.log("[init] airspace cache warmed");
    }
  } catch (e) {
    console.warn("[init] airspace cache warmup failed (non-critical):", e?.message || e);
  }
}

async function startCollector() {
  // Warm up GeoJSON caches in background
  warmupGeoJsonCaches();

  const runPollCycle = async () => {
    if (pollInProgress) {
      pollTimer = setTimeout(runPollCycle, POLL_INTERVAL_SECONDS * 1000);
      return;
    }

    pollInProgress = true;
    try {
      await pollOnce();
      syncEventsOnce(false).catch((e) => {
        console.warn("[events] periodic sync failed:", e?.message || e);
      });
    } catch (e) {
      if (e?.type !== "aborted") {
        console.error("[collector] poll failed:", e?.message || e);
      }
    } finally {
      pollInProgress = false;
      pollTimer = setTimeout(runPollCycle, POLL_INTERVAL_SECONDS * 1000);
    }
  };

  runPollCycle();
}

app.get("/api/meta", (req, res) => {
  const meta = getRangeMeta(db);
  res.json({
    ...meta,
    retentionHours: RETENTION_HOURS,
    pollIntervalSeconds: POLL_INTERVAL_SECONDS,
    nowTs: nowTs()
  });
});

app.get("/api/events", async (req, res) => {
  try {
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    if (refresh) {
      await syncEventsOnce(true);
    }

    const from = typeof req.query.from === "string" ? req.query.from : null;
    const to = typeof req.query.to === "string" ? req.query.to : null;
    const limit = parseInt(req.query.limit || "500", 10);
    const includeWithoutData = req.query.includeWithoutData === "1" || req.query.includeWithoutData === "true";
    const rows = getStoredEvents(db, from, to, limit, !includeWithoutData);
    res.json({ from, to, limit, includeWithoutData, rows });
  } catch (e) {
    res.status(500).json({ error: "events query failed", message: String(e?.message || e) });
  }
});

app.get("/api/callsigns", (req, res) => {
  const now = nowTs();
  const since = parseInt(req.query.since || (now - 3600).toString(), 10);
  const until = parseInt(req.query.until || now.toString(), 10);
  const validation = validateReplayRange(since, until);
  if (!validation.ok) {
    return res.status(400).json(validation);
  }
  const limit = parseInt(req.query.limit || "2000", 10);
  const airspaces = parseAirportList(
    typeof req.query.airspaces === "string"
      ? req.query.airspaces
      : (typeof req.query.airspace === "string" ? req.query.airspace : "")
  );
  const airports = parseAirportList(
    typeof req.query.airports === "string"
      ? req.query.airports
      : (typeof req.query.airport === "string" ? req.query.airport : "")
  );
  const minAltitude = req.query.minAltitude ? parseInt(req.query.minAltitude, 10) : null;
  const maxAltitude = req.query.maxAltitude ? parseInt(req.query.maxAltitude, 10) : null;
  const rows = getCallsingsInRange(db, since, until, limit, airspaces, airports, minAltitude, maxAltitude);
  res.json({ since, until, airspaces, airports, minAltitude, maxAltitude, rows });
});

app.get("/api/track/:callsign", (req, res) => {
  const now = nowTs();
  const callsign = req.params.callsign.toUpperCase();
  const since = parseInt(req.query.since || (now - 3600).toString(), 10);
  const until = parseInt(req.query.until || now.toString(), 10);
  const validation = validateReplayRange(since, until);
  if (!validation.ok) {
    return res.status(400).json(validation);
  }
  const step = parseInt(req.query.step || "0", 10);
  const airspaces = parseAirportList(
    typeof req.query.airspaces === "string"
      ? req.query.airspaces
      : (typeof req.query.airspace === "string" ? req.query.airspace : "")
  );
  const airports = parseAirportList(
    typeof req.query.airports === "string"
      ? req.query.airports
      : (typeof req.query.airport === "string" ? req.query.airport : "")
  );
  const minAltitude = req.query.minAltitude ? parseInt(req.query.minAltitude, 10) : null;
  const maxAltitude = req.query.maxAltitude ? parseInt(req.query.maxAltitude, 10) : null;
  const rows = getTrack(db, callsign, since, until, step, airspaces, airports, minAltitude, maxAltitude);
  res.json({ callsign, since, until, step, airspaces, airports, minAltitude, maxAltitude, rows });
});

app.get("/api/snapshot", (req, res) => {
  const now = nowTs();
  const ts = parseInt(req.query.ts || now.toString(), 10);
  const window = parseInt(req.query.window || Math.max(5, Math.floor(POLL_INTERVAL_SECONDS / 2)).toString(), 10);
  const airspaces = parseAirportList(
    typeof req.query.airspaces === "string"
      ? req.query.airspaces
      : (typeof req.query.airspace === "string" ? req.query.airspace : "")
  );
  const airports = parseAirportList(
    typeof req.query.airports === "string"
      ? req.query.airports
      : (typeof req.query.airport === "string" ? req.query.airport : "")
  );
  const minAltitude = req.query.minAltitude ? parseInt(req.query.minAltitude, 10) : null;
  const maxAltitude = req.query.maxAltitude ? parseInt(req.query.maxAltitude, 10) : null;
  const rows = getSnapshotAt(db, ts, window, airspaces, airports, minAltitude, maxAltitude);
  res.json({ ts, window, airspaces, airports, minAltitude, maxAltitude, rows });
});

app.get("/api/airspaces", (req, res) => {
  const now = nowTs();
  const since = parseInt(req.query.since || (now - 3600).toString(), 10);
  const until = parseInt(req.query.until || now.toString(), 10);
  const validation = validateReplayRange(since, until);
  if (!validation.ok) {
    return res.status(400).json(validation);
  }
  const limit = parseInt(req.query.limit || "2000", 10);
  
  const cached = getCached("airspaces", since, until, limit);
  if (cached) {
    return res.set("Cache-Control", "public, max-age=5").json({ since, until, rows: cached });
  }
  
  const rows = getAirspacesInRange(db, since, until, limit);
  setCached("airspaces", since, until, limit, rows);
  res.set("Cache-Control", "public, max-age=5");
  res.json({ since, until, rows });
});

app.get("/api/airports", (req, res) => {
  const now = nowTs();
  const since = parseInt(req.query.since || (now - 3600).toString(), 10);
  const until = parseInt(req.query.until || now.toString(), 10);
  const validation = validateReplayRange(since, until);
  if (!validation.ok) {
    return res.status(400).json(validation);
  }
  const limit = parseInt(req.query.limit || "3000", 10);
  
  const cached = getCached("airports", since, until, limit);
  if (cached) {
    return res.set("Cache-Control", "public, max-age=5").json({ since, until, rows: cached });
  }
  
  const rows = getAirportsInRange(db, since, until, limit);
  setCached("airports", since, until, limit, rows);
  res.set("Cache-Control", "public, max-age=5");
  res.json({ since, until, rows });
});

app.get("/api/atc-snapshot", (req, res) => {
  const now = nowTs();
  const ts = parseInt(req.query.ts || now.toString(), 10);
  const window = parseInt(req.query.window || Math.max(5, Math.floor(POLL_INTERVAL_SECONDS / 2)).toString(), 10);
  const rows = getAtcSnapshotAt(db, ts, window);
  res.json({ ts, window, rows });
});

app.get("/api/preload-snapshots", (req, res) => {
  const now = nowTs();
  const since = parseInt(req.query.since || (now - 3600).toString(), 10);
  const until = parseInt(req.query.until || now.toString(), 10);
  const step = parseInt(req.query.step || POLL_INTERVAL_SECONDS.toString(), 10);
  const window = parseInt(req.query.window || Math.max(5, Math.floor(POLL_INTERVAL_SECONDS / 2)).toString(), 10);
  const maxSourceAge = parseInt(
    req.query.maxSourceAge || Math.max(window, step * 2, POLL_INTERVAL_SECONDS * 2).toString(),
    10
  );
  const airspaces = parseAirportList(
    typeof req.query.airspaces === "string"
      ? req.query.airspaces
      : (typeof req.query.airspace === "string" ? req.query.airspace : "")
  );
  const airports = parseAirportList(
    typeof req.query.airports === "string"
      ? req.query.airports
      : (typeof req.query.airport === "string" ? req.query.airport : "")
  );
  const minAltitude = req.query.minAltitude ? parseInt(req.query.minAltitude, 10) : null;
  const maxAltitude = req.query.maxAltitude ? parseInt(req.query.maxAltitude, 10) : null;

  // Detailed validation with specific error messages
  if (!Number.isFinite(since)) {
    return res.status(400).json({ error: "invalid 'since' parameter", received: req.query.since, parsed: since });
  }
  if (!Number.isFinite(until)) {
    return res.status(400).json({ error: "invalid 'until' parameter", received: req.query.until, parsed: until });
  }
  if (!Number.isFinite(step)) {
    return res.status(400).json({ error: "invalid 'step' parameter", received: req.query.step, parsed: step });
  }
  if (step <= 0) {
    return res.status(400).json({ error: "step must be positive", received: step });
  }
  if (!Number.isFinite(maxSourceAge) || maxSourceAge <= 0) {
    return res.status(400).json({ error: "maxSourceAge must be positive", received: req.query.maxSourceAge, parsed: maxSourceAge });
  }
  if (until < since) {
    return res.status(400).json({ error: "until must be >= since", since, until });
  }

  const replayRangeSeconds = until - since;
  if (replayRangeSeconds > MAX_REPLAY_RANGE_SECONDS) {
    return res.status(400).json({
      error: "replay range exceeds 24 hours",
      maxRangeSeconds: MAX_REPLAY_RANGE_SECONDS,
      replayRangeSeconds,
      since,
      until
    });
  }

  const bucketCount = Math.floor((until - since) / step) + 1;
  const MAX_BUCKETS = 10000; // Allow up to ~24 hours at 15s step
  if (bucketCount > MAX_BUCKETS) {
    return res.status(400).json({
      error: "range too large",
      maxBuckets: MAX_BUCKETS,
      requestedBuckets: bucketCount
    });
  }

  const from = since - window;
  const to = until + window;
  const availableTs = getSnapshotTimestampsInRange(db, from, to);

  const timestamps = [];
  const rowsByTs = {};
  const atcRowsByTs = {};
  const sourceTsByBucket = {};
  for (let ts = since; ts <= until; ts += step) {
    timestamps.push(ts);
    rowsByTs[ts] = [];
    atcRowsByTs[ts] = [];
  }

  const bucketToSourceTs = new Map();
  if (availableTs.length > 0) {
    let index = 0;
    for (const bucketTs of timestamps) {
      while (index + 1 < availableTs.length && availableTs[index + 1] <= bucketTs) {
        index += 1;
      }

      const left = availableTs[index];
      const right = index + 1 < availableTs.length ? availableTs[index + 1] : null;
      let nearest = left;
      if (right != null && Math.abs(right - bucketTs) < Math.abs(left - bucketTs)) {
        nearest = right;
      }

      if (Math.abs(nearest - bucketTs) <= maxSourceAge) {
        bucketToSourceTs.set(bucketTs, nearest);
      }
    }
  }

  const sourceTs = Array.from(new Set(Array.from(bucketToSourceTs.values())));
  const pilotRows = getSnapshotsAtTimestamps(db, sourceTs, airspaces, airports, minAltitude, maxAltitude);
  const atcRows = getAtcSnapshotsAtTimestamps(db, sourceTs);

  const pilotBySourceTs = new Map();
  for (const row of pilotRows) {
    if (!pilotBySourceTs.has(row.ts)) pilotBySourceTs.set(row.ts, []);
    pilotBySourceTs.get(row.ts).push(row);
  }

  const atcBySourceTs = new Map();
  for (const row of atcRows) {
    if (!atcBySourceTs.has(row.ts)) atcBySourceTs.set(row.ts, []);
    atcBySourceTs.get(row.ts).push(row);
  }

  for (const bucketTs of timestamps) {
    const sourceTsForBucket = bucketToSourceTs.get(bucketTs);
    if (sourceTsForBucket == null) continue;
    sourceTsByBucket[bucketTs] = sourceTsForBucket;
    rowsByTs[bucketTs] = (pilotBySourceTs.get(sourceTsForBucket) || []).map(({ ts, ...row }) => row);
    atcRowsByTs[bucketTs] = (atcBySourceTs.get(sourceTsForBucket) || []).map(({ ts, ...row }) => row);
  }

  res.json({
    since,
    until,
    step,
    window,
    maxSourceAge,
    airspaces,
    airports,
    minAltitude,
    maxAltitude,
    timestamps,
    sourceTsByBucket,
    rowsByTs,
    atcRowsByTs
  });
});

const AIRSPACE_URLS = [
  "https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/main/Boundaries.geojson",
  "https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master/Boundaries.geojson"
];
const TRACON_LOCAL_DIR = resolve(join(__dirname, "../data/tracon"));
const TRACON_BOUNDARIES_FILES = [
  resolve(join(__dirname, "../data/TRACONBoundaries.geojson")),
  resolve(join(__dirname, "../data/TRACONBoundaries.json")),
  resolve(join(__dirname, "../../TRACONBoundaries.geojson")),
  resolve(join(__dirname, "../../TRACONBoundaries.json"))
];
console.log('[init] TRACON_BOUNDARIES_FILES:', TRACON_BOUNDARIES_FILES);
let airspaceCache = { ts: 0, data: null };
let traconCache = { ts: 0, data: null };
let atcCache = { ts: 0, positions: [] };

const queryCache = new Map();
const QUERY_CACHE_TTL_MS = 2000;

function getCacheKey(prefix, since, until, limit) {
  return `${prefix}:${since}:${until}:${limit}`;
}

function getCached(prefix, since, until, limit) {
  const key = getCacheKey(prefix, since, until, limit);
  const cached = queryCache.get(key);
  if (cached && Date.now() - cached.ts < QUERY_CACHE_TTL_MS) {
    return cached.data;
  }
  return null;
}

function setCached(prefix, since, until, limit, data) {
  const key = getCacheKey(prefix, since, until, limit);
  queryCache.set(key, { ts: Date.now(), data });
}

app.get("/api/airspace", async (req, res) => {
  try {
    const now = Date.now();
    const maxAgeMs = 60 * 60 * 1000; // 1 hour
    if (airspaceCache.data && (now - airspaceCache.ts) < maxAgeMs) {
      return res.json(airspaceCache.data);
    }

    let lastStatus = null;
    let lastUrl = null;
    const FETCH_TIMEOUT_MS = 10000; // 10 second timeout
    
    for (const url of AIRSPACE_URLS) {
      lastUrl = url;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const r = await fetch(url, {
          headers: { "User-Agent": "vatsim-traffic-replay/1.0 (+https://example.local)" },
          signal: controller.signal
        });
        clearTimeout(timer);
        
        lastStatus = r.status;
        if (!r.ok) continue;
        const data = await r.json();
        airspaceCache = { ts: now, data };
        return res.json(data);
      } catch (error) {
        // Timeout or network error, try next URL
        continue;
      }
    }

    // Return cached data even if expired, better than 502
    if (airspaceCache.data) {
      res.set("Cache-Control", "public, max-age=60");
      return res.json(airspaceCache.data);
    }

    return res.status(502).json({
      error: "airspace fetch failed",
      status: lastStatus,
      url: lastUrl
    });
  } catch (e) {
    res.status(500).json({ error: "airspace exception", message: String(e?.message || e) });
  }
})

app.get("/api/tracon", (req, res) => {
  try {
    const now = Date.now();
    const maxAgeMs = 60 * 60 * 1000; // 1 hour
    if (traconCache.data && (now - traconCache.ts) < maxAgeMs) {
      console.log(`[tracon] Serving from cache (${traconCache.data?.features?.length || 0} features)`);
      return res.json(traconCache.data);
    }

    // Try bundled TRACONBoundaries file first
    console.log(`[tracon] Looking for bundled files in ${TRACON_BOUNDARIES_FILES.length} paths...`);
    for (const p of TRACON_BOUNDARIES_FILES) {
      console.log(`[tracon]   Checking: ${p}`);
      if (existsSync(p)) {
        console.log(`[tracon]     ✓ File exists`);
        try {
          const txt = readFileSync(p, 'utf8');
          console.log(`[tracon]     Read ${txt.length} bytes`);
          const json = JSON.parse(txt);
          console.log(`[tracon]     Parsed JSON: type=${json.type}, features=${json?.features?.length}`);
          if (json && Array.isArray(json.features) && json.features.length > 0) {
            console.log(`[tracon] ✓✓ SUCCESS: Loaded ${json.features.length} features from ${p}`);
            const data = { type: 'FeatureCollection', features: json.features };
            traconCache = { ts: now, data };
            return res.json(data);
          }
        } catch (e) {
          console.warn(`[tracon]     ✗ ERROR: ${e?.message || e}`);
        }
      } else {
        console.log(`[tracon]     ✗ File does not exist`);
      }
    }

    // Fall back to local TRACON directory
    console.log(`[tracon] Checking local TRACON directory: ${TRACON_LOCAL_DIR}`);
    if (existsSync(TRACON_LOCAL_DIR)) {
      const regions = readdirSync(TRACON_LOCAL_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
      const allFeatures = [];
      for (const region of regions) {
        const regionDir = join(TRACON_LOCAL_DIR, region);
        const files = readdirSync(regionDir).filter(f => f.toLowerCase().endsWith('.json'));
        for (const f of files) {
          try {
            const txt = readFileSync(join(regionDir, f), 'utf8');
            const json = JSON.parse(txt);
            if (!json) continue;
            if (Array.isArray(json.features)) {
              allFeatures.push(...json.features);
            } else if (json.type === 'Feature') {
              allFeatures.push(json);
            } else if (json.geometry) {
              allFeatures.push({ type: 'Feature', properties: json.properties || {}, geometry: json.geometry });
            }
          } catch (e) {
            console.warn(`[tracon] warn: error reading local file ${region}/${f}: ${e?.message || e}`);
          }
        }
      }
      if (allFeatures.length > 0) {
        console.log(`[tracon] ✓ Loaded ${allFeatures.length} features from local TRACON dir`);
        const data = { type: 'FeatureCollection', features: allFeatures };
        traconCache = { ts: now, data };
        return res.json(data);
      }
    }

    // No TRACON data found; return empty
    console.log('[tracon] No bundled or local TRACON data found, returning empty collection');
    const empty = { type: 'FeatureCollection', features: [] };
    traconCache = { ts: now, data: empty };
    res.json(empty);
  } catch (e) {
    console.error(`[tracon] Exception:`, e?.message || e);
    res.status(500).json({ error: 'tracon exception', message: String(e?.message || e) });
  }
});

app.get("/api/atc-online", async (req, res) => {
  try {
    const now = Date.now();
    const maxAgeMs = 30 * 1000; // cache ATC for 30 seconds
    if (atcCache.positions.length > 0 && (now - atcCache.ts) < maxAgeMs) {
      return res.json({ positions: atcCache.positions });
    }
    const positions = await fetchAtcPositions();
    atcCache = { ts: now, positions };
    console.log(`[atc] fetched ${positions.length} ATC positions`);
    res.json({ positions });
  } catch (e) {
    res.status(500).json({ error: "atc fetch failed", message: String(e?.message || e) });
  }
});

// Endpoint to refresh local TRACON cache (download from GitHub)
app.post('/api/tracon-refresh', async (req, res) => {
  try {
    const result = await downloadAndStoreAllTracons();
    res.json({ ok: true, downloaded: result.count });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

async function downloadAndStoreAllTracons() {
  // Known regions in repo
  const regions = [
    'N90','N80','N81','N82','N83','N84','N85','N86','N87','N88','N89',
    'ZBW','ZNY','ZDC','ZAT','ZMA','ZJX','ZME','ZAU','ZDL','ZHU','ZIB','ZMP','ZLC','ZLA','ZOA','ZSE','ZSW','ZSL','ZAB','ZAK','ZPP','ZFW'
  ];

  if (!existsSync(TRACON_LOCAL_DIR)) mkdirSync(TRACON_LOCAL_DIR, { recursive: true });

  let downloaded = 0;
  for (const region of regions) {
    const apiUrl = `https://api.github.com/repos/vatsimnetwork/simaware-tracon-project/contents/Boundaries/${region}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(apiUrl, { signal: controller.signal, headers: { 'User-Agent': 'vatsim-traffic-replay/1.0' } });
      clearTimeout(timeout);
      if (!r.ok) {
        console.log(`[tracon-refresh] region ${region} listing not found: ${r.status}`);
        continue;
      }
      const files = await r.json();
      if (!Array.isArray(files)) continue;
      const regionDir = join(TRACON_LOCAL_DIR, region);
      if (!existsSync(regionDir)) mkdirSync(regionDir, { recursive: true });
      for (const file of files) {
        if (!file.name || !file.name.toLowerCase().endsWith('.json')) continue;
        const rawUrl = `https://raw.githubusercontent.com/vatsimnetwork/simaware-tracon-project/main/Boundaries/${region}/${file.name}`;
        try {
          const c2 = new AbortController();
          const t2 = setTimeout(() => c2.abort(), 8000);
          const fr = await fetch(rawUrl, { signal: c2.signal, headers: { 'User-Agent': 'vatsim-traffic-replay/1.0' } });
          clearTimeout(t2);
          if (!fr.ok) {
            console.log(`[tracon-refresh] failed to download ${region}/${file.name}: ${fr.status}`);
            continue;
          }
          const body = await fr.text();
          writeFileSync(join(regionDir, file.name), body, 'utf8');
          downloaded++;
        } catch (e) {
          console.warn(`[tracon-refresh] error fetching ${region}/${file.name}:`, e?.message || e);
        }
      }
    } catch (e) {
      console.warn(`[tracon-refresh] error listing region ${region}:`, e?.message || e);
    }
  }

  return { count: downloaded };
}

// Serve the built client in production
const clientDist = resolve(join(process.cwd(), "../client/dist"));
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (req, res) => {
    res.sendFile(join(clientDist, "index.html"));
  });
}

// Clear caches on startup to reload fresh data
airspaceCache = { ts: 0, data: null };
traconCache = { ts: 0, data: null };
atcCache = { ts: 0, positions: [] };

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  syncEventsOnce(true).catch((e) => {
    console.warn("[events] startup sync failed:", e?.message || e);
  });
  startCollector(); // Non-blocking; polls run in background
});
