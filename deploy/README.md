# Production deployment (Docker Compose + Caddy)

Everything runs from the repository root with `docker compose -f deploy/docker-compose.prod.yml …` (written `$P` below). Tested locally on 2026-10-24 (Docker Desktop, Windows); the results are in `docs/PRODUCTION_READINESS.md`.

## What runs

| Service                   | Image                                                                            | Network           | Published                                                       |
| ------------------------- | -------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------- |
| `web`                     | `flight-delay-web` (Caddy 2.10 + the built dashboard)                            | frontend          | `127.0.0.1:8443` (HTTPS), `127.0.0.1:8080` (redirects to HTTPS) |
| `api`                     | `flight-delay-api` (Node 22, `server/dist/server.js`)                            | frontend, backend | no                                                              |
| `consumer`                | `flight-delay-api` (`server/dist/consume.js`)                                    | backend           | no                                                              |
| `kafka-init`              | `flight-delay-api` (`server/dist/kafka-init.js`): creates the topics, then exits | backend           | no                                                              |
| `mongo`                   | `mongo:7`, root user and app user                                                | backend           | no                                                              |
| `kafka`                   | `apache/kafka:4.3.1`, single node                                                | backend           | no                                                              |
| `tools` (profile `tools`) | the build stage: full source, every npm script                                   | backend           | no                                                              |

- **`backend` is an internal network.** It has no published port and no route out.
- **The API and the consumer** connect to MongoDB as `flight_app`, which has `readWrite` on `flight_delay` and nothing else.
- **The app containers** run as the unprivileged `node` user, with a read-only root filesystem, all Linux capabilities dropped and `no-new-privileges`.
- **The Docker secrets** are mounted under `/run/secrets`. No password is in any container's environment.

## 1. Secrets

```bash
bash deploy/make-secrets.sh
```

This writes the three secret files to `deploy/secrets/`, which is git-ignored:

- `mongo_root_password`: the MongoDB root user, used only for setup and restores;
- `mongo_app_password`: the app user;
- `mongodb_uri`: the connection string the API and consumer use.

Each password is 64 hex characters. The script refuses to overwrite existing files. On Linux, set the file owners it prints: uid 999 for MongoDB and uid 1000 for the app containers.

## 2. Build and start

```bash
docker compose -f deploy/docker-compose.prod.yml up -d --build --wait
```

- **First start:** MongoDB creates the root user and runs `mongo-init/10-create-app-user.sh` once, on an empty volume.
- **Topics:** `kafka-init` creates `flights.raw` and `flights.dlq`.
- **Readiness:** `--wait` returns when MongoDB, Kafka and the API are healthy.

## 3. Load the data

The API serves pre-aggregated collections, so the database must be loaded once. Use either option.

### Option A: restore a dump (about 4 minutes)

Use this to copy an existing build. For example, from the dev stack:

```bash
docker compose exec -T mongo mongodump --db flight_delay --archive --gzip > flight_delay.archive.gz
```

Then restore it as root. The password is read from the secret inside the container, so it never appears on a command line. The temporary config file is emptied afterwards.

```bash
$P exec -T mongo sh -c 'umask 077; printf "password: %s\n" "$(cat /run/secrets/mongo_root_password)" > /tmp/restore.yaml; mongorestore --config /tmp/restore.yaml --username root --authenticationDatabase admin --archive --gzip --nsInclude "flight_delay.*"; : > /tmp/restore.yaml' < flight_delay.archive.gz
```

### Option B: build from the CSVs

The raw files from the main README must be in `data/raw/`. These run as the app user. The same steps were measured in the dev setup (main README). In this stack only `stream:replay` from the tools image was run, so treat the rest as untested here.

```bash
$P --profile tools run --rm tools ingest -- --drop
$P --profile tools run --rm tools resolve:airport-ids -- --apply
$P --profile tools run --rm tools build:indexes
$P --profile tools run --rm tools build:stats
$P --profile tools run --rm tools build:lookup
$P --profile tools run --rm tools ml:register
```

### After either option

Restart the API, so its startup check compares `delay_lookup` with the served model:

```bash
$P restart api
```

## 4. Check it

```bash
curl --cacert caddy-root.crt https://localhost:8443/api/health
```

- **Expected answer:** `{"status":"ok","mongo":"up","modelLoaded":true,"kafka":"up"}`.
- **The local certificate:** it comes from Caddy's internal CA. Copy the root out with:

  ```bash
  docker cp "$($P ps -q web)":/data/caddy/pki/authorities/local/root.crt caddy-root.crt
  ```

- **On Windows:** curl (Schannel) also needs `--ssl-no-revoke`, because a private CA publishes no revocation list.
- **Browsers:** they reject this CA until it is trusted. That is expected for a local stack.

## 5. Streaming (optional)

The consumer is always running. To replay December through Kafka:

```bash
$P --profile tools run --rm tools stream:replay -- --month 12 --rate 1000
```

## Configuration

These variables are read by Compose from the shell or from a `deploy/.env` file:

| Variable                  | Default                  | Purpose                                                                                                                           |
| ------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `SITE_ADDRESS`            | `localhost:8443`         | Host (and port) Caddy answers on                                                                                                  |
| `TLS_ISSUER`              | `internal`               | `internal` = Caddy's local CA; an email address = a public certificate via ACME (needs a real domain with ports 80/443 reachable) |
| `PUBLIC_ORIGIN`           | `https://localhost:8443` | The API's `CORS_ORIGIN`                                                                                                           |
| `PUBLISH_HOST`            | `127.0.0.1`              | Interface Caddy's ports bind to. Only change it for a deliberate public deployment                                                |
| `HTTPS_PORT`, `HTTP_PORT` | `8443`, `8080`           | Host ports                                                                                                                        |

The API trusts exactly one proxy hop (`TRUST_PROXY_HOPS=1`, Caddy). A client cannot forge its rate-limit key through `X-Forwarded-For`.

## Not covered here

- **Kafka has no authentication.** It relies on the internal network, so do not publish its port.
- **Kafka has no fault tolerance:** one broker, replication factor 1.
- **No backups are scheduled.** Use `mongodump` as above.
- **No monitoring or log shipping.** Containers log to stdout.
- **A public deployment** needs a real domain, `TLS_ISSUER` set to an email address, `PUBLISH_HOST=0.0.0.0` and the ports opened. It was not done.
