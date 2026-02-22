import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

function ensureSnapshotColumns(db) {
  const columns = db.prepare(`PRAGMA table_info(snapshots)`).all();
  const names = new Set(columns.map((c) => c.name));

  if (!names.has("altitude")) {
    db.exec(`ALTER TABLE snapshots ADD COLUMN altitude INTEGER`);
  }
  if (!names.has("groundspeed")) {
    db.exec(`ALTER TABLE snapshots ADD COLUMN groundspeed INTEGER`);
  }
  if (!names.has("heading")) {
    db.exec(`ALTER TABLE snapshots ADD COLUMN heading INTEGER`);
  }
  if (!names.has("airspace")) {
    db.exec(`ALTER TABLE snapshots ADD COLUMN airspace TEXT`);
  }
  if (!names.has("departure")) {
    db.exec(`ALTER TABLE snapshots ADD COLUMN departure TEXT`);
  }
  if (!names.has("destination")) {
    db.exec(`ALTER TABLE snapshots ADD COLUMN destination TEXT`);
  }
}

function buildAirportFilterClause(airports, departureColumn = "departure", destinationColumn = "destination") {
  const list = Array.isArray(airports)
    ? airports.filter((code) => typeof code === "string" && code.trim().length > 0)
    : [];

  if (list.length === 0) {
    return { clause: "", params: [] };
  }

  const placeholders = list.map(() => "?").join(",");
  return {
    clause: ` AND (${departureColumn} IN (${placeholders}) OR ${destinationColumn} IN (${placeholders}))`,
    params: [...list, ...list]
  };
}

function buildAltitudeFilterClause(minAltitude, maxAltitude) {
  if (!Number.isFinite(minAltitude) && !Number.isFinite(maxAltitude)) {
    return { clause: "", params: [] };
  }

  let clause = " AND (";
  const params = [];
  const conditions = [];

  if (Number.isFinite(minAltitude) && minAltitude >= 0) {
    conditions.push("altitude >= ?");
    params.push(minAltitude);
  }

  if (Number.isFinite(maxAltitude) && maxAltitude >= 0) {
    conditions.push("altitude <= ?");
    params.push(maxAltitude);
  }

  clause += conditions.join(" AND ") + ")";
  return { clause: conditions.length > 0 ? clause : "", params };
}

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      ts INTEGER NOT NULL,
      callsign TEXT NOT NULL,
      cid INTEGER,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      altitude INTEGER,
      groundspeed INTEGER,
      heading INTEGER,
      airspace TEXT,
      departure TEXT,
      destination TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts);
    CREATE INDEX IF NOT EXISTS idx_snapshots_callsign_ts ON snapshots(callsign, ts);
    
    CREATE TABLE IF NOT EXISTS atc_snapshots (
      ts INTEGER NOT NULL,
      callsign TEXT NOT NULL,
      cid INTEGER,
      frequency TEXT,
      facility INTEGER,
      lat REAL,
      lon REAL
    );
    CREATE INDEX IF NOT EXISTS idx_atc_snapshots_ts ON atc_snapshots(ts);
    CREATE INDEX IF NOT EXISTS idx_atc_snapshots_callsign_ts ON atc_snapshots(callsign, ts);
  `);
  ensureSnapshotColumns(db);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_airspace_ts ON snapshots(airspace, ts);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_departure_ts ON snapshots(departure, ts);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_destination_ts ON snapshots(destination, ts);`);
  return db;
}

export function insertSnapshots(db, ts, pilots) {
  const stmt = db.prepare(`
    INSERT INTO snapshots (ts, callsign, cid, lat, lon, altitude, groundspeed, heading, airspace, departure, destination)
    VALUES (@ts, @callsign, @cid, @lat, @lon, @altitude, @groundspeed, @heading, @airspace, @departure, @destination)
  `);
  const insertMany = db.transaction((rows) => {
    for (const r of rows) stmt.run(r);
  });
  const rows = pilots.map((p) => ({
    ts,
    callsign: p.callsign,
    cid: p.cid ?? null,
    lat: p.latitude,
    lon: p.longitude,
    altitude: p.altitude ?? null,
    groundspeed: p.groundspeed ?? null,
    heading: p.heading ?? null,
    airspace: p.airspace ?? null,
    departure: p.departure ?? null,
    destination: p.destination ?? null
  }));
  insertMany(rows);
  return rows.length;
}

export function pruneOld(db, cutoffTs) {
  const info = db.prepare(`DELETE FROM snapshots WHERE ts < ?`).run(cutoffTs);
  return info.changes ?? 0;
}

export function getCallsingsInRange(db, sinceTs, untilTs, limit = 2000, airspace = null, airports = [], minAltitude = null, maxAltitude = null) {
  let sql = `
      SELECT callsign, MIN(ts) AS firstSeen, MAX(ts) AS lastSeen, COUNT(*) AS points
      FROM snapshots
      WHERE ts BETWEEN ? AND ?
    `;

  const params = [sinceTs, untilTs];
  if (airspace && airspace.trim().length > 0) {
    sql += ` AND airspace = ?`;
    params.push(airspace);
  }

  const airportFilter = buildAirportFilterClause(airports);
  sql += airportFilter.clause;
  params.push(...airportFilter.params);

  const altitudeFilter = buildAltitudeFilterClause(minAltitude, maxAltitude);
  sql += altitudeFilter.clause;
  params.push(...altitudeFilter.params);

  sql += `
      GROUP BY callsign
      ORDER BY lastSeen DESC
      LIMIT ?
    `;
  params.push(limit);

  return db.prepare(sql).all(...params);
}

export function getTrack(db, callsign, sinceTs, untilTs, stepSeconds = 0, airspace = null, airports = [], minAltitude = null, maxAltitude = null) {
  // optional downsample: return at most one point per stepSeconds bucket
  if (stepSeconds && stepSeconds > 0) {
    let sql = `
      SELECT
        (ts / ?) * ? AS bucket,
        MIN(ts) AS ts,
        callsign,
        AVG(lat) AS lat,
        AVG(lon) AS lon,
        AVG(altitude) AS altitude,
        AVG(groundspeed) AS groundspeed,
        AVG(heading) AS heading,
        MAX(airspace) AS airspace,
        MAX(departure) AS departure,
        MAX(destination) AS destination
      FROM snapshots
      WHERE callsign = ? AND ts BETWEEN ? AND ?
    `;

    const params = [stepSeconds, stepSeconds, callsign, sinceTs, untilTs];
    if (airspace && airspace.trim().length > 0) {
      sql += ` AND airspace = ?`;
      params.push(airspace);
    }

    const airportFilter = buildAirportFilterClause(airports);
    sql += airportFilter.clause;
    params.push(...airportFilter.params);

    const altitudeFilter = buildAltitudeFilterClause(minAltitude, maxAltitude);
    sql += altitudeFilter.clause;
    params.push(...altitudeFilter.params);

    sql += `
      GROUP BY bucket
      ORDER BY ts ASC
    `;

    return db.prepare(sql).all(...params);
  }

  let sql = `
      SELECT ts, callsign, lat, lon, altitude, groundspeed, heading, airspace, departure, destination
      FROM snapshots
      WHERE callsign = ? AND ts BETWEEN ? AND ?
    `;
  const params = [callsign, sinceTs, untilTs];

  if (airspace && airspace.trim().length > 0) {
    sql += ` AND airspace = ?`;
    params.push(airspace);
  }

  const airportFilter = buildAirportFilterClause(airports);
  sql += airportFilter.clause;
  params.push(...airportFilter.params);

  const altitudeFilter = buildAltitudeFilterClause(minAltitude, maxAltitude);
  sql += altitudeFilter.clause;
  params.push(...altitudeFilter.params);

  sql += ` ORDER BY ts ASC`;
  return db.prepare(sql).all(...params);
}

export function getSnapshotAt(db, ts, windowSeconds = 10, airspace = null, airports = [], minAltitude = null, maxAltitude = null) {
  // nearest window around ts
  const from = ts - windowSeconds;
  const to = ts + windowSeconds;

  let sql = `
    SELECT ts, callsign, lat, lon, altitude, groundspeed, heading, airspace, departure, destination
    FROM snapshots
    WHERE ts BETWEEN ? AND ?
  `;
  const params = [from, to];

  if (airspace && airspace.trim().length > 0) {
    sql += ` AND airspace = ?`;
    params.push(airspace);
  }

  const airportFilter = buildAirportFilterClause(airports);
  sql += airportFilter.clause;
  params.push(...airportFilter.params);

  const altitudeFilter = buildAltitudeFilterClause(minAltitude, maxAltitude);
  sql += altitudeFilter.clause;
  params.push(...altitudeFilter.params);

  return db.prepare(sql).all(...params);
}

export function getAirspacesInRange(db, sinceTs, untilTs, limit = 2000) {
  return db.prepare(`
    SELECT airspace, COUNT(*) AS points
    FROM snapshots
    WHERE ts BETWEEN ? AND ? AND airspace IS NOT NULL AND airspace <> ''
    GROUP BY airspace
    ORDER BY points DESC, airspace ASC
    LIMIT ?
  `).all(sinceTs, untilTs, limit);
}

export function getAirportsInRange(db, sinceTs, untilTs, limit = 3000) {
  return db.prepare(`
    SELECT airport, COUNT(*) AS points
    FROM (
      SELECT departure AS airport
      FROM snapshots
      WHERE ts BETWEEN ? AND ? AND departure IS NOT NULL AND departure <> ''
      UNION ALL
      SELECT destination AS airport
      FROM snapshots
      WHERE ts BETWEEN ? AND ? AND destination IS NOT NULL AND destination <> ''
    )
    GROUP BY airport
    ORDER BY points DESC, airport ASC
    LIMIT ?
  `).all(sinceTs, untilTs, sinceTs, untilTs, limit);
}

export function getRangeMeta(db) {
  const row = db.prepare(`
    SELECT MIN(ts) AS minTs, MAX(ts) AS maxTs, COUNT(*) AS rows
    FROM snapshots
  `).get();
  return row ?? { minTs: null, maxTs: null, rows: 0 };
}

export function insertAtcSnapshots(db, ts, atcPositions) {
  const stmt = db.prepare(`
    INSERT INTO atc_snapshots (ts, callsign, cid, frequency, facility, lat, lon)
    VALUES (@ts, @callsign, @cid, @frequency, @facility, @lat, @lon)
  `);
  const insertMany = db.transaction((rows) => {
    for (const r of rows) stmt.run(r);
  });
  const rows = atcPositions.map((a) => ({
    ts,
    callsign: a.callsign,
    cid: a.cid ?? null,
    frequency: a.frequency ?? null,
    facility: a.facility ?? null,
    lat: a.latitude ?? null,
    lon: a.longitude ?? null
  }));
  insertMany(rows);
  return rows.length;
}

export function pruneOldAtc(db, cutoffTs) {
  const info = db.prepare(`DELETE FROM atc_snapshots WHERE ts < ?`).run(cutoffTs);
  return info.changes ?? 0;
}

export function getAtcSnapshotAt(db, ts, windowSeconds = 10) {
  // nearest window around ts
  const from = ts - windowSeconds;
  const to = ts + windowSeconds;
  return db.prepare(`
    SELECT ts, callsign, frequency, facility, lat, lon
    FROM atc_snapshots
    WHERE ts BETWEEN ? AND ?
  `).all(from, to);
}
