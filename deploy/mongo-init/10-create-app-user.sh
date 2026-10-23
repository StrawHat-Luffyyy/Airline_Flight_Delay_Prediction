#!/bin/bash
# Runs once, when the MongoDB volume is first initialised (docker-entrypoint-initdb.d). The official
# entrypoint sources this file after creating the root user, so "${mongo[@]}" is a shell already
# authenticated as root against the temporary init server.
#
# Creates the application user: readWrite on the app database only (the API, the Kafka consumer and
# the batch jobs need nothing more). The password comes from the Docker secret and is passed to
# mongosh through the environment, never on its command line.
set -euo pipefail

export APP_DB="${MONGO_APP_DB:-flight_delay}"
export APP_USER="${MONGO_APP_USER:-flight_app}"
APP_PASSWORD="$(< /run/secrets/mongo_app_password)"
export APP_PASSWORD

# Sourced (a non-executable file), the entrypoint's authenticated shell "${mongo[@]}" is available.
# Executed (some bind mounts mark every file executable), connect as root ourselves.
if declare -p mongo > /dev/null 2>&1; then
  shell=("${mongo[@]}")
else
  shell=(mongosh --host 127.0.0.1 --quiet --username "$MONGO_INITDB_ROOT_USERNAME"
    --password "$(< "$MONGO_INITDB_ROOT_PASSWORD_FILE")" --authenticationDatabase admin)
fi

"${shell[@]}" admin --eval '
  const app = db.getSiblingDB(process.env.APP_DB);
  app.createUser({
    user: process.env.APP_USER,
    pwd: process.env.APP_PASSWORD,
    roles: [{ role: "readWrite", db: process.env.APP_DB }],
  });
  print(`created user ${process.env.APP_USER} with readWrite on ${process.env.APP_DB}`);
'
unset APP_PASSWORD
