# VATSIM Traffic Replay (24h)

A simple website that **records all VATSIM pilot positions** (callsign + position + basic telemetry) from:

- https://data.vatsim.net/v3/vatsim-data.json

…and lets you **replay up to 24 hours** of traffic on a map.

## What it does
- Backend polls VATSIM every `POLL_INTERVAL_SECONDS` (default 15s)
- Stores each pilot snapshot into SQLite
- Automatically prunes data older than 24 hours
- Frontend map + timeline slider + play/pause
- Two modes:
  - **All traffic** replay: shows all pilots at the selected time (fetches snapshot per step)
  - **Track a callsign**: shows a single aircraft path and animates it

## Quick start (dev)

### 1) Install
```bash
npm install
```

### 2) Run
```bash
npm run dev
```

- Client: http://localhost:5173
- Server: http://localhost:4000

The server will create `server/data/vatsim.sqlite` automatically.

## Production build
```bash
npm run build
npm start
```

Server will serve the built client automatically.

## Config (server/.env)
Copy `server/.env.example` to `server/.env` if you want to customize:
- `PORT` (default 4000)
- `POLL_INTERVAL_SECONDS` (default 15)
- `RETENTION_HOURS` (default 24)
- `DB_PATH` (default `./data/vatsim.sqlite`)

## Railway persistence

Railway containers are ephemeral across redeploys, so SQLite must be placed on a mounted volume.

1. Attach a Railway Volume and mount it (commonly `/data`).
2. Set `DB_PATH=/data/vatsim.sqlite` in service variables.

If `DB_PATH` is not set, the server now auto-detects Railway volume mounts in this order:
- `RAILWAY_VOLUME_MOUNT_PATH/vatsim.sqlite`
- `/data/vatsim.sqlite` (if `/data` exists)
- fallback to local `server/data/vatsim.sqlite`
