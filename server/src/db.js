import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
      heading INTEGER
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
  return db;
}

export function insertSnapshots(db, ts, pilots) {
  const stmt = db.prepare(`
    INSERT INTO snapshots (ts, callsign, cid, lat, lon, altitude, groundspeed, heading)
    VALUES (@ts, @callsign, @cid, @lat, @lon, @altitude, @groundspeed, @heading)
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
    heading: p.heading ?? null
  }));
  insertMany(rows);
  return rows.length;
}

export function pruneOld(db, cutoffTs) {
  const info = db.prepare(`DELETE FROM snapshots WHERE ts < ?`).run(cutoffTs);
  return info.changes ?? 0;
}

export function getCallsingsInRange(db, sinceTs, untilTs, limit = 2000) {
  return db.prepare(`
    SELECT callsign, MIN(ts) AS firstSeen, MAX(ts) AS lastSeen, COUNT(*) AS points
    FROM snapshots
    WHERE ts BETWEEN ? AND ?
    GROUP BY callsign
    ORDER BY lastSeen DESC
    LIMIT ?
  `).all(sinceTs, untilTs, limit);
}

export function getTrack(db, callsign, sinceTs, untilTs, stepSeconds = 0) {
  // optional downsample: return at most one point per stepSeconds bucket
  if (stepSeconds && stepSeconds > 0) {
    return db.prepare(`
      SELECT
        (ts / ?) * ? AS bucket,
        MIN(ts) AS ts,
        callsign,
        AVG(lat) AS lat,
        AVG(lon) AS lon,
        AVG(altitude) AS altitude,
        AVG(groundspeed) AS groundspeed,
        AVG(heading) AS heading
      FROM snapshots
      WHERE callsign = ? AND ts BETWEEN ? AND ?
      GROUP BY bucket
      ORDER BY ts ASC
    `).all(stepSeconds, stepSeconds, callsign, sinceTs, untilTs);
  }

  return db.prepare(`
    SELECT ts, callsign, lat, lon, altitude, groundspeed, heading
    FROM snapshots
    WHERE callsign = ? AND ts BETWEEN ? AND ?
    ORDER BY ts ASC
  `).all(callsign, sinceTs, untilTs);
}

export function getSnapshotAt(db, ts, windowSeconds = 10) {
  // nearest window around ts
  const from = ts - windowSeconds;
  const to = ts + windowSeconds;
  return db.prepare(`
    SELECT ts, callsign, lat, lon, altitude, groundspeed, heading
    FROM snapshots
    WHERE ts BETWEEN ? AND ?
  `).all(from, to);
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
