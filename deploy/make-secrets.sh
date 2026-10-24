#!/usr/bin/env bash
# Creates the production stack's secrets in deploy/secrets/ (git-ignored). Every piece is created
# only if missing and never overwritten, so the script is safe to re-run, for example to add the
# Kafka secrets to an existing deployment. Delete a file on purpose to rotate it (and rotate the
# matching user inside MongoDB or Kafka too).
#
#   mongo_root_password      MongoDB root user (setup and restores only)
#   mongo_app_password       MongoDB app user flight_app (readWrite on flight_delay only)
#   mongodb_uri              the app's MongoDB connection string, with the app password
#   kafka_app_password       Kafka user flight_app (ACLs on the speed layer's topics and group)
#   kafka_ca.crt             CA that signed the brokers' TLS certificate (given to the app)
#   kafka/                   mounted into the brokers and kafka-setup at /etc/kafka/secrets:
#     ca.crt                   the CA again (the brokers' PEM truststore)
#     broker.p12               the brokers' key and certificate (names kafka1, kafka2, kafka3)
#     keystore_creds, key_creds  the keystore password
#     admin_password           Kafka super-user admin (brokers and kafka-setup)
#     kafka_server_jaas.conf   SASL/PLAIN users, with passwords
#     admin.properties         client config for Kafka's CLI tools, as admin
#   ca/ca.key                CA private key: never mounted into any container
#
# Passwords are 32 random bytes as hex (no escaping needed anywhere).
#
# Usage: bash deploy/make-secrets.sh [--fix-owners]
# On a Linux host, run it as root (sudo) and it also sets the owners the containers run as:
# 999 (mongodb) for the MongoDB passwords, 1000 (node, Kafka's appuser) for the rest. --fix-owners
# only does that, for secrets that already exist. Docker Desktop (Windows, macOS) needs neither.
set -euo pipefail
cd "$(dirname "$0")"
umask 077
# Git Bash on Windows would rewrite the openssl -subj argument "/CN=..." as a path.
export MSYS_NO_PATHCONV=1

fix_owners() {
  if [[ "$(uname -s)" != Linux ]]; then
    echo "Not Linux: file owners are not used by Docker Desktop bind mounts; nothing to change."
    return
  fi
  if [[ "$(id -u)" != 0 ]]; then
    echo "On Linux the containers need these owners; re-run as root to set them:" >&2
    echo "  sudo bash deploy/make-secrets.sh --fix-owners" >&2
    return 1
  fi
  chown 999:999 secrets/mongo_root_password secrets/mongo_app_password
  chmod 400 secrets/mongo_root_password secrets/mongo_app_password
  chown 1000:1000 secrets/mongodb_uri secrets/kafka_app_password secrets/kafka_ca.crt
  chmod 400 secrets/mongodb_uri secrets/kafka_app_password
  chmod 444 secrets/kafka_ca.crt
  chown -R 1000:1000 secrets/kafka
  chmod 500 secrets/kafka
  chmod 400 secrets/kafka/*
  chown -R root:root secrets/ca
  chmod 700 secrets/ca
  chmod 400 secrets/ca/ca.key
  echo "Set owners: 999 for the MongoDB passwords, 1000 for the app and Kafka secrets."
}

if [[ "${1-}" == --fix-owners ]]; then
  fix_owners
  exit
fi

mkdir -p secrets/kafka secrets/ca
created=()

random_hex() {
  # tr strips \r too: openssl in Git Bash on Windows ends its output with \r\n.
  openssl rand -hex 32 | tr -d '\r\n'
}

new_password() {
  local file=$1
  if [[ ! -e "$file" ]]; then
    random_hex > "$file"
    created+=("$file")
  fi
}

# ---------- MongoDB ----------
new_password secrets/mongo_root_password
new_password secrets/mongo_app_password
if [[ ! -e secrets/mongodb_uri ]]; then
  # The userinfo (user:password) is inserted as one value, so this file holds no
  # URI-with-credentials literal for secret scanners to flag.
  app_userinfo="flight_app:$(< secrets/mongo_app_password)"
  printf 'mongodb://%s@mongo:27017/flight_delay?authSource=flight_delay' "$app_userinfo" \
    > secrets/mongodb_uri
  unset app_userinfo
  created+=(secrets/mongodb_uri)
fi

# ---------- Kafka: passwords ----------
new_password secrets/kafka/admin_password
new_password secrets/kafka_app_password

# ---------- Kafka: CA and broker certificate ----------
if [[ ! -e secrets/ca/ca.key || ! -e secrets/kafka_ca.crt ]]; then
  openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
    -subj "/CN=flight-delay Kafka CA" \
    -keyout secrets/ca/ca.key -out secrets/kafka_ca.crt
  created+=(secrets/ca/ca.key secrets/kafka_ca.crt)
  # A new CA invalidates the old broker certificate.
  rm -f secrets/kafka/broker.p12
fi
cp secrets/kafka_ca.crt secrets/kafka/ca.crt

if [[ ! -e secrets/kafka/broker.p12 ]]; then
  new_password secrets/kafka/keystore_creds
  cp secrets/kafka/keystore_creds secrets/kafka/key_creds
  # Relative, inside secrets/: a native Windows openssl cannot resolve /tmp paths.
  work="$(mktemp -d secrets/.work.XXXXXX)"
  openssl req -new -newkey rsa:3072 -nodes -sha256 -subj "/CN=kafka" \
    -keyout "$work/broker.key" -out "$work/broker.csr"
  printf '%s\n' \
    'subjectAltName = DNS:kafka1, DNS:kafka2, DNS:kafka3, DNS:localhost' \
    'extendedKeyUsage = serverAuth, clientAuth' \
    'keyUsage = digitalSignature, keyEncipherment' > "$work/ext.cnf"
  openssl x509 -req -sha256 -days 825 -in "$work/broker.csr" \
    -CA secrets/kafka_ca.crt -CAkey secrets/ca/ca.key -CAcreateserial \
    -CAserial "$work/ca.srl" -extfile "$work/ext.cnf" -out "$work/broker.crt"
  openssl pkcs12 -export -name kafka \
    -in "$work/broker.crt" -inkey "$work/broker.key" -certfile secrets/kafka_ca.crt \
    -passout file:secrets/kafka/keystore_creds -out secrets/kafka/broker.p12
  rm -rf "$work"
  created+=(secrets/kafka/broker.p12 secrets/kafka/key_creds)
fi

# ---------- Kafka: SASL users and the admin client config (rebuilt from the password files) ----------
admin_password="$(< secrets/kafka/admin_password)"
app_password="$(< secrets/kafka_app_password)"
cat > secrets/kafka/kafka_server_jaas.conf << EOF
KafkaServer {
  org.apache.kafka.common.security.plain.PlainLoginModule required
  username="admin"
  password="${admin_password}"
  user_admin="${admin_password}"
  user_flight_app="${app_password}";
};
EOF
cat > secrets/kafka/admin.properties << EOF
security.protocol=SASL_SSL
sasl.mechanism=PLAIN
sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username="admin" password="${admin_password}";
ssl.truststore.type=PEM
ssl.truststore.location=/etc/kafka/secrets/ca.crt
EOF
unset admin_password app_password

if ((${#created[@]})); then
  printf 'Created: %s\n' "${created[@]}"
else
  echo "All secrets already exist; nothing created."
fi
if [[ "$(uname -s)" == Linux ]]; then
  fix_owners || true
fi
