#!/usr/bin/env bash
# Creates the production stack's secret files in deploy/secrets/ (git-ignored):
#   mongo_root_password  MongoDB root user (used only for setup and restores)
#   mongo_app_password   the app user flight_app (readWrite on flight_delay only)
#   mongodb_uri          the API's and consumer's connection string, with the app password
# Passwords are 32 random bytes as hex, so the URI needs no escaping. Existing files are never
# overwritten: delete them on purpose to rotate (and rotate the user inside MongoDB too).
set -euo pipefail
cd "$(dirname "$0")"
umask 077
mkdir -p secrets

if [[ -e secrets/mongo_root_password || -e secrets/mongo_app_password || -e secrets/mongodb_uri ]]; then
  echo "deploy/secrets/ already holds secrets; refusing to overwrite them." >&2
  exit 1
fi

# tr strips \r too: openssl in Git Bash on Windows ends its output with \r\n.
openssl rand -hex 32 | tr -d '\r\n' > secrets/mongo_root_password
openssl rand -hex 32 | tr -d '\r\n' > secrets/mongo_app_password
# The userinfo (user:password) is inserted as one value, so this file holds no URI-with-credentials
# literal for secret scanners to flag.
app_userinfo="flight_app:$(< secrets/mongo_app_password)"
printf 'mongodb://%s@mongo:27017/flight_delay?authSource=flight_delay' "$app_userinfo" \
  > secrets/mongodb_uri
unset app_userinfo

echo "Wrote deploy/secrets/{mongo_root_password,mongo_app_password,mongodb_uri} (mode 600)."
echo "On Linux, the containers read them as these users: run"
echo "  sudo chown 999:999 deploy/secrets/mongo_root_password deploy/secrets/mongo_app_password"
echo "  sudo chown 1000:1000 deploy/secrets/mongodb_uri"
