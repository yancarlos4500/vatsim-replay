import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, GeoJSON } from "react-leaflet";
import L from "leaflet";
import { getMeta, getSnapshot, getCallsigns, getTrack, getAirspace, getAtcSnapshot, getTracon } from "./api";
import { fmt, clamp } from "./time";

// Fix Leaflet default marker icon paths in Vite
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow
});

function planeDivIcon(callsign, heading) {
  const rot = Number.isFinite(heading) ? heading : 0;
  const html = `
    <div class="planeMarker">
      <div class="planeIcon" style="transform: rotate(${rot}deg)">
        <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9L2 14v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5L21 16z" fill="currentColor"/>
        </svg>
      </div>
      <div class="planeLabel">${callsign}</div>
    </div>
  `;
  return L.divIcon({
    className: "planeDivIcon",
    html,
    iconSize: [1, 1], // size handled by HTML/CSS
    iconAnchor: [0, 0]
  });
}

function atcDivIcon(callsign) {
  const html = `
    <div class="atcMarker">
      <div class="atcIcon">
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8" fill="currentColor" stroke="white" stroke-width="2"/>
        </svg>
      </div>
    </div>
  `;
  return L.divIcon({
    className: "atcDivIcon",
    html,
    iconSize: [1, 1],
    iconAnchor: [0, 0]
  });
}


function useInterval(cb, delay, enabled) {
  const ref = useRef(cb);
  useEffect(() => { ref.current = cb; }, [cb]);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => ref.current(), delay);
    return () => clearInterval(id);
  }, [delay, enabled]);
}

// Mapping of VATSIM sector codes to GeoJSON boundary IDs
const sectorToGeojsonMap = {
  "BOS": "KZBW",  // Boston Center
  "TOR": "CZYZ",  // Toronto Center
  "NYC": "KZNY",  // New York Center
  "DC": "KZDC",  // Washington Center
  "ATL": "KZTL",  // Atlanta Center
  "MIA": "KZMA",  // Miami Center
  "JAX": "KZJX",  // Jacksonville Center
  "CLE": "KZOB",  // Cleveland Center
  "MEM": "KZME",  // Memphis Center
  "CHI": "KZAU",  // Chicago Center
  "DEN": "KZDV",  // Denver Center
  "FTW": "KZFW",  // Fort Worth (same as Dallas)
  "HOU": "KZHU",  // Houston Center
  "ORD": "KZAU",  // Chicago (same as CHI)
  "IND": "KZID",  // Indianapolis Center
  "MSP": "KZMP",  // Minneapolis Center
  "SLC": "KZLC",  // Salt Lake City Center
  "LAX": "KZLA",  // Los Angeles Center
  "OAK": "KZOA",  // Oakland Center
  "SEA": "KZSE",  // Seattle Center
  "PHO": "KZAB",  // Phoenix/Albuquerque Center
  "ABQ": "KZAB",  // Albuquerque Center
  "ZAK": "KZAK",  // Oakland Oceanic (ZAK sector)
  "HNL": "KZPP",  // Honolulu Center
  "ZBW": "KZBW",  // Boston Center (using Z-code directly)
  "ZNY": "KZNY",  // New York Center (using Z-code directly)
  "ZDC": "KZDC",  // Washington Center (using Z-code directly)
  "SJU": "TJZS",  // San Juan Center
};

function mapVatsimToGeojson(vatsimCode) {
  return sectorToGeojsonMap[vatsimCode] || null;
}

const featureBBoxCache = new WeakMap();

function computeBBoxFromCoords(coords) {
  let found = false;
  const bbox = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };

  function walk(c) {
    if (!c) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      const lon = c[0];
      const lat = c[1];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
      found = true;
      if (lon < bbox.west) bbox.west = lon;
      if (lon > bbox.east) bbox.east = lon;
      if (lat < bbox.south) bbox.south = lat;
      if (lat > bbox.north) bbox.north = lat;
      return;
    }
    if (Array.isArray(c)) {
      for (const item of c) walk(item);
    }
  }

  walk(coords);
  return found ? bbox : null;
}

function getFeatureBBox(feature) {
  if (!feature) return null;
  const cached = featureBBoxCache.get(feature);
  if (cached) return cached;
  const geom = feature.geometry;
  if (!geom) return null;

  let bbox = null;
  if (geom.type === "GeometryCollection" && Array.isArray(geom.geometries)) {
    for (const g of geom.geometries) {
      const b = computeBBoxFromCoords(g?.coordinates);
      if (!b) continue;
      if (!bbox) bbox = { ...b };
      else {
        if (b.west < bbox.west) bbox.west = b.west;
        if (b.east > bbox.east) bbox.east = b.east;
        if (b.south < bbox.south) bbox.south = b.south;
        if (b.north > bbox.north) bbox.north = b.north;
      }
    }
  } else {
    bbox = computeBBoxFromCoords(geom.coordinates);
  }

  if (bbox) featureBBoxCache.set(feature, bbox);
  return bbox;
}

function bboxIntersectsBounds(bbox, bounds, padDeg = 0) {
  if (!bbox || !bounds) return false;
  const west = bounds.west - padDeg;
  const east = bounds.east + padDeg;
  const south = bounds.south - padDeg;
  const north = bounds.north + padDeg;
  return !(bbox.east < west || bbox.west > east || bbox.north < south || bbox.south > north);
}

function buildAtcOnlineSets(rows) {
  const tracon = new Set();
  const airspace = new Set();

  (rows || []).forEach((row) => {
    if (!row?.callsign) return;
    const callsign = row.callsign.toUpperCase();
    const parts = callsign.split("_");
    const sectorCode = (parts[0] || "").toUpperCase();
    const roleMatch = callsign.match(/_(APP|DEP|CTR|FSS)(?:$|_)/);
    const role = roleMatch ? roleMatch[1] : (parts[parts.length - 1] || "").toUpperCase();

    if (role === "APP" || role === "DEP") {
      tracon.add(callsign);
      if (sectorCode) tracon.add(sectorCode);
      if (sectorCode) tracon.add(`${sectorCode}_${role}`);
      return;
    }

    if (role === "CTR") {
      if (sectorCode) airspace.add(sectorCode);
      if (sectorCode) airspace.add(`${sectorCode}_CTR`);
      const geojsonId = mapVatsimToGeojson(sectorCode);
      if (geojsonId) {
        const upGeo = geojsonId.toUpperCase();
        airspace.add(upGeo);
        airspace.add(`${upGeo}_CTR`);
      }
    }

    if (role === "FSS") {
      if (sectorCode) airspace.add(sectorCode);
      if (sectorCode) airspace.add(`${sectorCode}_FSS`);
      const geojsonId = mapVatsimToGeojson(sectorCode);
      if (geojsonId) {
        const upGeo = geojsonId.toUpperCase();
        airspace.add(upGeo);
        airspace.add(`${upGeo}_FSS`);
      }
    }
  });

  return { tracon, airspace };
}

export default function App() {
  const [meta, setMeta] = useState(null);
  const [mode, setMode] = useState("all"); // all | track
  const [loading, setLoading] = useState(false);

  const [t, setT] = useState(null); // current replay timestamp
  const [updatesPerSecond, setUpdatesPerSecond] = useState(1); // how many stored position-steps to apply per second
  const [playing, setPlaying] = useState(false);

  const [snapshot, setSnapshot] = useState([]);
  const [atcSnapshot, setAtcSnapshot] = useState([]);
  const [callsign, setCallsign] = useState("");
  const [callsigns, setCallsigns] = useState([]);
  const [track, setTrackState] = useState([]);
  const [showAirspace, setShowAirspace] = useState(true);
  const [airspace, setAirspace] = useState(null);
  const [showTracon, setShowTracon] = useState(true);
  const [tracon, setTracon] = useState(null);
  const [rangeStart, setRangeStart] = useState(null);
  const [rangeEnd, setRangeEnd] = useState(null);
  const [mapBounds, setMapBounds] = useState(null);
  const planeIconCache = useRef(new Map());
  const mapRef = useRef(null);

  const bounds = useMemo(() => {
    if (!meta?.minTs || !meta?.maxTs) return null;
    return { min: meta.minTs, max: meta.maxTs };
  }, [meta]);

  const stepSeconds = meta?.pollIntervalSeconds ?? 15;

  const { tracon: atcOnlineTracon, airspace: atcOnlineAirspace } = useMemo(
    () => buildAtcOnlineSets(atcSnapshot),
    [atcSnapshot]
  );

// Clamp current time into selected range
useEffect(() => {
  if (rangeStart == null || rangeEnd == null || t == null) return;
  if (t < rangeStart) setT(rangeStart);
  if (t > rangeEnd) setT(rangeEnd);
}, [rangeStart, rangeEnd]);




  useEffect(() => {
    (async () => {
      const m = await getMeta();
      setMeta(m);
      const start = m.maxTs ?? m.nowTs;
      setRangeStart(m.minTs ?? (start - 3600));
      setRangeEnd(m.maxTs ?? start);
      setT(start);
    })().catch(console.error);
  }, []);

// Load VATSIM VATSpy boundaries (airspace/FIR polygons) and TRACON boundaries
useEffect(() => {
  if (!showAirspace || airspace) return;
  (async () => {
    try {
      const data = await getAirspace();
      setAirspace(data);
    } catch (e) {
      console.error("airspace load failed", e);
    }
  })();
}, [showAirspace, airspace]);

// Auto-toggle airspace and TRACON visibility with replay
useEffect(() => {
  if (!playing) return;
  setShowAirspace(true);
  setShowTracon(true);
}, [playing]);

useEffect(() => {
  // If the toggle is off, do nothing. If tracon already has features, skip fetch.
  if (!showTracon) return;
  if (tracon && Array.isArray(tracon.features) && tracon.features.length > 0) return;
  (async () => {
    try {
      let data = await getTracon();

      // Flatten nested features from various possible structures
      if (data?.features) {
        const allFeatures = [];

        data.features.forEach((f, i) => {
          // Add the feature itself if it has geometry
          if (f.geometry && f.geometry.type !== "GeometryCollection") {
            allFeatures.push(f);
          }

          // Check multiple possible nested structure locations
          let nested = null;
          if (f.properties?.features && Array.isArray(f.properties.features)) {
            nested = f.properties.features;
          } else if (f.properties?.Boundaries && Array.isArray(f.properties.Boundaries)) {
            nested = f.properties.Boundaries;
          } else if (f.features && Array.isArray(f.features)) {
            nested = f.features;
          } else if (Array.isArray(f.geometry?.geometries)) {
            // Handle GeometryCollection
            f.geometry.geometries.forEach((geom, gi) => {
              allFeatures.push({
                type: "Feature",
                geometry: geom,
                properties: f.properties || {},
                id: `${f.id || i}-${gi}`
              });
            });
          }

          // Add nested features
          if (nested) {
            nested.forEach((nestedFeat, ni) => {
              if (nestedFeat.geometry) {
                allFeatures.push({
                  type: "Feature",
                  geometry: nestedFeat.geometry,
                  properties: nestedFeat.properties || {},
                  id: nestedFeat.id || `${f.id || i}-nested-${ni}`
                });
              }
            });
          }
        });

        data = { ...data, features: allFeatures };
      }

      setTracon(data);
    } catch (e) {
      console.error("tracon load failed", e);
    }
  })();
}, [showTracon, tracon]);

  async function refreshSnapshot(ts) {
    setLoading(true);
    try {
      const s = await getSnapshot(ts);
      setSnapshot(s.rows || []);
    } finally {
      setLoading(false);
    }
  }

  async function refreshAtcSnapshot(ts) {
    try {
      const a = await getAtcSnapshot(ts);
      setAtcSnapshot(a.rows || []);
    } catch (e) {
      console.error("atc snapshot load failed", e);
      setAtcSnapshot([]);
    }
  }

  async function refreshCallsigns() {
    if (!bounds) return;
    const until = rangeEnd ?? bounds.max;
    const since = rangeStart ?? bounds.min; // last 6h
    const r = await getCallsigns(since, until);
    setCallsigns((r.rows || []).map(x => x.callsign).sort());
  }

  async function loadTrack(cs) {
    if (!bounds) return;
    setLoading(true);
    try {
      const until = rangeEnd ?? bounds.max;
    const since = rangeStart ?? bounds.min; // last 6h by default
      const r = await getTrack(cs, since, until, 15);
      setTrackState((r.rows || []).map(p => [p.lat, p.lon]));
    } finally {
      setLoading(false);
    }
  }

  // Whenever time changes, fetch ATC snapshot; traffic snapshot only in ALL mode
  useEffect(() => {
    if (!t) return;
    if (mode === "all") {
      refreshSnapshot(t).catch(console.error);
    }
    refreshAtcSnapshot(t).catch(console.error);
  }, [t, mode]);

// Playback: advance by one stored step each "update", at updatesPerSecond rate
useInterval(() => {
  if (rangeStart == null || rangeEnd == null) return;
  setT(prev => clamp((prev ?? rangeStart) + stepSeconds, rangeStart, rangeEnd));
}, updatesPerSecond > 0 ? (1000 / updatesPerSecond) : 1000, playing);

// Auto-stop at end of selected range
useEffect(() => {
  if (!bounds || t == null || rangeEnd == null) return;
  if (t >= rangeEnd && playing) setPlaying(false);
}, [t, bounds, playing, rangeEnd]);


  const center = useMemo(() => {
    // Caribbean-ish default center; otherwise average snapshot
    if (snapshot.length) {
      const avgLat = snapshot.reduce((a, p) => a + p.lat, 0) / snapshot.length;
      const avgLon = snapshot.reduce((a, p) => a + p.lon, 0) / snapshot.length;
      return [avgLat, avgLon];
    }
    return [18.4, -66.0];
  }, [snapshot]);

  const getPlaneIcon = useCallback((callsign, heading) => {
    const rounded = Number.isFinite(heading) ? Math.round(heading / 5) * 5 : 0;
    const key = `${callsign}:${rounded}`;
    const cache = planeIconCache.current;
    let icon = cache.get(key);
    if (!icon) {
      icon = planeDivIcon(callsign, rounded);
      cache.set(key, icon);
      if (cache.size > 2000) cache.clear();
    }
    return icon;
  }, []);

  useEffect(() => {
    if (mode !== "all") planeIconCache.current.clear();
  }, [mode]);

  // Track map bounds for viewport filtering
  useEffect(() => {
    const map = mapRef.current?.leafletElement;
    if (!map) return;

    const handleMoveEnd = () => {
      const b = map.getBounds();
      setMapBounds({
        north: b.getNorth(),
        south: b.getSouth(),
        east: b.getEast(),
        west: b.getWest()
      });
    };

    handleMoveEnd(); // Initial bounds
    map.on("moveend", handleMoveEnd);
    return () => map.off("moveend", handleMoveEnd);
  }, []);

  // Filter snapshot to only planes within map bounds
  const visibleSnapshot = useMemo(() => {
    if (!mapBounds || !snapshot.length) return snapshot;
    return snapshot.filter(p => {
      const { lat, lon } = p;
      return (
        lat >= mapBounds.south &&
        lat <= mapBounds.north &&
        lon >= mapBounds.west &&
        lon <= mapBounds.east
      );
    });
  }, [snapshot, mapBounds]);

  const visibleAirspace = useMemo(() => {
    if (!airspace?.features || !mapBounds) return airspace;
    const padDeg = 0.5;
    const features = airspace.features.filter((f) => bboxIntersectsBounds(getFeatureBBox(f), mapBounds, padDeg));
    if (features.length === airspace.features.length) return airspace;
    return { ...airspace, features };
  }, [airspace, mapBounds]);

  const visibleTracon = useMemo(() => {
    if (!tracon?.features || !mapBounds) return tracon;
    const padDeg = 0.5;
    const features = tracon.features.filter((f) => bboxIntersectsBounds(getFeatureBBox(f), mapBounds, padDeg));
    if (features.length === tracon.features.length) return tracon;
    return { ...tracon, features };
  }, [tracon, mapBounds]);


  // Style GeoJSON features based on ATC online status
  const geojsonStyle = useCallback((feature) => {
    // Check against the GeoJSON feature ID or TRACON prefix array
    const featureId = (feature?.id || feature?.properties?.id || "").toString();
    let isOnline = featureId && atcOnlineAirspace.has(featureId.toUpperCase());

    // If feature has a `prefix` property (array of TRACON prefixes like "MDSD"),
    // consider it online if any prefix matches an ATC callsign or sector code.
    const prefixes = feature?.properties?.prefix || feature?.properties?.prefixes || null;
    if (!isOnline && Array.isArray(prefixes) && prefixes.length > 0) {
      for (const p of prefixes) {
        if (!p) continue;
        const up = p.toString().toUpperCase();
        if (atcOnlineAirspace.has(up)) { isOnline = true; break; }
        // Only match center controllers for airspace
        if (atcOnlineAirspace.has(`${up}_CTR`)) { isOnline = true; break; }
        if (isOnline) break;
      }
    }
    
    return {
      color: isOnline ? "#00ff00" : "#666666",
      weight: isOnline ? 2 : 1,
      opacity: isOnline ? 0.8 : 0.3,
      fillColor: isOnline ? "transparent" : "#000000",
      fillOpacity: isOnline ? 0 : 0.2
    };
  }, [atcOnlineAirspace]);

  // Style TRACON approach boundaries
  const traconStyle = useCallback((feature) => {
    // Check if this TRACON's ATC prefix is online
    const prefixes = feature?.properties?.prefix || feature?.properties?.prefixes || [];
    let isOnline = false;

    if (Array.isArray(prefixes) && prefixes.length > 0) {
      for (const p of prefixes) {
        if (!p) continue;
        const up = p.toString().toUpperCase();
        // Only match approach/departure roles
        const suffixes = ['_APP','_DEP'];
        for (const s of suffixes) {
          if (atcOnlineTracon.has(`${up}${s}`)) { isOnline = true; break; }
        }
        if (isOnline) break;
      }
    }

    // Only show if ATC is online
    if (!isOnline) {
      return {
        color: "#0099ff",
        weight: 0,
        opacity: 0,
        fillOpacity: 0
      };
    }

    return {
      color: "#0099ff",
      weight: 1,
      opacity: 0.5,
      dasharray: "5, 5",
      fillColor: "#0099ff",
      fillOpacity: 0.02
    };
  }, [atcOnlineTracon]);

  const snapshotMarkers = useMemo(() => {
    return visibleSnapshot.map((p) => (
      <Marker
        key={`${p.callsign}-${p.ts}-${p.lat}-${p.lon}`}
        position={[p.lat, p.lon]}
        icon={getPlaneIcon(p.callsign, p.heading)}
      />
    ));
  }, [visibleSnapshot, getPlaneIcon]);

  return (
    <div className="mapWrap">
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="row">
            <span className="badge">VATSIM Traffic Replay</span>
            <span className="badge"><span className="label">Stored:</span>&nbsp;{meta?.rows?.toLocaleString?.() ?? "—"} pts</span>
            <span className="badge"><span className="label">Range:</span>&nbsp;{meta?.minTs ? fmt(meta.minTs) : "—"} → {meta?.maxTs ? fmt(meta.maxTs) : "—"}</span>
            <span className="badge"><span className="label">Airspace:</span>&nbsp;{airspace?.features?.length ?? 0} features</span>
            <span className="badge"><span className="label">TRACON:</span>&nbsp;{tracon?.features?.length ?? 0} sectors</span>
          </div>
          <div className="row">
            <label className="label">Mode</label>
            <select value={mode} onChange={(e) => { setMode(e.target.value); setPlaying(false); }}>
              <option value="all">All traffic</option>
              <option value="track">Track callsign</option>
            </select>
            <label className="badge" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={showAirspace} onChange={(e) => setShowAirspace(e.target.checked)} />
              <span>Show airspace</span>
            </label>
            <label className="badge" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={showTracon} onChange={(e) => setShowTracon(e.target.checked)} />
              <span>Show TRACON</span>
            </label>
          </div>
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={() => setPlaying(p => !p)} disabled={!bounds}>
            {playing ? "Pause" : "Play"}
          </button>
          <button onClick={() => bounds && setT(bounds.min)} disabled={!bounds}>⏮ Start</button>
          <button onClick={() => bounds && setT(bounds.max)} disabled={!bounds}>⏭ Live</button>

             <label className="label">Updates/sec</label>
    <select value={updatesPerSecond} onChange={(e) => setUpdatesPerSecond(parseFloat(e.target.value))}>
      <option value={0.5}>0.5</option>
      <option value={1}>1</option>
      <option value={2}>2</option>
      <option value={4}>4</option>
      <option value={8}>8</option>
    </select>

          <div style={{ flex: "1 1 auto" }} />
          <span className="badge">{t ? fmt(t) : "—"}</span>
          <span className="badge">{loading ? "Loading…" : "Ready"}</span>
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <input
            className="slider"
            type="range"
            min={rangeStart ?? (bounds?.min ?? 0)}
            max={rangeEnd ?? (bounds?.max ?? 0)}
            value={t ?? 0}
            onChange={(e) => setT(parseInt(e.target.value, 10))}
            disabled={!bounds}
          />
          <small>Drag the timeline to replay within the selected range. Each update advances one stored step (~{stepSeconds}s). Updates/sec controls how many steps per second.</small>
        </div>

<div className="row" style={{ marginTop: 10 }}>
  <span className="badge"><span className="label">Replay range</span>&nbsp;{rangeStart ? fmt(rangeStart) : "—"} → {rangeEnd ? fmt(rangeEnd) : "—"}</span>
</div>

<div className="row" style={{ marginTop: 10 }}>
  <label className="label">Start</label>
  <input
    className="slider"
    type="range"
    min={bounds?.min ?? 0}
    max={bounds?.max ?? 0}
    value={rangeStart ?? (bounds?.min ?? 0)}
    onChange={(e) => setRangeStart(parseInt(e.target.value, 10))}
    disabled={!bounds}
  />
  <label className="label">End</label>
  <input
    className="slider"
    type="range"
    min={bounds?.min ?? 0}
    max={bounds?.max ?? 0}
    value={rangeEnd ?? (bounds?.max ?? 0)}
    onChange={(e) => setRangeEnd(parseInt(e.target.value, 10))}
    disabled={!bounds}
  />
  <button onClick={() => bounds && (setRangeStart(bounds.min), setRangeEnd(bounds.max), setT(bounds.max))} disabled={!bounds}>Full</button>
</div>

        {mode === "all" ? (
          <div className="row" style={{ marginTop: 10 }}>
            <span className="badge">Showing: {snapshot.length.toLocaleString()} aircraft (near selected time)</span>
          </div>
        ) : (
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={refreshCallsigns} disabled={!bounds}>Load recent callsigns</button>
            <select value={callsign} onChange={(e) => setCallsign(e.target.value)} style={{ minWidth: 220 }}>
              <option value="">Select callsign…</option>
              {callsigns.map(cs => <option key={cs} value={cs}>{cs}</option>)}
            </select>
            <button onClick={() => callsign && loadTrack(callsign)} disabled={!callsign}>Load track</button>
            <span className="badge">Track points: {track.length.toLocaleString()}</span>
          </div>
        )}
      </div>

      <MapContainer ref={mapRef} center={center} zoom={5} style={{ height: "100%", width: "100%" }}>
        <TileLayer
          attribution="&copy; OpenStreetMap contributors &copy; CARTO"
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />

        {showAirspace && visibleAirspace && (
          <GeoJSON data={visibleAirspace} style={geojsonStyle} />
        )}

        {showTracon && visibleTracon && (
          <GeoJSON data={visibleTracon} style={traconStyle} />
        )}


        {mode === "all" && snapshotMarkers}

        {mode === "track" && track.length > 1 && (
          <Polyline positions={track} />
        )}
      </MapContainer>
    </div>
  );
}
