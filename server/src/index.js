import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { openDb, insertSnapshots, pruneOld, getCallsingsInRange, getTrack, getSnapshotAt, getRangeMeta, insertAtcSnapshots, pruneOldAtc, getAtcSnapshotAt } from "./db.js";
import { fetchPilots, fetchAtcPositions } from "./collector.js";

// Define __dirname for ES modules
const __dirname = fileURLToPath(new URL(".", import.meta.url));

dotenv.config();

const PORT = parseInt(process.env.PORT || "4000", 10);
const POLL_INTERVAL_SECONDS = parseInt(process.env.POLL_INTERVAL_SECONDS || "15", 10);
const RETENTION_HOURS = parseInt(process.env.RETENTION_HOURS || "24", 10);
const DB_PATH = process.env.DB_PATH || "./data/vatsim.sqlite";

const app = express();
app.use(cors());
app.use(express.json());

const db = openDb(DB_PATH);

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

async function pollOnce() {
  const ts = nowTs();
  const pilots = await fetchPilots();
  const atc = await fetchAtcPositions();
  const count = insertSnapshots(db, ts, pilots);
  const atcCount = insertAtcSnapshots(db, ts, atc);
  const cutoff = ts - RETENTION_HOURS * 3600;
  const pruned = pruneOld(db, cutoff);
  const atcPruned = pruneOldAtc(db, cutoff);
  console.log(`[collector] ts=${ts} pilots=${pilots.length} inserted=${count} atc=${atc.length} atc-inserted=${atcCount} pruned=${pruned} atc-pruned=${atcPruned}`);
}

let pollTimer = null;

async function startCollector() {
  // First poll immediately
  try {
    await pollOnce();
  } catch (e) {
    console.error("[collector] initial poll failed:", e);
  }

  pollTimer = setInterval(async () => {
    try {
      await pollOnce();
    } catch (e) {
      console.error("[collector] poll failed:", e);
    }
  }, POLL_INTERVAL_SECONDS * 1000);
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

app.get("/api/callsigns", (req, res) => {
  const now = nowTs();
  const since = parseInt(req.query.since || (now - 3600).toString(), 10);
  const until = parseInt(req.query.until || now.toString(), 10);
  const limit = parseInt(req.query.limit || "2000", 10);
  const rows = getCallsingsInRange(db, since, until, limit);
  res.json({ since, until, rows });
});

app.get("/api/track/:callsign", (req, res) => {
  const now = nowTs();
  const callsign = req.params.callsign.toUpperCase();
  const since = parseInt(req.query.since || (now - 3600).toString(), 10);
  const until = parseInt(req.query.until || now.toString(), 10);
  const step = parseInt(req.query.step || "0", 10);
  const rows = getTrack(db, callsign, since, until, step);
  res.json({ callsign, since, until, step, rows });
});

app.get("/api/snapshot", (req, res) => {
  const now = nowTs();
  const ts = parseInt(req.query.ts || now.toString(), 10);
  const window = parseInt(req.query.window || Math.max(5, Math.floor(POLL_INTERVAL_SECONDS / 2)).toString(), 10);
  const rows = getSnapshotAt(db, ts, window);
  res.json({ ts, window, rows });
});

app.get("/api/atc-snapshot", (req, res) => {
  const now = nowTs();
  const ts = parseInt(req.query.ts || now.toString(), 10);
  const window = parseInt(req.query.window || Math.max(5, Math.floor(POLL_INTERVAL_SECONDS / 2)).toString(), 10);
  const rows = getAtcSnapshotAt(db, ts, window);
  res.json({ ts, window, rows });
});

const AIRSPACE_URLS = [
  "https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/main/Boundaries.geojson",
  "https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master/Boundaries.geojson"
];
const TRACON_URL = "https://raw.githubusercontent.com/vatsimnetwork/simaware-tracon-project/main/Boundaries/N90/NY.json";
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

app.get("/api/airspace", async (req, res) => {
  try {
    const now = Date.now();
    const maxAgeMs = 60 * 60 * 1000; // 1 hour
    if (airspaceCache.data && (now - airspaceCache.ts) < maxAgeMs) {
      return res.json(airspaceCache.data);
    }

    let lastStatus = null;
    let lastUrl = null;
    for (const url of AIRSPACE_URLS) {
      lastUrl = url;
      const r = await fetch(url, {
        headers: { "User-Agent": "vatsim-traffic-replay/1.0 (+https://example.local)" }
      });
      lastStatus = r.status;
      if (!r.ok) continue;
      const data = await r.json();
      airspaceCache = { ts: now, data };
      return res.json(data);
    }

    return res.status(502).json({
      error: "airspace fetch failed",
      status: lastStatus,
      url: lastUrl
    });
  } catch (e) {
    res.status(500).json({ error: "airspace exception", message: String(e?.message || e) });
  }
});

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
    console.log(`[atc] fetched ${positions.length} ATC positions. Sample:`, positions.slice(0, 3));
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
  startCollector();
});
