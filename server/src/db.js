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

function ensureEventColumns(db) {
  const columns = db.prepare(`PRAGMA table_info(events)`).all();
  const names = new Set(columns.map((c) => c.name));

  if (!names.has("start_ts")) {
    db.exec(`ALTER TABLE events ADD COLUMN start_ts INTEGER`);
  }
  if (!names.has("end_ts")) {
    db.exec(`ALTER TABLE events ADD COLUMN end_ts INTEGER`);
  }

  db.exec(`
    UPDATE events
    SET
      start_ts = CASE
        WHEN start_time IS NOT NULL AND start_time <> '' THEN CAST(strftime('%s', start_time) AS INTEGER)
        ELSE NULL
      END,
      end_ts = CASE
        WHEN end_time IS NOT NULL AND end_time <> '' THEN CAST(strftime('%s', end_time) AS INTEGER)
        ELSE NULL
      END
    WHERE start_ts IS NULL OR end_ts IS NULL
  `);
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

function buildAirspaceFilterClause(airspaces) {
  const list = Array.isArray(airspaces)
    ? airspaces.filter((code) => typeof code === "string" && code.trim().length > 0)
    : [];

  if (list.length === 0) {
    return { clause: "", params: [] };
  }

  const placeholders = list.map(() => "?").join(",");
  return {
    clause: ` AND airspace IN (${placeholders})`,
    params: list
  };
}

function recomputeSnapshotStats(db) {
  const row = db.prepare(`
    SELECT MIN(ts) AS minTs, MAX(ts) AS maxTs, COUNT(*) AS rows
    FROM snapshots
  `).get() ?? { minTs: null, maxTs: null, rows: 0 };

  db.prepare(`
    INSERT INTO snapshot_stats (id, min_ts, max_ts, row_count)
    VALUES (1, @minTs, @maxTs, @rows)
    ON CONFLICT(id) DO UPDATE SET
      min_ts = excluded.min_ts,
      max_ts = excluded.max_ts,
      row_count = excluded.row_count
  `).run({
    minTs: row.minTs ?? null,
    maxTs: row.maxTs ?? null,
    rows: row.rows ?? 0
  });

  return row;
}

function ensureSnapshotStats(db) {
  const stats = db.prepare(`
    SELECT min_ts AS minTs, max_ts AS maxTs, row_count AS rows
    FROM snapshot_stats
    WHERE id = 1
  `).get();

  if (!stats) {
    recomputeSnapshotStats(db);
  }
}

function incrementSnapshotStats(db, ts, rowCount) {
  if (!Number.isFinite(ts) || !Number.isFinite(rowCount) || rowCount <= 0) {
    return;
  }

  db.prepare(`
    INSERT INTO snapshot_stats (id, min_ts, max_ts, row_count)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      min_ts = CASE
        WHEN snapshot_stats.min_ts IS NULL OR excluded.min_ts < snapshot_stats.min_ts THEN excluded.min_ts
        ELSE snapshot_stats.min_ts
      END,
      max_ts = CASE
        WHEN snapshot_stats.max_ts IS NULL OR excluded.max_ts > snapshot_stats.max_ts THEN excluded.max_ts
        ELSE snapshot_stats.max_ts
      END,
      row_count = snapshot_stats.row_count + excluded.row_count
  `).run(ts, ts, rowCount);
}

function decrementSnapshotStats(db, cutoffTs, removedCount) {
  if (!Number.isFinite(removedCount) || removedCount <= 0) {
    return;
  }

  const current = db.prepare(`
    SELECT min_ts AS minTs, max_ts AS maxTs, row_count AS rows
    FROM snapshot_stats
    WHERE id = 1
  `).get() ?? { minTs: null, maxTs: null, rows: 0 };

  const nextRows = Math.max(0, (current.rows ?? 0) - removedCount);
  let nextMinTs = current.minTs ?? null;
  let nextMaxTs = current.maxTs ?? null;

  if (nextRows === 0) {
    nextMinTs = null;
    nextMaxTs = null;
  } else if (nextMinTs != null && Number.isFinite(cutoffTs) && nextMinTs < cutoffTs) {
    nextMinTs = db.prepare(`SELECT MIN(ts) AS minTs FROM snapshots`).get()?.minTs ?? null;
  }

  db.prepare(`
    INSERT INTO snapshot_stats (id, min_ts, max_ts, row_count)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      min_ts = excluded.min_ts,
      max_ts = excluded.max_ts,
      row_count = excluded.row_count
  `).run(nextMinTs, nextMaxTs, nextRows);
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
    CREATE TABLE IF NOT EXISTS snapshot_stats (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      min_ts INTEGER,
      max_ts INTEGER,
      row_count INTEGER NOT NULL DEFAULT 0
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

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      type TEXT,
      name TEXT NOT NULL,
      link TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      start_ts INTEGER,
      end_ts INTEGER,
      short_description TEXT,
      description TEXT,
      banner TEXT,
      organisers_json TEXT,
      airports_json TEXT,
      routes_json TEXT,
      last_seen_ts INTEGER NOT NULL,
      created_ts INTEGER NOT NULL,
      updated_ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_start_time ON events(start_time);
    CREATE INDEX IF NOT EXISTS idx_events_end_time ON events(end_time);
    CREATE INDEX IF NOT EXISTS idx_events_last_seen_ts ON events(last_seen_ts);
  `);
  ensureSnapshotColumns(db);
  ensureEventColumns(db);
  ensureSnapshotStats(db);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_airspace_ts ON snapshots(airspace, ts);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_departure_ts ON snapshots(departure, ts);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_destination_ts ON snapshots(destination, ts);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_ts_airspace ON snapshots(ts, airspace);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_ts_departure ON snapshots(ts, departure);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_ts_destination ON snapshots(ts, destination);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_ts_callsign ON snapshots(ts, callsign);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_start_ts ON events(start_ts);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_end_ts ON events(end_ts);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_start_ts_end_ts ON events(start_ts, end_ts);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_start_time_end_time ON events(start_time, end_time);`);
  return db;
}

export function upsertEvents(db, events, seenTs) {
  if (!Array.isArray(events) || events.length === 0) return 0;

  const stmt = db.prepare(`
    INSERT INTO events (
      id,
      type,
      name,
      link,
      start_time,
      end_time,
      start_ts,
      end_ts,
      short_description,
      description,
      banner,
      organisers_json,
      airports_json,
      routes_json,
      last_seen_ts,
      created_ts,
      updated_ts
    ) VALUES (
      @id,
      @type,
      @name,
      @link,
      @start_time,
      @end_time,
      @start_ts,
      @end_ts,
      @short_description,
      @description,
      @banner,
      @organisers_json,
      @airports_json,
      @routes_json,
      @last_seen_ts,
      @created_ts,
      @updated_ts
    )
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      name = excluded.name,
      link = excluded.link,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      start_ts = excluded.start_ts,
      end_ts = excluded.end_ts,
      short_description = excluded.short_description,
      description = excluded.description,
      banner = excluded.banner,
      organisers_json = excluded.organisers_json,
      airports_json = excluded.airports_json,
      routes_json = excluded.routes_json,
      last_seen_ts = excluded.last_seen_ts,
      updated_ts = excluded.updated_ts
  `);

  const run = db.transaction((rows) => {
    let changes = 0;
    for (const e of rows) {
      if (!Number.isFinite(e?.id)) continue;
      if (typeof e?.name !== "string" || e.name.trim().length === 0) continue;
      if (!e?.start_time || !e?.end_time) continue;

      const startTs = Number.isFinite(Date.parse(e.start_time))
        ? Math.floor(Date.parse(e.start_time) / 1000)
        : null;
      const endTs = Number.isFinite(Date.parse(e.end_time))
        ? Math.floor(Date.parse(e.end_time) / 1000)
        : null;

      const info = stmt.run({
        id: e.id,
        type: e.type ?? null,
        name: e.name,
        link: e.link ?? null,
        start_time: e.start_time,
        end_time: e.end_time,
        start_ts: startTs,
        end_ts: endTs,
        short_description: e.short_description ?? null,
        description: e.description ?? null,
        banner: e.banner ?? null,
        organisers_json: JSON.stringify(Array.isArray(e.organisers) ? e.organisers : []),
        airports_json: JSON.stringify(Array.isArray(e.airports) ? e.airports : []),
        routes_json: JSON.stringify(Array.isArray(e.routes) ? e.routes : []),
        last_seen_ts: seenTs,
        created_ts: seenTs,
        updated_ts: seenTs
      });
      changes += info?.changes ?? 0;
    }
    return changes;
  });

  return run(events) ?? 0;
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
  incrementSnapshotStats(db, ts, rows.length);
  return rows.length;
}

export function pruneOld(db, cutoffTs) {
  let total = 0;
  while (true) {
    const deleted = pruneOldBatch(db, cutoffTs, 5000);
    total += deleted;
    if (deleted === 0) break;
  }
  return total;
}

export function pruneOldBatch(db, cutoffTs, batchSize = 5000) {
  const safeBatchSize = Number.isFinite(batchSize) ? Math.max(1, Math.min(100000, Math.floor(batchSize))) : 5000;
  const info = db.prepare(`
    DELETE FROM snapshots
    WHERE rowid IN (
      SELECT s.rowid
      FROM snapshots s
      WHERE s.ts < ?
        AND NOT EXISTS (
          SELECT 1
          FROM events e
          WHERE e.start_ts IS NOT NULL
            AND e.end_ts IS NOT NULL
            AND e.start_ts <= e.end_ts
            AND s.ts BETWEEN e.start_ts AND e.end_ts
        )
      ORDER BY s.ts ASC
      LIMIT ?
    )
  `).run(cutoffTs, safeBatchSize);
  decrementSnapshotStats(db, cutoffTs, info.changes ?? 0);
  return info.changes ?? 0;
}

export function getCallsingsInRange(db, sinceTs, untilTs, limit = 2000, airspaces = [], airports = [], minAltitude = null, maxAltitude = null) {
  let sql = `
      SELECT callsign, MIN(ts) AS firstSeen, MAX(ts) AS lastSeen, COUNT(*) AS points
      FROM snapshots
      WHERE ts BETWEEN ? AND ?
    `;

  const params = [sinceTs, untilTs];
  
  const airspaceFilter = buildAirspaceFilterClause(airspaces);
  sql += airspaceFilter.clause;
  params.push(...airspaceFilter.params);

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

export function getTrack(db, callsign, sinceTs, untilTs, stepSeconds = 0, airspaces = [], airports = [], minAltitude = null, maxAltitude = null) {
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
    
    const airspaceFilter = buildAirspaceFilterClause(airspaces);
    sql += airspaceFilter.clause;
    params.push(...airspaceFilter.params);

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

  const airspaceFilter = buildAirspaceFilterClause(airspaces);
  sql += airspaceFilter.clause;
  params.push(...airspaceFilter.params);

  const airportFilter = buildAirportFilterClause(airports);
  sql += airportFilter.clause;
  params.push(...airportFilter.params);

  const altitudeFilter = buildAltitudeFilterClause(minAltitude, maxAltitude);
  sql += altitudeFilter.clause;
  params.push(...altitudeFilter.params);

  sql += ` ORDER BY ts ASC`;
  return db.prepare(sql).all(...params);
}

export function getSnapshotAt(db, ts, windowSeconds = 10, airspaces = [], airports = [], minAltitude = null, maxAltitude = null) {
  // nearest window around ts
  const from = ts - windowSeconds;
  const to = ts + windowSeconds;

  let sql = `
    SELECT ts, callsign, lat, lon, altitude, groundspeed, heading, airspace, departure, destination
    FROM snapshots
    WHERE ts BETWEEN ? AND ?
  `;
  const params = [from, to];

  const airspaceFilter = buildAirspaceFilterClause(airspaces);
  sql += airspaceFilter.clause;
  params.push(...airspaceFilter.params);

  const airportFilter = buildAirportFilterClause(airports);
  sql += airportFilter.clause;
  params.push(...airportFilter.params);

  const altitudeFilter = buildAltitudeFilterClause(minAltitude, maxAltitude);
  sql += altitudeFilter.clause;
  params.push(...altitudeFilter.params);

  return db.prepare(sql).all(...params);
}

export function getSnapshotsBetween(db, sinceTs, untilTs, airspaces = [], airports = [], minAltitude = null, maxAltitude = null) {
  let sql = `
    SELECT ts, callsign, lat, lon, altitude, groundspeed, heading, airspace, departure, destination
    FROM snapshots
    WHERE ts BETWEEN ? AND ?
  `;
  const params = [sinceTs, untilTs];

  const airspaceFilter = buildAirspaceFilterClause(airspaces);
  sql += airspaceFilter.clause;
  params.push(...airspaceFilter.params);

  const airportFilter = buildAirportFilterClause(airports);
  sql += airportFilter.clause;
  params.push(...airportFilter.params);

  const altitudeFilter = buildAltitudeFilterClause(minAltitude, maxAltitude);
  sql += altitudeFilter.clause;
  params.push(...altitudeFilter.params);

  sql += ` ORDER BY ts ASC`;
  return db.prepare(sql).all(...params);
}

export function getSnapshotTimestampsInRange(db, sinceTs, untilTs) {
  return db.prepare(`
    SELECT DISTINCT ts
    FROM snapshots
    WHERE ts BETWEEN ? AND ?
    ORDER BY ts ASC
  `).all(sinceTs, untilTs).map((r) => r.ts);
}

export function getSnapshotsAtTimestamps(db, timestamps, airspaces = [], airports = [], minAltitude = null, maxAltitude = null) {
  if (!Array.isArray(timestamps) || timestamps.length === 0) return [];

  const placeholders = timestamps.map(() => "?").join(",");
  let sql = `
    SELECT ts, callsign, lat, lon, altitude, groundspeed, heading, airspace, departure, destination
    FROM snapshots
    WHERE ts IN (${placeholders})
  `;
  const params = [...timestamps];

  const airspaceFilter = buildAirspaceFilterClause(airspaces);
  sql += airspaceFilter.clause;
  params.push(...airspaceFilter.params);

  const airportFilter = buildAirportFilterClause(airports);
  sql += airportFilter.clause;
  params.push(...airportFilter.params);

  const altitudeFilter = buildAltitudeFilterClause(minAltitude, maxAltitude);
  sql += altitudeFilter.clause;
  params.push(...altitudeFilter.params);

  sql += ` ORDER BY ts ASC`;
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
    SELECT airport, SUM(points) AS points
    FROM (
      SELECT departure AS airport, COUNT(*) AS points
      FROM snapshots
      WHERE ts BETWEEN ? AND ? AND departure IS NOT NULL AND departure <> ''
      GROUP BY departure
      UNION ALL
      SELECT destination AS airport, COUNT(*) AS points
      FROM snapshots
      WHERE ts BETWEEN ? AND ? AND destination IS NOT NULL AND destination <> ''
      GROUP BY destination
    )
    WHERE airport IS NOT NULL AND airport <> ''
    GROUP BY airport
    ORDER BY points DESC, airport ASC
    LIMIT ?
  `).all(sinceTs, untilTs, sinceTs, untilTs, limit);
}

export function getRangeMeta(db) {
  const row = db.prepare(`
    SELECT min_ts AS minTs, max_ts AS maxTs, row_count AS rows
    FROM snapshot_stats
    WHERE id = 1
  `).get();

  if (!row) {
    return recomputeSnapshotStats(db);
  }

  return row;
}

export function getStoredEvents(db, fromIso = null, toIso = null, limit = 200, onlyWithData = true) {
  const params = [];
  let where = "WHERE 1=1";

  if (typeof fromIso === "string" && fromIso.trim().length > 0) {
    where += " AND end_time >= ?";
    params.push(fromIso.trim());
  }
  if (typeof toIso === "string" && toIso.trim().length > 0) {
    where += " AND start_time <= ?";
    params.push(toIso.trim());
  }

  if (onlyWithData) {
    where += `
      AND (
        EXISTS (
          SELECT 1 FROM snapshots s
          WHERE events.start_ts IS NOT NULL
            AND events.end_ts IS NOT NULL
            AND events.start_ts <= events.end_ts
            AND s.ts BETWEEN events.start_ts AND events.end_ts
          LIMIT 1
        )
        OR EXISTS (
          SELECT 1 FROM atc_snapshots a
          WHERE events.start_ts IS NOT NULL
            AND events.end_ts IS NOT NULL
            AND events.start_ts <= events.end_ts
            AND a.ts BETWEEN events.start_ts AND events.end_ts
          LIMIT 1
        )
      )
    `;
  }

  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(2000, limit)) : 200;
  params.push(safeLimit);

  const rows = db.prepare(`
    SELECT
      id,
      type,
      name,
      link,
      start_time,
      end_time,
      short_description,
      description,
      banner,
      organisers_json,
      airports_json,
      routes_json,
      last_seen_ts,
      created_ts,
      updated_ts
    FROM events
    ${where}
    ORDER BY start_time DESC
    LIMIT ?
  `).all(...params);

  return rows.map((row) => ({
    ...row,
    organisers: safeJsonParseArray(row.organisers_json),
    airports: safeJsonParseArray(row.airports_json),
    routes: safeJsonParseArray(row.routes_json)
  }));
}

function safeJsonParseArray(value) {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
  let total = 0;
  while (true) {
    const deleted = pruneOldAtcBatch(db, cutoffTs, 5000);
    total += deleted;
    if (deleted === 0) break;
  }
  return total;
}

export function pruneOldAtcBatch(db, cutoffTs, batchSize = 5000) {
  const safeBatchSize = Number.isFinite(batchSize) ? Math.max(1, Math.min(100000, Math.floor(batchSize))) : 5000;
  const info = db.prepare(`
    DELETE FROM atc_snapshots
    WHERE rowid IN (
      SELECT a.rowid
      FROM atc_snapshots a
      WHERE a.ts < ?
        AND NOT EXISTS (
          SELECT 1
          FROM events e
          WHERE e.start_ts IS NOT NULL
            AND e.end_ts IS NOT NULL
            AND e.start_ts <= e.end_ts
            AND a.ts BETWEEN e.start_ts AND e.end_ts
        )
      ORDER BY a.ts ASC
      LIMIT ?
    )
  `).run(cutoffTs, safeBatchSize);
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

export function getAtcSnapshotsBetween(db, sinceTs, untilTs) {
  return db.prepare(`
    SELECT ts, callsign, frequency, facility, lat, lon
    FROM atc_snapshots
    WHERE ts BETWEEN ? AND ?
    ORDER BY ts ASC
  `).all(sinceTs, untilTs);
}

export function getAtcSnapshotsAtTimestamps(db, timestamps) {
  if (!Array.isArray(timestamps) || timestamps.length === 0) return [];
  const placeholders = timestamps.map(() => "?").join(",");
  return db.prepare(`
    SELECT ts, callsign, frequency, facility, lat, lon
    FROM atc_snapshots
    WHERE ts IN (${placeholders})
    ORDER BY ts ASC
  `).all(...timestamps);
}
