#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Build the Raspberry Pi 4 factory image and A/B OTA artifact.

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
  STUGA_{API,WEB,BACKUP,TAPO_RUNNER,UPDATE_AGENT}_IMAGE
                                 Required tag + sha256 digest image refs
  RPI_HOSTNAME                   Device hostname (default: stugu)
  RPI_WIFI_PROFILE               iwd .psk profile to embed
  RPI_WIFI_COUNTRY               Two-letter country code; required with Wi-Fi
  RPI_IMAGE_GEN_INSTALL_DEPS=1   Run rpi-image-gen's dependency installer
  RPI_EXPORT_FACTORY_IMAGE=0     Export only the OTA artifact (used by CI)
  RPI_FACTORY_BUILD=0            Permit a build without first-access credentials
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

if [[ -z "$version" || ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "STUGA_VERSION must be a release-like version; got '$version'" >&2
  exit 1
fi
if [[ "$version" != "$package_version" ]]; then
  echo "Release version $version does not match package.json version $package_version" >&2
  exit 1
fi

for command_name in git sha256sum zstd; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

readonly image_tag="${STUGA_IMAGE_TAG:-v$version}"
readonly release_repository="${STUGA_RELEASE_REPOSITORY:-liljestk/open-stuga}"
readonly image_prefix="${STUGA_IMAGE_REGISTRY_PREFIX:-ghcr.io/liljestk/open-stuga}"
readonly api_image="${STUGA_API_IMAGE:-}"
readonly web_image="${STUGA_WEB_IMAGE:-}"
readonly backup_image="${STUGA_BACKUP_IMAGE:-}"
readonly tapo_image="${STUGA_TAPO_RUNNER_IMAGE:-}"
readonly update_agent_image="${STUGA_UPDATE_AGENT_IMAGE:-}"
readonly hostname="${RPI_HOSTNAME:-stugu}"
readonly rpi_image_gen_ref="${RPI_IMAGE_GEN_REF:-17e53bca56c8d6bed273a6faa7412b296e4c0937}"
readonly rpi_image_gen_dir="${RPI_IMAGE_GEN_DIR:-$repo_root/.rpi-image-gen}"
readonly build_root="${RPI_BUILD_ROOT:-$repo_root/.rpi-build/$version}"
readonly dist_dir="${RPI_DIST_DIR:-$repo_root/dist/rpi}"
readonly factory_build="${RPI_FACTORY_BUILD:-1}"
readonly export_factory_image="${RPI_EXPORT_FACTORY_IMAGE:-1}"

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
if [[ ! "$hostname" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "RPI_HOSTNAME must be a valid lowercase hostname" >&2
  exit 1
fi

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
  "IGconf_image_idp_schema=$usb_idp_schema"
  "IGconf_sys_workroot=$build_root"
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
readonly raw_image="$output_dir/stugu.img"
readonly ota_source="$output_dir/update.tar.zst"
readonly ota_name="stugu-rpi4-$version-ota.tar.zst"
readonly factory_name="stugu-rpi4-$version.img.zst"

if [[ ! -s "$ota_source" ]]; then
  echo "rpi-image-gen did not produce $ota_source" >&2
  exit 1
fi
install -m 0644 "$ota_source" "$dist_dir/$ota_name"

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
Checksums:        $dist_dir/stugu-rpi4-$version.sha256
Factory image:    $([[ "$export_factory_image" == "1" ]] && printf '%s' "$dist_dir/$factory_name" || printf '%s' 'not exported')
rpi-image-gen:    $rpi_image_gen_ref
EOF
