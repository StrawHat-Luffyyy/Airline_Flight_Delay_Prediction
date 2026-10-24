#!/usr/bin/env bash
# One-shot setup of the production Kafka cluster, run by the kafka-setup service as the super-user
# admin, after all three brokers are healthy. Idempotent: safe on every `up`.
#
# Topics: the same names and partition counts as server/src/stream/topics.ts (flights.raw 3,
# flights.dlq 1), replicated to all 3 brokers with min.insync.replicas=2. With the producers'
# acks=all, a write is acknowledged only once two brokers have it, so one broker can be lost
# without losing acknowledged events.
#
# ACLs: the app user flight_app gets only what the app does. Every other principal is denied
# (allow.everyone.if.no.acl.found=false on the brokers).
#   flights.raw, flights.dlq  Read, Write, Describe (replay produces; the consumer reads raw and
#                             dead-letters to dlq; the status probe reads offsets)
#   group flight-stream       Read, Describe (consume and commit; the probe reads committed offsets)
set -euo pipefail

BOOTSTRAP=kafka1:9092,kafka2:9092,kafka3:9092
CONFIG=/etc/kafka/secrets/admin.properties
BIN=/opt/kafka/bin
APP=User:flight_app
RAW=${KAFKA_TOPIC_RAW:-flights.raw}
DLQ=${KAFKA_TOPIC_DLQ:-flights.dlq}
GROUP=${KAFKA_CONSUMER_GROUP:-flight-stream}

topic() {
  "$BIN/kafka-topics.sh" --bootstrap-server "$BOOTSTRAP" --command-config "$CONFIG" \
    --create --if-not-exists --topic "$1" --partitions "$2" --replication-factor 3 \
    --config min.insync.replicas=2
}

allow() {
  "$BIN/kafka-acls.sh" --bootstrap-server "$BOOTSTRAP" --command-config "$CONFIG" \
    --add --allow-principal "$APP" "$@" > /dev/null
}

echo "Creating topics (replication factor 3, min.insync.replicas=2) ..."
topic "$RAW" 3
topic "$DLQ" 1

echo "Granting $APP its ACLs ..."
allow --operation Read --operation Write --operation Describe --topic "$RAW"
allow --operation Read --operation Write --operation Describe --topic "$DLQ"
allow --operation Read --operation Describe --group "$GROUP"

echo "Topics:"
"$BIN/kafka-topics.sh" --bootstrap-server "$BOOTSTRAP" --command-config "$CONFIG" \
  --describe --topic "$RAW"
"$BIN/kafka-topics.sh" --bootstrap-server "$BOOTSTRAP" --command-config "$CONFIG" \
  --describe --topic "$DLQ"
echo "ACLs for $APP:"
"$BIN/kafka-acls.sh" --bootstrap-server "$BOOTSTRAP" --command-config "$CONFIG" \
  --list --principal "$APP"
echo "kafka-setup done."
