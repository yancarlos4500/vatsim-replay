import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Polyline, GeoJSON, CircleMarker } from "react-leaflet";
import L from "leaflet";
import {
  Box,
  Paper,
  Stack,
  Typography,
  Chip,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  TextField,
  FormGroup,
  FormControlLabel,
  Checkbox,
  Slider,
  LinearProgress
} from "@mui/material";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { getMeta, getSnapshot, getCallsigns, getTrack, getAirspace, getAtcSnapshot, getTracon, getAirspaces, getAirports } from "./api";
import { fmt, clamp } from "./time";

const panelTheme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#66b2ff" },
    background: {
      default: "#0f1722",
      paper: "#162334"
    },
    text: {
      primary: "#f3f8ff",
      secondary: "#c5d6e8"
    }
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          borderColor: "rgba(180, 205, 230, 0.35)",
          backgroundImage: "none"
        }
      }
    },
    MuiChip: {
      styleOverrides: {
        root: {
          backgroundColor: "rgba(112, 161, 212, 0.18)",
          border: "1px solid rgba(170, 205, 240, 0.35)",
          color: "#e9f2fb"
        }
      }
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: "rgba(11, 20, 30, 0.9)",
          "& .MuiOutlinedInput-notchedOutline": {
            borderColor: "rgba(170, 205, 240, 0.38)"
          },
          "&:hover .MuiOutlinedInput-notchedOutline": {
            borderColor: "rgba(170, 205, 240, 0.7)"
          }
        },
        input: {
          color: "#f3f8ff"
        }
      }
    },
    MuiFormLabel: {
      styleOverrides: {
        root: {
          color: "#c5d6e8"
        }
      }
    },
    MuiTypography: {
      styleOverrides: {
        root: {
          color: "#f3f8ff"
        }
      }
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: "none",
          fontWeight: 600
        }
      }
    }
  }
});

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

function planeDivIcon(callsign, heading, detailRows = []) {
  const rot = Number.isFinite(heading) ? heading : 0;
  const detailsHtml = detailRows.length > 0
    ? `<div class="planeDetails">${detailRows.map((row) => `<div class="planeDetailRow">${row}</div>`).join("")}</div>`
    : "";
  const html = `
    <div class="planeMarker">
      <div class="planeIcon" style="transform: rotate(${rot}deg)">
        <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9L2 14v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5L21 16z" fill="currentColor"/>
        </svg>
      </div>
      <div class="planeLabel">${callsign}</div>
      ${detailsHtml}
    </div>
  `;
  return L.divIcon({
    className: "planeDivIcon",
    html,
    iconSize: [1, 1],
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
  "BOS": "KZBW",
  "TOR": "CZYZ",
  "NYC": "KZNY",
  "DC": "KZDC",
  "ATL": "KZTL",
  "MIA": "KZMA",
  "JAX": "KZJX",
  "CLE": "KZOB",
  "MEM": "KZME",
  "CHI": "KZAU",
  "DEN": "KZDV",
  "FTW": "KZFW",
  "HOU": "KZHU",
  "ORD": "KZAU",
  "IND": "KZID",
  "MSP": "KZMP",
  "SLC": "KZLC",
  "LAX": "KZLA",
  "OAK": "KZOA",
  "SEA": "KZSE",
  "PHO": "KZAB",
  "ABQ": "KZAB",
  "ZAK": "KZAK",
  "HNL": "KZPP",
  "ZBW": "KZBW",
  "ZNY": "KZNY",
  "ZDC": "KZDC",
  "SJU": "TJZS"
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
  const [showAltitude, setShowAltitude] = useState(true);
  const [showGroundspeed, setShowGroundspeed] = useState(true);
  const [hideBelow30Knots, setHideBelow30Knots] = useState(false);
  const [showPilotAirspace, setShowPilotAirspace] = useState(true);
  const [showRouteAirports, setShowRouteAirports] = useState(true);
  const [showHistoryTrail, setShowHistoryTrail] = useState(false);
  const [selectedAirspaces, setSelectedAirspaces] = useState([]);
  const [airspaceOptions, setAirspaceOptions] = useState([]);
  const [airportFilterText, setAirportFilterText] = useState("");
  const [airportOptions, setAirportOptions] = useState([]);
  const [minAltitude, setMinAltitude] = useState("");
  const [maxAltitude, setMaxAltitude] = useState("");
  const [rangeStart, setRangeStart] = useState(null);
  const [rangeEnd, setRangeEnd] = useState(null);
  const [mapBounds, setMapBounds] = useState(null);
  const [preloadedSnapshots, setPreloadedSnapshots] = useState(new Map());
  const [preloadedAtcSnapshots, setPreloadedAtcSnapshots] = useState(new Map());
  const [isPreloading, setIsPreloading] = useState(false);
  const [preloadProgress, setPreloadProgress] = useState(0);
  const planeIconCache = useRef(new Map());
  const mapRef = useRef(null);

  const bounds = useMemo(() => {
    if (!meta?.minTs || !meta?.maxTs) return null;
    return { min: meta.minTs, max: meta.maxTs };
  }, [meta]);

  const stepSeconds = meta?.pollIntervalSeconds ?? 15;
  const sliderStepSeconds = 15;

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
      const minTs = m.minTs ?? (start - (24 * 3600));
      setRangeStart(Math.max(minTs, start - (5 * 3600)));
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
    // Only use preloaded snapshots
    if (preloadedSnapshots.has(ts)) {
      setSnapshot(preloadedSnapshots.get(ts));
      return;
    }
    
    // If not preloaded, show empty snapshot
    setSnapshot([]);
  }

  async function refreshAtcSnapshot(ts) {
    // Only use preloaded ATC snapshots
    if (preloadedAtcSnapshots.has(ts)) {
      setAtcSnapshot(preloadedAtcSnapshots.get(ts));
      return;
    }
    
    // If not preloaded, show empty snapshot
    setAtcSnapshot([]);
  }

  async function refreshCallsigns() {
    if (!bounds) return;
    const until = rangeEnd ?? bounds.max;
    const since = rangeStart ?? bounds.min;
    const airspacesStr = selectedAirspaces.join(",");
    const r = await getCallsigns(since, until, airspacesStr, airportFilterText);
    setCallsigns((r.rows || []).map(x => x.callsign).sort());
  }

  async function refreshAirspaceOptions() {
    if (!bounds) return;
    const until = rangeEnd ?? bounds.max;
    const since = rangeStart ?? bounds.min;
    const r = await getAirspaces(since, until);
    const unique = Array.from(new Set(
      (r.rows || [])
        .map((x) => (typeof x.airspace === "string" ? x.airspace.trim().toUpperCase() : ""))
        .filter(Boolean)
    )).sort();
    setAirspaceOptions(unique);
  }

  async function refreshAirportOptions() {
    if (!bounds) return;
    const until = rangeEnd ?? bounds.max;
    const since = rangeStart ?? bounds.min;
    const r = await getAirports(since, until);
    const unique = Array.from(new Set(
      (r.rows || [])
        .map((x) => (typeof x.airport === "string" ? x.airport.trim().toUpperCase() : ""))
        .filter(Boolean)
    )).sort();
    setAirportOptions(unique);
  }

  async function loadSnapshotsForRange() {
    if (!rangeStart || !rangeEnd) return;
    
    setIsPreloading(true);
    setPreloadProgress(0);
    
    try {
      const snapshots = new Map();
      const atcSnapshots = new Map();
      const timestamps = [];
      
      // Parse altitude filters
      const minAlt = minAltitude && minAltitude.trim() ? parseInt(minAltitude, 10) : null;
      const maxAlt = maxAltitude && maxAltitude.trim() ? parseInt(maxAltitude, 10) : null;
      const airspacesStr = selectedAirspaces.join(",");
      
      // Generate all timestamps in the range at the poll interval
      for (let ts = rangeStart; ts <= rangeEnd; ts += stepSeconds) {
        timestamps.push(ts);
      }
      
      const total = timestamps.length;
      let loaded = 0;
      
      // Fetch snapshots in batches of 5 to avoid overloading the server
      const batchSize = 5;
      for (let i = 0; i < timestamps.length; i += batchSize) {
        const batch = timestamps.slice(i, i + batchSize);
        
        // Fetch both pilot and ATC snapshots in parallel for each timestamp
        const promises = batch.map(ts =>
          Promise.all([
            getSnapshot(ts, airspacesStr, airportFilterText, minAlt, maxAlt)
              .then(data => ({ ts, data: data.rows || [] }))
              .catch(e => {
                console.error(`Failed to load snapshot for ${ts}:`, e);
                return { ts, data: [] };
              }),
            getAtcSnapshot(ts)
              .then(data => ({ ts, data: data.rows || [] }))
              .catch(e => {
                console.error(`Failed to load ATC snapshot for ${ts}:`, e);
                return { ts, data: [] };
              })
          ])
        );
        
        const results = await Promise.all(promises);
        results.forEach(([pilotResult, atcResult]) => {
          snapshots.set(pilotResult.ts, pilotResult.data);
          atcSnapshots.set(atcResult.ts, atcResult.data);
          loaded++;
          setPreloadProgress(Math.round((loaded / total) * 100));
        });
      }
      
      setPreloadedSnapshots(snapshots);
      setPreloadedAtcSnapshots(atcSnapshots);
      setT(rangeStart); // Jump to start of range
      setPlaying(true); // Auto-start playback
    } catch (e) {
      console.error("Failed to preload snapshots:", e);
    } finally {
      setIsPreloading(false);
    }
  }

  async function loadTrack(cs) {
    if (!bounds) return;
    setLoading(true);
    try {
      const until = rangeEnd ?? bounds.max;
      const since = rangeStart ?? bounds.min;
      const airspacesStr = selectedAirspaces.join(",");
      const r = await getTrack(cs, since, until, 15, airspacesStr, airportFilterText);
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
  }, [t, mode, selectedAirspaces, airportFilterText]);

  useEffect(() => {
    refreshAirspaceOptions().catch(console.error);
    refreshAirportOptions().catch(console.error);
  }, [bounds, rangeStart, rangeEnd]);

  useEffect(() => {
    // Remove any selected airspaces that are no longer in options
    const validAirspaces = selectedAirspaces.filter(a => airspaceOptions.includes(a));
    if (validAirspaces.length !== selectedAirspaces.length) {
      setSelectedAirspaces(validAirspaces);
    }
  }, [selectedAirspaces, airspaceOptions]);

  // Clear preloaded snapshots when filters change
  useEffect(() => {
    setPreloadedSnapshots(new Map());
    setPreloadedAtcSnapshots(new Map());
  }, [selectedAirspaces, airportFilterText, minAltitude, maxAltitude]);

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

  const getPlaneIcon = useCallback((callsign, heading, detailRows) => {
    const rounded = Number.isFinite(heading) ? Math.round(heading / 5) * 5 : 0;
    const detailsKey = Array.isArray(detailRows) ? detailRows.join("|") : "";
    const key = `${callsign}:${rounded}:${detailsKey}`;
    const cache = planeIconCache.current;
    let icon = cache.get(key);
    if (!icon) {
      icon = planeDivIcon(callsign, rounded, detailRows);
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
    if (!snapshot.length) return snapshot;
    return snapshot.filter((p) => {
      if (hideBelow30Knots && Number.isFinite(p.groundspeed) && p.groundspeed < 30) {
        return false;
      }
      if (!mapBounds) return true;
      const { lat, lon } = p;
      return (
        lat >= mapBounds.south &&
        lat <= mapBounds.north &&
        lon >= mapBounds.west &&
        lon <= mapBounds.east
      );
    });
  }, [snapshot, mapBounds, hideBelow30Knots]);

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
    const formatDetailRows = (p) => {
      const rows = [];
      if (showRouteAirports) rows.push(`${p.departure || "—"}-${p.destination || "—"}`);
      if (showAltitude) rows.push(Number.isFinite(p.altitude) ? `${Math.round(p.altitude)} ft` : "—");
      if (showGroundspeed) rows.push(Number.isFinite(p.groundspeed) ? `${Math.round(p.groundspeed)} kt` : "—");
      if (showPilotAirspace) rows.push(p.airspace || "—");
      return rows;
    };

    return visibleSnapshot.map((p) => (
      <Marker
        key={`${p.callsign}-${p.ts}-${p.lat}-${p.lon}`}
        position={[p.lat, p.lon]}
        icon={getPlaneIcon(p.callsign, p.heading, formatDetailRows(p))}
      />
    ));
  }, [visibleSnapshot, getPlaneIcon, showRouteAirports, showAltitude, showGroundspeed, showPilotAirspace]);

  const historyTrailDots = useMemo(() => {
    if (!showHistoryTrail || mode !== "all" || t == null || preloadedSnapshots.size === 0 || snapshot.length === 0) {
      return [];
    }

    const activeCallsigns = new Set(snapshot.map((p) => p.callsign));
    if (activeCallsigns.size === 0) return [];

    const timestamps = Array.from(preloadedSnapshots.keys())
      .filter((ts) => ts < t && (rangeStart == null || ts >= rangeStart))
      .sort((a, b) => a - b);

    if (timestamps.length === 0) return [];

    const perAircraft = new Map();
    for (const ts of timestamps) {
      const rows = preloadedSnapshots.get(ts) || [];
      for (const p of rows) {
        if (!activeCallsigns.has(p.callsign)) continue;
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
        if (hideBelow30Knots && Number.isFinite(p.groundspeed) && p.groundspeed < 30) continue;
        if (mapBounds) {
          if (p.lat < mapBounds.south || p.lat > mapBounds.north || p.lon < mapBounds.west || p.lon > mapBounds.east) {
            continue;
          }
        }

        const existing = perAircraft.get(p.callsign) || [];
        existing.push({ key: `${p.callsign}-${ts}-${p.lat}-${p.lon}`, lat: p.lat, lon: p.lon });
        if (existing.length > 5) {
          existing.splice(0, existing.length - 5);
        }
        perAircraft.set(p.callsign, existing);
      }
    }

    return Array.from(perAircraft.values()).flat();
  }, [showHistoryTrail, mode, t, preloadedSnapshots, snapshot, rangeStart, hideBelow30Knots, mapBounds]);

  return (
    <div className="mapWrap">
      <ThemeProvider theme={panelTheme}>
      <Box className="panel" sx={{ gap: 1.25 }}>
        <Paper variant="outlined" sx={{ p: 1.25, bgcolor: "rgba(255,255,255,0.03)" }}>
          <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>VATSIM Traffic Replay</Typography>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mb: 1 }}>
            <Chip size="small" label={`Stored: ${meta?.rows?.toLocaleString?.() ?? "—"} pts`} />
            <Chip size="small" label={`Airspace: ${airspace?.features?.length ?? 0}`} />
            <Chip size="small" label={`TRACON: ${tracon?.features?.length ?? 0}`} />
          </Stack>
          <Chip size="small" label={`Range: ${meta?.minTs ? fmt(meta.minTs) : "—"} → ${meta?.maxTs ? fmt(meta.maxTs) : "—"}`} />
        </Paper>

        <Paper variant="outlined" sx={{ p: 1.25, bgcolor: "rgba(255,255,255,0.03)" }}>
          <Typography variant="overline" sx={{ opacity: 1, color: "text.secondary" }}>Preload Snapshots</Typography>
          
          {isPreloading ? (
            <Box sx={{ mb: 1 }}>
              <LinearProgress variant="determinate" value={preloadProgress} />
              <Typography variant="caption" sx={{ opacity: 1, color: "text.secondary" }}>Loading: {preloadProgress}%</Typography>
            </Box>
          ) : (
            <Stack direction="row" spacing={1} sx={{ mb: 1.5 }}>
              <Button 
                variant={preloadedSnapshots.size > 0 ? "contained" : "outlined"} 
                size="small" 
                fullWidth
                onClick={() => loadSnapshotsForRange()} 
                disabled={!bounds || !rangeStart || !rangeEnd || isPreloading}
              >
                {preloadedSnapshots.size > 0 ? `✓ Loaded (${preloadedSnapshots.size})` : "Load Snapshots"}
              </Button>
            </Stack>
          )}
          
          <Typography variant="overline" sx={{ opacity: 1, color: "text.secondary", mt: 1.5 }}>Playback</Typography>
          <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
            <Button 
              variant="contained" 
              size="small" 
              onClick={() => setPlaying((p) => !p)} 
              disabled={!bounds || preloadedSnapshots.size === 0}
            >
              {playing ? "Pause" : "Play"}
            </Button>
            <Button 
              variant="outlined" 
              size="small" 
              onClick={() => bounds && setT(bounds.min)} 
              disabled={!bounds}
            >
              Start
            </Button>
            <Button 
              variant="outlined" 
              size="small" 
              onClick={() => bounds && setT(bounds.max)} 
              disabled={!bounds}
            >
              Live
            </Button>
          </Stack>

          <FormControl fullWidth size="small" sx={{ mb: 1 }}>
            <InputLabel>Updates/sec</InputLabel>
            <Select label="Updates/sec" value={String(updatesPerSecond)} onChange={(e) => setUpdatesPerSecond(parseFloat(e.target.value))}>
              <MenuItem value="0.5">0.5</MenuItem>
              <MenuItem value="1">1</MenuItem>
              <MenuItem value="2">2</MenuItem>
              <MenuItem value="4">4</MenuItem>
              <MenuItem value="8">8</MenuItem>
            </Select>
          </FormControl>

          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mb: 1 }}>
            <Chip size="small" label={t ? fmt(t) : "—"} />
            <Chip 
              size="small" 
              label={isPreloading ? `Loading ${preloadProgress}%` : (preloadedSnapshots.size > 0 ? "Preloaded" : "Preload Required")} 
              variant={preloadedSnapshots.size > 0 ? "filled" : "outlined"}
              color={preloadedSnapshots.size > 0 ? "success" : "default"}
            />
          </Stack>

          <Typography variant="caption" sx={{ opacity: 1, color: "text.secondary" }}>Timeline</Typography>
          <Slider
            value={t ?? 0}
            min={rangeStart ?? (bounds?.min ?? 0)}
            max={rangeEnd ?? (bounds?.max ?? 0)}
            step={sliderStepSeconds}
            onChange={(_, value) => setT(Array.isArray(value) ? value[0] : value)}
            disabled={!bounds}
          />
          <Typography variant="caption" sx={{ display: "block", mb: 1, opacity: 1, color: "text.secondary" }}>Each update advances one stored step (~{stepSeconds}s).</Typography>

          <Chip size="small" sx={{ mb: 1 }} label={`Replay range: ${rangeStart ? fmt(rangeStart) : "—"} → ${rangeEnd ? fmt(rangeEnd) : "—"}`} />

          <Typography variant="caption" sx={{ opacity: 1, color: "text.secondary" }}>Start</Typography>
          <Slider
            value={rangeStart ?? (bounds?.min ?? 0)}
            min={bounds?.min ?? 0}
            max={bounds?.max ?? 0}
            step={sliderStepSeconds}
            onChange={(_, value) => setRangeStart(Array.isArray(value) ? value[0] : value)}
            disabled={!bounds}
          />

          <Typography variant="caption" sx={{ opacity: 1, color: "text.secondary" }}>End</Typography>
          <Slider
            value={rangeEnd ?? (bounds?.max ?? 0)}
            min={bounds?.min ?? 0}
            max={bounds?.max ?? 0}
            step={sliderStepSeconds}
            onChange={(_, value) => setRangeEnd(Array.isArray(value) ? value[0] : value)}
            disabled={!bounds}
          />

          <Button fullWidth size="small" variant="outlined" onClick={() => bounds && (setRangeStart(bounds.min), setRangeEnd(bounds.max), setT(bounds.max))} disabled={!bounds}>Full Range</Button>
        </Paper>

        <Paper variant="outlined" sx={{ p: 1.25, bgcolor: "rgba(255,255,255,0.03)" }}>
          <Typography variant="overline" sx={{ opacity: 1, color: "text.secondary" }}>Filters</Typography>
          <FormControl fullWidth size="small" sx={{ mb: 1 }}>
            <InputLabel>Mode</InputLabel>
            <Select label="Mode" value={mode} onChange={(e) => { setMode(e.target.value); setPlaying(false); }}>
              <MenuItem value="all">All traffic</MenuItem>
              <MenuItem value="track">Track callsign</MenuItem>
            </Select>
          </FormControl>

          <FormControl fullWidth size="small" sx={{ mb: 1 }}>
            <InputLabel>Replay airspace(s)</InputLabel>
            <Select 
              label="Replay airspace(s)" 
              multiple
              value={selectedAirspaces} 
              onChange={(e) => setSelectedAirspaces(e.target.value)}
              renderValue={(selected) => selected.length === 0 ? "All airspaces" : selected.join(", ")}
            >
              {airspaceOptions.map((name) => (
                <MenuItem key={name} value={name}>{name}</MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            label="Replay airport(s)"
            size="small"
            fullWidth
            value={airportFilterText}
            onChange={(e) => setAirportFilterText(e.target.value.toUpperCase())}
            placeholder="KJFK, KLAX"
            inputProps={{ list: "airport-options" }}
          />
          <datalist id="airport-options">
            {airportOptions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>

          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <TextField
              label="Min altitude"
              type="number"
              size="small"
              value={minAltitude}
              onChange={(e) => setMinAltitude(e.target.value)}
              placeholder="0"
              inputProps={{ min: "0", step: "100" }}
            />
            <TextField
              label="Max altitude"
              type="number"
              size="small"
              value={maxAltitude}
              onChange={(e) => setMaxAltitude(e.target.value)}
              placeholder="50000"
              inputProps={{ min: "0", step: "100" }}
            />
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 1.25, bgcolor: "rgba(255,255,255,0.03)" }}>
          <Typography variant="overline" sx={{ opacity: 1, color: "text.secondary" }}>Display</Typography>
          <FormGroup>
            <FormControlLabel control={<Checkbox checked={showAirspace} onChange={(e) => setShowAirspace(e.target.checked)} />} label="Show airspace" />
            <FormControlLabel control={<Checkbox checked={showTracon} onChange={(e) => setShowTracon(e.target.checked)} />} label="Show TRACON" />
            <FormControlLabel control={<Checkbox checked={showHistoryTrail} onChange={(e) => setShowHistoryTrail(e.target.checked)} />} label="Show history trail" />
            <FormControlLabel control={<Checkbox checked={showAltitude} onChange={(e) => setShowAltitude(e.target.checked)} />} label="Show altitude" />
            <FormControlLabel control={<Checkbox checked={showGroundspeed} onChange={(e) => setShowGroundspeed(e.target.checked)} />} label="Show groundspeed" />
            <FormControlLabel control={<Checkbox checked={hideBelow30Knots} onChange={(e) => setHideBelow30Knots(e.target.checked)} />} label="< 30 knots" />
            <FormControlLabel control={<Checkbox checked={showRouteAirports} onChange={(e) => setShowRouteAirports(e.target.checked)} />} label="Show dep-arr" />
            <FormControlLabel control={<Checkbox checked={showPilotAirspace} onChange={(e) => setShowPilotAirspace(e.target.checked)} />} label="Show pilot airspace" />
          </FormGroup>
        </Paper>

        <Paper variant="outlined" sx={{ p: 1.25, bgcolor: "rgba(255,255,255,0.03)" }}>
          <Typography variant="overline" sx={{ opacity: 1, color: "text.secondary" }}>Selection</Typography>
          {mode === "all" ? (
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
              <Chip size="small" label={`Showing: ${snapshot.length.toLocaleString()} aircraft`} />
              <Chip size="small" label={`Airspace: ${selectedAirspaces.length === 0 ? "All" : selectedAirspaces.join(", ")}`} />
              <Chip size="small" label={`Airport: ${airportFilterText || "All"}`} />
              <Chip size="small" label={`Altitude: ${minAltitude || "0"} - ${maxAltitude || "∞"} ft`} />
            </Stack>
          ) : (
            <Stack spacing={1}>
              <Button size="small" variant="outlined" onClick={refreshCallsigns} disabled={!bounds}>Load recent callsigns</Button>
              <FormControl fullWidth size="small">
                <InputLabel>Callsign</InputLabel>
                <Select label="Callsign" value={callsign} onChange={(e) => setCallsign(e.target.value)}>
                  <MenuItem value="">Select callsign…</MenuItem>
                  {callsigns.map((cs) => <MenuItem key={cs} value={cs}>{cs}</MenuItem>)}
                </Select>
              </FormControl>
              <Button size="small" variant="contained" onClick={() => callsign && loadTrack(callsign)} disabled={!callsign}>Load track</Button>
              <Chip size="small" label={`Track points: ${track.length.toLocaleString()}`} />
            </Stack>
          )}
        </Paper>
      </Box>
      </ThemeProvider>

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


        {mode === "all" && showHistoryTrail && historyTrailDots.map((p) => (
          <CircleMarker
            key={p.key}
            center={[p.lat, p.lon]}
            radius={2}
            pathOptions={{ color: "#66b2ff", fillColor: "#66b2ff", fillOpacity: 0.35, weight: 0 }}
          />
        ))}

        {mode === "all" && snapshotMarkers}

        {mode === "track" && track.length > 1 && (
          <Polyline positions={track} />
        )}
      </MapContainer>
    </div>
  );
}
