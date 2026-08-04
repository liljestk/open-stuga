#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Build the Raspberry Pi 4 factory image and signed-host release inputs.

Run this on 64-bit Raspberry Pi OS Trixie (or supported Debian arm64):

  RPI_SSH_PUBLIC_KEY_FILE=/path/to/id_ed25519.pub \
  RPI_CONNECT_AUTH_KEY_FILE=/path/to/connect.authkey \
  ./scripts/build-rpi-image.sh

Optional environment variables:
  STUGA_VERSION                  Package/release version (default: package.json)
  STUGA_IMAGE_TAG                Container tag (default: v<version>)
  STUGA_RELEASE_REPOSITORY       Readable GitHub release repository
                                 (default: liljestk/open-stuga)
  STUGA_IMAGE_REGISTRY_PREFIX    Image prefix (default: ghcr.io/liljestk/open-stuga)
  STUGA_{API,WEB,BACKUP,TAPO_RUNNER,UPDATE_AGENT,MQTT,NEXUS433}_IMAGE
                                 Required tag + sha256 digest image refs
  RPI_HOSTNAME                   Device hostname (default: stugu)
  RPI_WIFI_PROFILE               iwd .psk profile to embed
  RPI_WIFI_COUNTRY               Two-letter country code; required with Wi-Fi
  RPI_IMAGE_GEN_INSTALL_DEPS=1   Run rpi-image-gen's dependency installer
  RPI_BOOT_SELECTOR_CC           AArch64 C compiler override
  RPI_EXPORT_FACTORY_IMAGE=0     Export only the OTA artifact (used by CI)
  RPI_FACTORY_BUILD=0            Permit a build without first-access credentials
  STUGA_HOST_GENERATION          Monotonic unsigned host generation (required)
  RPI_HOST_TUF_ROOT_FILE         Offline-approved TUF root v1 (required)
  RPI_HOST_RAUC_CA_FILE          Offline-approved RAUC CA certificate (required)
  RPI_HOST_UPDATE_BASE_URL       HTTPS TUF repository base URL (required)
  RPI_HOST_HARDWARE_QUALIFICATION_FILE
                                 Optional immutable qualification receipt;
                                 the repository default disables activation
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if (( $# != 0 )); then
  usage >&2
  exit 2
fi

readonly repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly package_version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$repo_root/package.json" | head -n 1)"
version="${STUGA_VERSION:-$package_version}"
version="${version#v}"

if [[ -z "$version" || ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
  echo "STUGA_VERSION must be a release-like version; got '$version'" >&2
  exit 1
fi
if [[ "$version" != "$package_version" ]]; then
  echo "Release version $version does not match package.json version $package_version" >&2
  exit 1
fi

for command_name in git openssl python3 sha256sum zstd; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done
python3 -c 'import tuf.api.metadata' 2>/dev/null || {
  echo "Missing required Python package: python3-tuf" >&2
  exit 1
}

readonly image_tag="${STUGA_IMAGE_TAG:-v$version}"
readonly release_repository="${STUGA_RELEASE_REPOSITORY:-liljestk/open-stuga}"
readonly image_prefix="${STUGA_IMAGE_REGISTRY_PREFIX:-ghcr.io/liljestk/open-stuga}"
readonly api_image="${STUGA_API_IMAGE:-}"
readonly web_image="${STUGA_WEB_IMAGE:-}"
readonly backup_image="${STUGA_BACKUP_IMAGE:-}"
readonly tapo_image="${STUGA_TAPO_RUNNER_IMAGE:-}"
readonly update_agent_image="${STUGA_UPDATE_AGENT_IMAGE:-}"
readonly mqtt_image="${STUGA_MQTT_IMAGE:-}"
readonly nexus433_image="${STUGA_NEXUS433_IMAGE:-}"
readonly hostname="${RPI_HOSTNAME:-stugu}"
readonly rpi_image_gen_ref="${RPI_IMAGE_GEN_REF:-17e53bca56c8d6bed273a6faa7412b296e4c0937}"
readonly rpi_image_gen_dir="${RPI_IMAGE_GEN_DIR:-$repo_root/.rpi-image-gen}"
readonly build_root="${RPI_BUILD_ROOT:-$repo_root/.rpi-build/$version}"
readonly dist_dir="${RPI_DIST_DIR:-$repo_root/dist/rpi}"
readonly factory_build="${RPI_FACTORY_BUILD:-1}"
readonly export_factory_image="${RPI_EXPORT_FACTORY_IMAGE:-1}"
readonly host_generation="${STUGA_HOST_GENERATION:-}"
readonly host_tuf_root_file="${RPI_HOST_TUF_ROOT_FILE:-}"
readonly host_rauc_ca_file="${RPI_HOST_RAUC_CA_FILE:-}"
readonly host_update_base_url="${RPI_HOST_UPDATE_BASE_URL:-}"
readonly host_qualification_file="${RPI_HOST_HARDWARE_QUALIFICATION_FILE:-}"

if [[ ! "$release_repository" =~ ^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$ ]]; then
  echo "STUGA_RELEASE_REPOSITORY must use owner/repository form" >&2
  exit 1
fi
if [[ ! "$image_prefix" =~ ^ghcr\.io/[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$ ]]; then
  echo "STUGA_IMAGE_REGISTRY_PREFIX must be a lower-case GHCR image prefix" >&2
  exit 1
fi

validate_release_image() {
  local image_ref="$1"
  local suffix="$2"
  local expected="${image_prefix}-${suffix}:${image_tag}@sha256:"
  local digest="${image_ref#"$expected"}"
  if [[ "$image_ref" != "$expected$digest" || ! "$digest" =~ ^[0-9a-f]{64}$ ]]; then
    echo "STUGA ${suffix} image must pin ${image_prefix}-${suffix}:${image_tag} by sha256 digest" >&2
    exit 1
  fi
}
validate_release_image "$api_image" api
validate_release_image "$web_image" web
validate_release_image "$backup_image" backup
validate_release_image "$tapo_image" tapo-export-runner
validate_release_image "$update_agent_image" update-agent
validate_release_image "$mqtt_image" mqtt
validate_release_image "$nexus433_image" nexus433
if [[ ! "$hostname" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "RPI_HOSTNAME must be a valid lowercase hostname" >&2
  exit 1
fi
if [[ ! "$host_generation" =~ ^[1-9][0-9]*$ ]] \
  || ! python3 - "$host_generation" <<'PY'
import sys
value = int(sys.argv[1])
raise SystemExit(0 if 1 <= value <= 2**53 - 1 else 1)
PY
then
  echo "STUGA_HOST_GENERATION must be a positive monotonic integer" >&2
  exit 1
fi
if [[ ! "$host_update_base_url" =~ ^https://[^/?#]+(/[^?#]*)?$ ]]; then
  echo "RPI_HOST_UPDATE_BASE_URL must be an HTTPS base URL without query or fragment" >&2
  exit 1
fi
for required_host_trust_file in "$host_tuf_root_file" "$host_rauc_ca_file"; do
  if [[ ! -s "$required_host_trust_file" ]]; then
    echo "Host updater trust input is missing or empty: $required_host_trust_file" >&2
    exit 1
  fi
done
if [[ -n "$host_qualification_file" && ! -s "$host_qualification_file" ]]; then
  echo "Host hardware qualification receipt is missing or empty: $host_qualification_file" >&2
  exit 1
fi
openssl x509 -in "$host_rauc_ca_file" -noout -checkend 31536000 >/dev/null || {
  echo "RAUC CA must be a valid certificate with at least one year remaining" >&2
  exit 1
}
openssl x509 -in "$host_rauc_ca_file" -noout -text \
  | grep -A1 -F 'X509v3 Basic Constraints' \
  | grep -Fq 'CA:TRUE' || {
  echo "RPI_HOST_RAUC_CA_FILE must contain a CA certificate" >&2
  exit 1
}

ssh_key_file="${RPI_SSH_PUBLIC_KEY_FILE:-}"
connect_auth_file="${RPI_CONNECT_AUTH_KEY_FILE:-}"
wifi_profile="${RPI_WIFI_PROFILE:-}"
wifi_country="${RPI_WIFI_COUNTRY:-}"

for optional_file in "$ssh_key_file" "$connect_auth_file" "$wifi_profile"; do
  if [[ -n "$optional_file" && ! -f "$optional_file" ]]; then
    echo "Input file does not exist: $optional_file" >&2
    exit 1
  fi
done
if [[ "$factory_build" == "1" && -z "$ssh_key_file" && -z "$connect_auth_file" ]]; then
  echo "A factory build needs RPI_SSH_PUBLIC_KEY_FILE or RPI_CONNECT_AUTH_KEY_FILE" >&2
  echo "This guard prevents creating a password-locked device with no recovery access." >&2
  exit 1
fi
if [[ -n "$wifi_profile" && ! "$wifi_country" =~ ^[A-Z]{2}$ ]]; then
  echo "Set RPI_WIFI_COUNTRY to an uppercase two-letter code when embedding Wi-Fi" >&2
  exit 1
fi

if [[ ! -d "$rpi_image_gen_dir/.git" ]]; then
  git clone --no-checkout https://github.com/raspberrypi/rpi-image-gen.git "$rpi_image_gen_dir"
fi
git -C "$rpi_image_gen_dir" fetch --depth 1 origin "$rpi_image_gen_ref"
git -C "$rpi_image_gen_dir" checkout --detach "$rpi_image_gen_ref"

readonly usb_rescue_patch="$repo_root/deploy/rpi/patches/0001-pi4-usb-rescue-bootconfig.patch"
readonly -a usb_rescue_patch_targets=(
  image/gpt/ab_userdata/genimage.cfg.in.erofs
  image/gpt/ab_userdata/genimage.cfg.in.ext4
  image/gpt/ab_userdata/pre-image.sh
)
# A cached checkout can retain a prior revision of this patch. Windows bind
# mounts can also report every file as executable or convert its line endings,
# which prevents git apply --reverse from recognizing that stale patch. Restore
# only the patch-owned files from the pinned commit before applying it.
git -C "$rpi_image_gen_dir" config core.autocrlf false
git -C "$rpi_image_gen_dir" config core.filemode false
git -C "$rpi_image_gen_dir" restore \
  --source="$rpi_image_gen_ref" --staged --worktree -- \
  "${usb_rescue_patch_targets[@]}"
if git -C "$rpi_image_gen_dir" apply --reverse --check "$usb_rescue_patch" 2>/dev/null; then
  echo "Stugu Pi 4 USB rescue patch is already applied"
else
  git -C "$rpi_image_gen_dir" apply --check "$usb_rescue_patch"
  git -C "$rpi_image_gen_dir" apply "$usb_rescue_patch"
fi

if [[ "${RPI_IMAGE_GEN_INSTALL_DEPS:-0}" == "1" ]]; then
  if (( EUID == 0 )); then
    "$rpi_image_gen_dir/install_deps.sh"
  else
    sudo "$rpi_image_gen_dir/install_deps.sh"
  fi
fi

stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/stugu-rpi.XXXXXX")"
cleanup() {
  rm -rf -- "$stage_dir"
}
trap cleanup EXIT

cp -a "$repo_root/deploy/rpi/." "$stage_dir/"
selector_cc="${RPI_BOOT_SELECTOR_CC:-}"
if [[ -z "$selector_cc" ]]; then
  case "$(uname -m)" in
    aarch64|arm64) selector_cc=cc ;;
    x86_64|amd64) selector_cc=aarch64-linux-gnu-gcc ;;
    *)
      echo "Unsupported build architecture for the AArch64 boot selector: $(uname -m)" >&2
      exit 1
      ;;
  esac
fi
if ! command -v "$selector_cc" >/dev/null 2>&1; then
  echo "Missing AArch64 boot-selector compiler: $selector_cc" >&2
  exit 1
fi
"$selector_cc" -std=c11 -O2 -Wall -Wextra -Werror -static \
  "$repo_root/deploy/rpi/boot-selector/stugu-boot-select.c" \
  -o "$stage_dir/assets/stugu-boot-select"
chmod 0755 "$stage_dir/assets/stugu-boot-select"
python3 - "$stage_dir/assets/stugu-boot-select" <<'PY'
from pathlib import Path
import struct
import sys

path = Path(sys.argv[1])
data = path.read_bytes()
if len(data) < 64 or data[:6] != b"\x7fELF\x02\x01":
    raise SystemExit("boot selector is not a little-endian ELF64 executable")
if struct.unpack_from("<H", data, 18)[0] != 183:
    raise SystemExit("boot selector is not an AArch64 executable")
program_offset = struct.unpack_from("<Q", data, 32)[0]
program_size = struct.unpack_from("<H", data, 54)[0]
program_count = struct.unpack_from("<H", data, 56)[0]
if (
    program_size < 4
    or program_count == 0
    or program_offset + program_size * program_count > len(data)
):
    raise SystemExit("boot selector has an invalid program-header table")
if any(
    struct.unpack_from("<I", data, program_offset + index * program_size)[0] == 3
    for index in range(program_count)
):
    raise SystemExit("boot selector must be static for early initramfs")
PY
install -m 0444 "$host_tuf_root_file" "$stage_dir/assets/stugu-host-tuf-root.json"
install -m 0444 "$host_rauc_ca_file" "$stage_dir/assets/stugu-host-rauc-ca.pem"
if [[ -n "$host_qualification_file" ]]; then
  install -m 0444 "$host_qualification_file" \
    "$stage_dir/assets/stugu-hardware-qualification.json"
fi
python3 - "$stage_dir/assets/stugu-hardware-qualification.json" \
  "$stage_dir/assets/stugu-system-watchdog.conf" \
  "$stage_dir/assets/stugu-boot-select" <<'PY'
import hashlib
import json
from pathlib import Path
import re
import sys

qualification_path, watchdog_path, selector_path = map(Path, sys.argv[1:])
try:
    value = json.loads(qualification_path.read_text(encoding="utf-8"))
except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
    raise SystemExit(f"invalid hardware qualification receipt: {error}")
expected = {
    "schema", "activationEnabled", "bootShimGeneration", "evidence",
    "selectorSha256", "watchdogSeconds", "recordOffsets", "hardwareMatrix",
}
if (
    not isinstance(value, dict)
    or set(value) != expected
    or value.get("schema") != "stugu-pi4-qualification/v1"
    or not isinstance(value.get("activationEnabled"), bool)
):
    raise SystemExit("hardware qualification receipt shape is invalid")
seconds = 0
if value["activationEnabled"]:
    evidence = value.get("evidence")
    selector = value.get("selectorSha256")
    matrix = value.get("hardwareMatrix")
    seconds = value.get("watchdogSeconds")
    if (
        value.get("bootShimGeneration") != 1
        or value.get("recordOffsets") != [99614720, 99618816]
        or not isinstance(evidence, str)
        or not re.fullmatch(r"[0-9a-f]{64}", evidence)
        or evidence == "0" * 64
        or not isinstance(selector, str)
        or not re.fullmatch(r"[0-9a-f]{64}", selector)
        or selector == "0" * 64
        or isinstance(seconds, bool)
        or not isinstance(seconds, int)
        or not 0 <= seconds <= 15
        or not isinstance(matrix, list)
        or not matrix
        or any(
            not isinstance(item, str)
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", item)
            for item in matrix
        )
    ):
        raise SystemExit("enabled hardware qualification receipt is incomplete or unsafe")
    actual_selector = hashlib.sha256(selector_path.read_bytes()).hexdigest()
    if selector != actual_selector:
        raise SystemExit("hardware qualification selector hash does not match this build")
watchdog_path.write_text(
    "[Manager]\n"
    "# Generated from the immutable hardware qualification receipt.\n"
    f"RuntimeWatchdogSec={seconds}s\n",
    encoding="ascii",
)
PY
python3 - "$stage_dir/assets/stugu-host-tuf-root.json" \
  "$stage_dir/assets/stugu-host-updater-config.json.in" \
  "$stage_dir/assets/stugu-host-updater-config.json" \
  "$host_update_base_url" "$host_generation" <<'PY'
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
from urllib.parse import urlparse
from tuf.api.metadata import Metadata, Root

root_path, template_path, output_path, base_url, generation = sys.argv[1:]
try:
    root = json.loads(Path(root_path).read_text(encoding="utf-8"))
except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
    raise SystemExit(f"invalid TUF root JSON: {error}")
if not isinstance(root, dict) or set(root) != {"signed", "signatures"}:
    raise SystemExit("TUF root must contain only signed and signatures envelopes")
signed = root.get("signed")
if not isinstance(signed, dict) or signed.get("_type") != "root" or signed.get("version") != 1:
    raise SystemExit("immutable TUF bootstrap must be root version 1")
if signed.get("consistent_snapshot") is not True:
    raise SystemExit("TUF root v1 must enable consistent snapshots")
roles = signed.get("roles")
keys = signed.get("keys")
if not isinstance(roles, dict) or not isinstance(keys, dict):
    raise SystemExit("TUF root v1 roles or keys are invalid")
role_keys = {}
for role_name, minimum_threshold, minimum_keys in (
    ("root", 2, 3), ("targets", 2, 3), ("snapshot", 1, 1), ("timestamp", 1, 1)
):
    role = roles.get(role_name)
    if not isinstance(role, dict) or set(role) != {"keyids", "threshold"}:
        raise SystemExit(f"TUF root role {role_name} is invalid")
    keyids = role.get("keyids")
    threshold = role.get("threshold")
    if (
        not isinstance(keyids, list)
        or len(keyids) < minimum_keys
        or not isinstance(threshold, int)
        or isinstance(threshold, bool)
        or threshold < minimum_threshold
    ):
        raise SystemExit(f"TUF root role {role_name} has an unsafe threshold")
    if len(set(keyids)) != len(keyids) or threshold > len(keyids) or any(keyid not in keys for keyid in keyids):
        raise SystemExit(f"TUF root role {role_name} key set is invalid")
    role_keys[role_name] = set(keyids)
for left_index, left in enumerate(role_keys):
    for right in list(role_keys)[left_index + 1:]:
        if role_keys[left] & role_keys[right]:
            raise SystemExit(f"TUF root roles {left} and {right} must use separate keys")
root_keyids = set(roles["root"]["keyids"])
signatures = root.get("signatures")
signed_root_keys = {
    signature.get("keyid") for signature in signatures if isinstance(signature, dict)
} if isinstance(signatures, list) else set()
if len(root_keyids & signed_root_keys) < roles["root"]["threshold"]:
    raise SystemExit("TUF root v1 lacks its declared root signature threshold")
try:
    trusted_root = Metadata[Root].from_bytes(Path(root_path).read_bytes())
    trusted_root.signed.verify_delegate(
        "root", trusted_root.signed_bytes, trusted_root.signatures
    )
except Exception as error:
    raise SystemExit("TUF root v1 self-signatures are invalid") from error
expires = signed.get("expires")
try:
    expiry = datetime.fromisoformat(str(expires).replace("Z", "+00:00"))
except ValueError as error:
    raise SystemExit("TUF root expiry is invalid") from error
if expiry <= datetime.now(timezone.utc) + timedelta(days=365):
    raise SystemExit("TUF root v1 must have at least one year remaining")

parsed = urlparse(base_url)
if (
    parsed.scheme != "https"
    or not parsed.netloc
    or parsed.username
    or parsed.password
    or parsed.query
    or parsed.fragment
):
    raise SystemExit("host update base URL is invalid")
base = base_url.rstrip("/")
template = Path(template_path).read_text(encoding="utf-8")
settings = {
    "@METADATA_BASE_URL@": f"{base}/metadata/",
    "@TARGET_BASE_URL@": f"{base}/targets/",
    "@HOST_GENERATION@": generation,
}
for marker, value in settings.items():
    if template.count(marker) != 1:
        raise SystemExit(f"expected one updater config marker {marker}")
    template = template.replace(marker, value)
parsed_config = json.loads(template)
Path(output_path).write_text(json.dumps(parsed_config, indent=2) + "\n", encoding="utf-8")
PY
printf '%s\n' "$host_generation" > "$stage_dir/assets/stugu-host-generation"
chmod 0444 "$stage_dir/assets/stugu-host-generation"
python3 - "$stage_dir/assets/stugu.env.example" "$release_repository" "$image_prefix" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text(encoding="utf-8")
settings = {
    "SYSTEM_UPDATE_REPOSITORY": sys.argv[2],
    "SYSTEM_UPDATE_IMAGE_PREFIX": sys.argv[3],
}
lines = source.splitlines()
for name, value in settings.items():
    matching = [index for index, line in enumerate(lines) if line.startswith(f"{name}=")]
    if len(matching) != 1:
        raise SystemExit(f"expected exactly one {name} appliance setting")
    lines[matching[0]] = f"{name}={value}"
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
install -d -m 0755 "$stage_dir/assets/config"
install -d -m 0755 "$stage_dir/assets/apps/tapo-export-runner"
install -d -m 0755 "$stage_dir/assets/scripts"
install -m 0644 "$repo_root/docker-compose.yml" "$stage_dir/assets/docker-compose.yml"
install -m 0644 "$repo_root/.env.example" "$stage_dir/assets/full.env.example"
install -m 0644 "$repo_root/apps/tapo-export-runner/flow.example.json" \
  "$stage_dir/assets/tapo-flow.example.json"
cp -a "$repo_root/config/." "$stage_dir/assets/config/"
install -m 0644 "$repo_root/deploy/rpi/assets/host-capabilities.json" \
  "$stage_dir/assets/config/host-capabilities.json"
install -m 0755 "$repo_root/scripts/bootstrap-timescale.sh" \
  "$stage_dir/assets/bootstrap-timescale.sh"
install -m 0755 "$repo_root/scripts/reconcile-timescale-credentials.sh" \
  "$stage_dir/assets/reconcile-timescale-credentials.sh"

# The pinned generator declares USB as a valid storage type in device-base,
# but its IDP v2 schema still omits it. Keep the generated metadata truthful
# and fail closed if the pinned upstream schema no longer has that exact gap.
upstream_idp_schema="$rpi_image_gen_dir/layer/rpi/schemas/idp/v2/schema.json"
usb_idp_schema="$stage_dir/idp-v2-usb.schema.json"
python3 - "$upstream_idp_schema" "$usb_idp_schema" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text(encoding="utf-8")
needle = '"enum": ["sd", "emmc", "nvme"]'
replacement = '"enum": ["sd", "emmc", "nvme", "usb"]'
if source.count(needle) != 1:
    raise SystemExit("unexpected rpi-image-gen IDP storage-type schema")
Path(sys.argv[2]).write_text(source.replace(needle, replacement), encoding="utf-8")
PY

build_options=(
  "IGconf_artefact_version=$version"
  "IGconf_device_hostname=$hostname"
  "IGconf_stugu_api_image=$api_image"
  "IGconf_stugu_web_image=$web_image"
  "IGconf_stugu_backup_image=$backup_image"
  "IGconf_stugu_tapo_image=$tapo_image"
  "IGconf_stugu_update_agent_image=$update_agent_image"
  "IGconf_stugu_mqtt_image=$mqtt_image"
  "IGconf_stugu_nexus433_image=$nexus433_image"
  "IGconf_image_idp_schema=$usb_idp_schema"
  "IGconf_sys_workroot=$build_root"
  "IGconf_sbom_enable=y"
  "IGconf_sbom_name=stugu-rpi4-$version"
  "IGconf_sbom_version=$version"
  "IGconf_sbom_filename=stugu-host-sbom.spdx.json"
)
[[ -n "$ssh_key_file" ]] && build_options+=("IGconf_ssh_pubkey_user1=$(realpath "$ssh_key_file")")
[[ -n "$connect_auth_file" ]] && build_options+=("IGconf_connect_authkey=$(realpath "$connect_auth_file")")
if [[ -n "$wifi_profile" ]]; then
  build_options+=("IGconf_iwd_profile=$(realpath "$wifi_profile")")
  build_options+=("IGconf_ieee80211_regdom=$wifi_country")
fi

mkdir -p "$build_root" "$dist_dir"

(
  cd "$rpi_image_gen_dir"
  ./rpi-image-gen metadata --lint "$stage_dir/layer/stugu.yaml"
  ./rpi-image-gen build -S "$stage_dir" -c stugu.yaml -- "${build_options[@]}"
)

readonly output_dir="$build_root/image-stugu"
readonly target_dir="$build_root/chroot-$version"
readonly raw_image="$output_dir/stugu.img"
readonly ota_source="$output_dir/update.tar.zst"
readonly boot_source="$output_dir/boot.vfat"
readonly system_source="$output_dir/system.erofs"
readonly sbom_source="$target_dir/stugu-host-sbom.spdx.json"
readonly ota_name="stugu-rpi4-$version-ota.tar.zst"
readonly factory_name="stugu-rpi4-$version.img.zst"
readonly host_inputs="$dist_dir/host-inputs"

if [[ ! -s "$ota_source" ]]; then
  echo "rpi-image-gen did not produce $ota_source" >&2
  exit 1
fi
install -m 0644 "$ota_source" "$dist_dir/$ota_name"
for host_input in "$boot_source" "$system_source" "$sbom_source"; do
  if [[ ! -s "$host_input" ]]; then
    echo "rpi-image-gen did not produce required host release input $host_input" >&2
    exit 1
  fi
done
if ! command -v dump.erofs >/dev/null 2>&1; then
  echo "Required EROFS release-validation command is unavailable: dump.erofs" >&2
  exit 1
fi
for required_host_runtime in /usr/bin/rauc /usr/bin/unsquashfs; do
  required_host_runtime_metadata="$(
    dump.erofs --path="$required_host_runtime" "$system_source" 2>&1
  )"
  if ! grep -Fq "Path : $required_host_runtime" <<<"$required_host_runtime_metadata" \
    || ! grep -Fq "Access: 0755/" <<<"$required_host_runtime_metadata"; then
    echo "Generated host image lacks executable runtime dependency $required_host_runtime" >&2
    exit 1
  fi
done
mkdir -p "$host_inputs"
install -m 0644 "$boot_source" "$host_inputs/boot.vfat"
install -m 0644 "$system_source" "$host_inputs/system.erofs"
install -m 0644 "$sbom_source" "$host_inputs/stugu-host-sbom.spdx.json"

source_commit="$(git -C "$repo_root" rev-parse HEAD)"
source_commit_time="$(git -C "$repo_root" show -s --format=%cI "$source_commit")"
boot_sha256="$(sha256sum "$boot_source" | awk '{print $1}')"
system_sha256="$(sha256sum "$system_source" | awk '{print $1}')"
tuf_root_sha256="$(sha256sum "$host_tuf_root_file" | awk '{print $1}')"
rauc_ca_sha256="$(sha256sum "$host_rauc_ca_file" | awk '{print $1}')"
readonly source_commit source_commit_time boot_sha256 system_sha256
readonly tuf_root_sha256 rauc_ca_sha256
python3 - "$host_inputs/stugu-host-provenance.intoto.jsonl" \
  "$version" "$host_generation" "$source_commit" "$source_commit_time" \
  "$rpi_image_gen_ref" "$boot_sha256" "$system_sha256" \
  "$tuf_root_sha256" "$rauc_ca_sha256" <<'PY'
import json
from pathlib import Path
import sys

(
    output, version, generation, source_commit, source_commit_time,
    image_gen_commit, boot_sha, system_sha, tuf_root_sha, rauc_ca_sha,
) = sys.argv[1:]
statement = {
    "_type": "https://in-toto.io/Statement/v1",
    "subject": [
        {"name": "boot.vfat", "digest": {"sha256": boot_sha}},
        {"name": "system.erofs", "digest": {"sha256": system_sha}},
    ],
    "predicateType": "https://slsa.dev/provenance/v1",
    "predicate": {
        "buildDefinition": {
            "buildType": "https://stugu.local/build/rpi-image-gen/v1",
            "externalParameters": {
                "version": version,
                "hostGeneration": int(generation),
                "architecture": "arm64",
                "layout": "stugu-gpt-ab-v2",
                "sourceCommitTime": source_commit_time,
            },
            "internalParameters": {
                "tufRootSha256": tuf_root_sha,
                "raucCaSha256": rauc_ca_sha,
            },
            "resolvedDependencies": [
                {
                    "uri": "git+https://github.com/liljestk/open-stuga.git",
                    "digest": {"gitCommit": source_commit},
                },
                {
                    "uri": "git+https://github.com/raspberrypi/rpi-image-gen.git",
                    "digest": {"gitCommit": image_gen_commit},
                },
            ],
        },
        "runDetails": {
            "builder": {"id": "https://stugu.local/builders/rpi-release/v1"},
            "metadata": {"invocationId": f"stugu-rpi4-{version}-{source_commit[:12]}"},
        },
    },
}
Path(output).write_text(json.dumps(statement, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
PY

checksum_files=("$ota_name")
if [[ "$export_factory_image" == "1" ]]; then
  if [[ ! -s "$raw_image" ]]; then
    echo "rpi-image-gen did not produce $raw_image" >&2
    exit 1
  fi
  "$repo_root/scripts/validate-rpi-image.sh" "$raw_image"
  zstd --threads=0 -6 --force "$raw_image" -o "$dist_dir/$factory_name"
  chmod 0600 "$dist_dir/$factory_name"
  checksum_files+=("$factory_name")
fi

(
  cd "$dist_dir"
  sha256sum "${checksum_files[@]}" > "stugu-rpi4-$version.sha256"
)

cat <<EOF
Build complete.

OTA artifact:     $dist_dir/$ota_name
Host inputs:      $host_inputs
Checksums:        $dist_dir/stugu-rpi4-$version.sha256
Factory image:    $([[ "$export_factory_image" == "1" ]] && printf '%s' "$dist_dir/$factory_name" || printf '%s' 'not exported')
rpi-image-gen:    $rpi_image_gen_ref
EOF
