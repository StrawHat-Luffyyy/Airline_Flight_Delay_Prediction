# Flight Delay Prediction

College Big Data project scaffold for the 2015 Flight Delays and Cancellations dataset.

## Prerequisites

- Node.js 20 or newer and npm
- Docker Desktop with Docker Compose

## Setup

From the repository root, create the local environment file and install the workspaces:

```powershell
Copy-Item .env.example .env
npm install
```

Start the local MongoDB service:

```sh
docker compose up -d mongo
```

Download the dataset into `data/raw/` (see [scripts/download-data.md](scripts/download-data.md)), then load it into MongoDB:

```sh
npm run ingest            # first load; refuses if flights already has data
npm run ingest -- --drop  # rebuild from scratch
```

Other flags: `--append` adds to existing data, `--limit N` loads only the first N flight rows, and `--dir PATH` reads the CSVs from another folder. Each run is recorded in the `ingest_runs` collection.

### Data pipeline order

Run these in order after downloading the data (later steps arrive with later phases):

1. `npm run ingest -- --drop`: load the CSVs.
2. `npm run resolve:airport-ids -- --apply`: map October's numeric BTS airport ids to IATA codes. Without `--apply` it only reports. The raw ids are kept in `originAirportId` / `destAirportId`. The mapping and its evidence are written to `docs/airport-id-map.json` and the `resolve_runs` collection.
3. `npm run build:indexes`
4. `npm run build:stats`
5. `npm run build:lookup`

Re-running `ingest -- --drop` brings back the numeric ids, so run step 2 again after every re-ingest.

Start the Express API and Vite frontend together:

```sh
npm run dev
```

The API listens on `http://localhost:3001`; the frontend listens on `http://localhost:5173` and proxies `/api` requests to the API.

## Useful commands

```sh
npm run typecheck
npm run lint
npm run format:check   # npm run format to fix
npm test
npm run build:web
```

The dataset is kept under `data/` and is not tracked by Git.
