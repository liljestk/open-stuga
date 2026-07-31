#!/bin/sh
set -eu

readonly secret_file="${NEXUS433_MQTT_PASSWORD_FILE:-/run/secrets/source-ingress/password}"
readonly runtime_dir="${NEXUS433_RUNTIME_DIRECTORY:-/run/nexus433}"
readonly config_file="$runtime_dir/nexus433.ini"
readonly mqtt_host="${NEXUS433_MQTT_HOST:-mqtt}"
readonly mqtt_port="${NEXUS433_MQTT_PORT:-1883}"
readonly mqtt_user="${NEXUS433_MQTT_USER:-nexus433}"
readonly mqtt_client_id="${NEXUS433_MQTT_CLIENT_ID:-nexus433}"
readonly gpio_chip="${NEXUS433_GPIO_CHIP:-/dev/gpiochip0}"
readonly gpio_line="${NEXUS433_GPIO_LINE:-17}"

case "$mqtt_host" in
  *[!A-Za-z0-9._-]*|'') echo "NEXUS433_MQTT_HOST is invalid" >&2; exit 2 ;;
esac
case "$mqtt_port" in
  *[!0-9]*|'') echo "NEXUS433_MQTT_PORT is invalid" >&2; exit 2 ;;
esac
case "$mqtt_user" in
  *[!A-Za-z0-9._-]*|'') echo "NEXUS433_MQTT_USER is invalid" >&2; exit 2 ;;
esac
case "$mqtt_client_id" in
  *[!A-Za-z0-9._-]*|'') echo "NEXUS433_MQTT_CLIENT_ID is invalid" >&2; exit 2 ;;
esac
gpio_chip_number="${gpio_chip#/dev/gpiochip}"
case "$gpio_chip_number" in
  *[!0-9]*|'') echo "NEXUS433_GPIO_CHIP must name a gpiochip device" >&2; exit 2 ;;
esac
case "$gpio_line" in
  *[!0-9]*|'') echo "NEXUS433_GPIO_LINE is invalid" >&2; exit 2 ;;
esac
if [ "$mqtt_port" -lt 1 ] || [ "$mqtt_port" -gt 65535 ]; then
  echo "NEXUS433_MQTT_PORT is out of range" >&2
  exit 2
fi
if [ "$gpio_line" -gt 63 ]; then
  echo "NEXUS433_GPIO_LINE is out of range" >&2
  exit 2
fi
if [ ! -f "$secret_file" ] || [ -L "$secret_file" ] || [ ! -r "$secret_file" ]; then
  echo "Nexus433 MQTT password is unavailable" >&2
  exit 1
fi
if [ "$(wc -l < "$secret_file")" -ne 1 ] || ! grep -Eq '^[0-9a-f]{64}$' "$secret_file"; then
  echo "Nexus433 MQTT password is invalid" >&2
  exit 1
fi

password="$(cat "$secret_file")"

umask 077
mkdir -p "$runtime_dir"
cat > "$config_file" <<EOF
[mqtt]
host=$mqtt_host
port=$mqtt_port
user=$mqtt_user
password=$password
clientid=$mqtt_client_id

[receiver]
chip=$gpio_chip
pin=$gpio_line
polling=false

[transmitter]
silent_timeout_sec=240
minimum_frames=2
battery_low=low
battery_normal=ok
discovery=false

[ignore]

[substitute]
EOF
unset password

exec /usr/local/bin/nexus433 --config "$config_file"
