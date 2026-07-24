#!/bin/sh
set -eu

secret="${LOCAL_AUTH_PROXY_SECRET:-}"
secret_file="${LOCAL_AUTH_PROXY_SECRET_FILE:-}"

if [ -n "$secret_file" ]; then
  attempts=0
  while [ ! -s "$secret_file" ]; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
      echo "The local-auth proxy credential was not created in time." >&2
      exit 1
    fi
    sleep 1
  done
  secret="$(tr -d '\r\n' < "$secret_file")"
fi

if [ "${#secret}" -lt 32 ]; then
  echo "A local-auth proxy credential of at least 32 bytes is required." >&2
  exit 1
fi

container_dns_resolver="$(awk '$1 == "nameserver" { print $2; exit }' /etc/resolv.conf)"
case "$container_dns_resolver" in
  ""|*[!0-9A-Fa-f:.]*)
    echo "Could not determine a safe container DNS resolver from /etc/resolv.conf." >&2
    exit 1
    ;;
esac

export LOCAL_AUTH_PROXY_SECRET="$secret"
export STUGA_CONTAINER_DNS_RESOLVER="$container_dns_resolver"
envsubst '${LOCAL_AUTH_PROXY_SECRET} ${STUGA_CONTAINER_DNS_RESOLVER}' \
  < /etc/nginx/templates/nginx.conf.template > /tmp/nginx.conf
unset LOCAL_AUTH_PROXY_SECRET STUGA_CONTAINER_DNS_RESOLVER secret container_dns_resolver

exec nginx -c /tmp/nginx.conf -g 'daemon off;'
