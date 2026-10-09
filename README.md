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

Start the Express API and Vite frontend together:

```sh
npm run dev
```

The API listens on `http://localhost:3001`; the frontend listens on `http://localhost:3000` and proxies `/api` requests to the API.

## Useful commands

```sh
npm run typecheck
npm run lint
npm test
npm run build:web
```

The dataset is kept under `data/` and is not tracked by Git. Download and add it there manually when a later project phase needs it.
