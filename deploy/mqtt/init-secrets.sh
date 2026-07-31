#!/bin/sh
set -eu

readonly broker_dir=/run/source-ingress/broker
readonly publisher_dir=/run/source-ingress/publisher
readonly subscriber_dir=/run/source-ingress/subscriber
readonly publisher_password_file="$publisher_dir/password"
readonly subscriber_password_file="$subscriber_dir/password"

install -d -m 0700 "$broker_dir" "$publisher_dir" "$subscriber_dir"
umask 077

valid_password_file() {
  [ -f "$1" ] \
    && [ ! -L "$1" ] \
    && [ "$(wc -l < "$1")" -eq 1 ] \
    && grep -Eq '^[0-9a-f]{64}$' "$1"
}

if ! valid_password_file "$publisher_password_file"; then
  openssl rand -hex 32 > "$publisher_password_file"
fi
if ! valid_password_file "$subscriber_password_file"; then
  openssl rand -hex 32 > "$subscriber_password_file"
fi

publisher_password="$(cat "$publisher_password_file")"
subscriber_password="$(cat "$subscriber_password_file")"
mosquitto_passwd -b -c "$broker_dir/passwords" nexus433 "$publisher_password"
mosquitto_passwd -b "$broker_dir/passwords" stugu-api "$subscriber_password"
unset publisher_password subscriber_password

cat > "$broker_dir/acl" <<'EOF'
user nexus433
topic write nexus433/#

user stugu-api
topic read nexus433/#
EOF

chown -R mosquitto:mosquitto "$broker_dir"
chmod 0700 "$broker_dir"
chmod 0600 "$broker_dir/passwords" "$broker_dir/acl"
chown 10001:10001 "$publisher_dir" "$publisher_password_file"
chmod 0700 "$publisher_dir"
chmod 0400 "$publisher_password_file"
chown 1000:1000 "$subscriber_dir" "$subscriber_password_file"
chmod 0700 "$subscriber_dir"
chmod 0400 "$subscriber_password_file"
