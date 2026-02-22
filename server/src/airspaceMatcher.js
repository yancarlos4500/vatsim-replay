import fetch from "node-fetch";

const AIRSPACE_URLS = [
  "https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/main/Boundaries.geojson",
  "https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master/Boundaries.geojson"
];

const USER_AGENT = "vatsim-traffic-replay/1.0 (+https://example.local)";

function ringContainsPoint(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];

    const intersects = ((yi > lat) !== (yj > lat))
      && (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonContainsPoint(polygonCoordinates, lon, lat) {
  if (!Array.isArray(polygonCoordinates) || polygonCoordinates.length === 0) return false;
  const outerRing = polygonCoordinates[0];
  if (!Array.isArray(outerRing) || outerRing.length < 3) return false;
  if (!ringContainsPoint(outerRing, lon, lat)) return false;

  for (let i = 1; i < polygonCoordinates.length; i += 1) {
    const holeRing = polygonCoordinates[i];
    if (Array.isArray(holeRing) && holeRing.length >= 3 && ringContainsPoint(holeRing, lon, lat)) {
      return false;
    }
  }

  return true;
}

function geometryContainsPoint(geometry, lon, lat) {
  if (!geometry) return false;

  if (geometry.type === "Polygon") {
    return polygonContainsPoint(geometry.coordinates, lon, lat);
  }

  if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.some((poly) => polygonContainsPoint(poly, lon, lat));
  }

  return false;
}

function computeGeometryBbox(geometry) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let hasPoint = false;

  function walk(node) {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === "number" && typeof node[1] === "number") {
      const lon = node[0];
      const lat = node[1];
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        hasPoint = true;
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
      return;
    }

    for (const child of node) walk(child);
  }

  walk(geometry?.coordinates);
  if (!hasPoint) return null;
  return { west, south, east, north };
}

function bboxContainsPoint(bbox, lon, lat) {
  if (!bbox) return false;
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function featureAirspaceName(feature) {
  const props = feature?.properties || {};
  const id = feature?.id;
  if (typeof id === "string" && id.trim().length > 0) return id.trim();

  const candidates = [
    props.id,
    props.icao,
    props.ident,
    props.name,
    props.label,
    props.callsign,
    props.prefix,
    props.sector,
    props.sector_name
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }

  return null;
}

export class AirspaceMatcher {
  constructor() {
    this.features = [];
    this.lastLoadedAtMs = 0;
  }

  async load() {
    let data = null;
    let lastStatus = null;
    const FETCH_TIMEOUT_MS = 5000; // 5 second timeout for airspace fetch

    for (const url of AIRSPACE_URLS) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const response = await fetch(url, {
          headers: {
            "User-Agent": USER_AGENT
          },
          signal: controller.signal
        });
        clearTimeout(timer);

        lastStatus = response.status;
        if (!response.ok) continue;
        data = await response.json();
        break;
      } catch (error) {
        // Timeout or network error, try next URL
        continue;
      }
    }

    if (!data || !Array.isArray(data.features)) {
      throw new Error(`Failed to load airspace boundaries (status: ${lastStatus ?? "unknown"})`);
    }

    this.features = data.features
      .map((feature) => {
        const airspace = featureAirspaceName(feature);
        const geometry = feature?.geometry;
        const bbox = computeGeometryBbox(geometry);

        if (!airspace || !geometry || !bbox) return null;
        return { airspace, geometry, bbox };
      })
      .filter(Boolean);

    this.lastLoadedAtMs = Date.now();
  }

  async ensureFresh(maxAgeMs = 60 * 60 * 1000) {
    const ageMs = Date.now() - this.lastLoadedAtMs;
    if (this.features.length > 0 && ageMs < maxAgeMs) return;
    await this.load();
  }

  lookup(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    for (const feature of this.features) {
      if (!bboxContainsPoint(feature.bbox, lon, lat)) continue;
      if (geometryContainsPoint(feature.geometry, lon, lat)) {
        return feature.airspace;
      }
    }

    return null;
  }
}
