import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createDeployment,
  ensureArtefact,
  readConfig,
  waitForDeployment,
} from "../deploy-rpi-ota.mjs";
import {
  artifactDefinitions,
  imageDefinitions,
  parseArguments,
  platformInvocation,
  repositoryFromRemote,
} from "../publish-local-release.mjs";

const baseEnv = {
  RPI_CONNECT_API_TOKEN: "secret-token",
  RPI_CONNECT_DEVICE_ID: "69739b44-ebb2-468e-9e24-08126dec4925",
  RPI_OTA_VERSION: "v1.2.3",
  RPI_OTA_URI: "https://example.test/stugu-rpi4-1.2.3-ota.tar.zst",
  RPI_OTA_CHECKSUM: "a".repeat(64),
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("readConfig normalizes and validates release input", () => {
  const config = readConfig(baseEnv);
  assert.equal(config.version, "1.2.3");
  assert.equal(config.artefactName, "stugu-rpi4-1.2.3");
  assert.equal(config.deploy, true);
});

test("readConfig rejects non-HTTPS artifact URLs", () => {
  assert.throws(
    () => readConfig({ ...baseEnv, RPI_OTA_URI: "http://example.test/update.tar.zst" }),
    /must use HTTPS/,
  );
});

test("readConfig rejects malformed versions and device UUIDs", () => {
  assert.throws(
    () => readConfig({ ...baseEnv, RPI_OTA_VERSION: "1.2.3/../../replacement" }),
    /release-like version/,
  );
  assert.throws(
    () => readConfig({ ...baseEnv, RPI_CONNECT_DEVICE_ID: "a".repeat(36) }),
    /must be a UUID/,
  );
});

test("the appliance grows storage before local shared mounts without an ordering cycle", async () => {
  const [layer, growService, growScript, sharedInit] = await Promise.all([
    readFile(new URL("../../deploy/rpi/layer/stugu.yaml", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu-data-grow.service", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu-grow-persistent", import.meta.url), "utf8"),
    readFile(
      new URL("../../deploy/rpi/assets/rpi-persistent-shared-init", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(layer, /containerd\.service\.d\/stugu-shared-storage\.conf[\s\S]*Requires=stugu-data-grow\.service var-lib-containerd\.mount/);
  assert.match(layer, /docker\.service\.d\/stugu-shared-storage\.conf[\s\S]*Requires=stugu-data-grow\.service var-lib-docker\.mount var-lib-containerd\.mount/);
  assert.match(growService, /DefaultDependencies=no/);
  assert.match(growService, /Before=persistent-shared-init\.service var\.mount local-fs\.target/);
  assert.match(growService, /WantedBy=local-fs\.target/);
  assert.match(layer, /packages:[\s\S]*- gdisk/);
  assert.match(growScript, /sgdisk --move-second-header/);
  assert.match(growScript, /partition_label[\s\S]*persistent/);
  assert.match(growScript, /last_partition_number/);
  assert.match(growScript, /resize2fs/);
  assert.match(sharedInit, /\.stugu-seeded/);
  assert.match(sharedInit, /release .* already seeded/);
  assert.match(sharedInit, /if \[ -d "\$path" \]; then[\s\S]*rsync/);
  assert.match(layer, /rpi-persistent-shared-init"[\s\S]*\/usr\/local\/sbin\/stugu-persistent-shared-init/);
  assert.match(layer, /persistent-shared-init\.service\.d\/stugu\.conf[\s\S]*ExecStart=[\s\S]*ExecStart=\/usr\/local\/sbin\/stugu-persistent-shared-init/);
});

test("the appliance layer and build overrides use the declared Stugu variable prefix", async () => {
  const [layer, buildScript] = await Promise.all([
    readFile(new URL("../../deploy/rpi/layer/stugu.yaml", import.meta.url), "utf8"),
    readFile(new URL("../build-rpi-image.sh", import.meta.url), "utf8"),
  ]);

  assert.match(layer, /# X-Env-VarPrefix: stugu/);
  assert.match(layer, /\$\{IGconf_stugu_assetdir\}/);
  assert.match(buildScript, /"IGconf_stugu_api_image=\$api_image"/);
  assert.doesNotMatch(`${layer}\n${buildScript}`, /IGconf_stuga_/);
});

test("the USB appliance binds A/B slots to the firmware-selected boot disk", async () => {
  const [
    config,
    layer,
    resolver,
    rootBinder,
    rootUdevBinder,
    udevImporter,
    udevRules,
    initramfsHook,
    tryboot,
    rescuePatch,
    buildScript,
  ] = await Promise.all([
    readFile(new URL("../../deploy/rpi/config/stugu.yaml", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/layer/stugu.yaml", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu-usb-bootdev", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu-usb-ab-root", import.meta.url), "utf8"),
    readFile(
      new URL("../../deploy/rpi/assets/stugu-usb-udev-root", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../../deploy/rpi/assets/stugu-usb-udev-slot", import.meta.url), "utf8"),
    readFile(
      new URL("../../deploy/rpi/assets/99-rpi-00-stugu-usb.rules", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../deploy/rpi/assets/stugu-usb-initramfs-hook", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../../deploy/rpi/assets/rpi-slot-tryboot", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../../deploy/rpi/patches/0001-pi4-usb-rescue-bootconfig.patch",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(new URL("../build-rpi-image.sh", import.meta.url), "utf8"),
  ]);

  assert.match(config, /device:[\s\S]*storage_type: usb/);
  assert.match(resolver, /root-hub-port-number/);
  assert.match(resolver, /route-string/);
  assert.match(resolver, /usb-version/);
  assert.match(resolver, /\/lun/);
  assert.match(resolver, /bus\/usb\/devices/);
  assert.doesNotMatch(resolver, /match="sda"/);

  assert.match(rootBinder, /boot_mode[\s\S]*4\|5/);
  assert.match(rootBinder, /stugu-usb-bootdev/);
  for (const label of [
    "bootconfig",
    "boot_a",
    "boot_b",
    "system_a",
    "system_b",
    "persistent",
  ]) {
    assert.match(rootBinder, new RegExp(label));
  }
  assert.match(rootBinder, /active\/system/);
  assert.match(rootBinder, /other\/system/);
  assert.match(rootBinder, /bootconfig\)[\s\S]*active_suffix="a"/);
  assert.doesNotMatch(rootBinder, /ln -snf/);
  assert.match(rootBinder, /ln -sf "\$active_system_device"/);
  assert.match(rootBinder, /readlink "\$link_path"/);

  assert.match(rootUdevBinder, /\/run\/stugu-usb-ab-ready/);
  assert.match(rootUdevBinder, /readlink "\$\{slot_root\}\/\$\{alias_path\}"/);
  assert.match(rootUdevBinder, /KERNEL==\\?"\$\{partition\}\\?"/);
  assert.match(rootUdevBinder, /SYMLINK\+=\\?"\$\{devlink\}\\?"/);
  assert.match(rootUdevBinder, /mount -o bind "\$rule_source" "\$rule_target"/);
  assert.match(rootUdevBinder, /USB udev rules bound into real root/);

  assert.match(initramfsHook, /copy_exec \/usr\/bin\/stugu-usb-bootdev/);
  assert.match(initramfsHook, /copy_exec \/usr\/bin\/stugu-usb-udev-slot/);
  assert.match(initramfsHook, /99-rpi-00-stugu-usb\.rules/);
  assert.match(udevImporter, /stugu-usb-bootdev/);
  assert.match(udevImporter, /RPI_ONBOOTDEV=1/);
  assert.match(udevImporter, /STUGU_SLOT=/);
  assert.match(udevRules, /KERNEL=="sd\*\[0-9\]"/);
  assert.match(udevRules, /SYMLINK\+="\$env\{STUGU_SLOT\}"/);
  assert.match(layer, /stugu-usb-bootdev/);
  assert.match(layer, /scripts\/local-block\/20-stugu-usb-ab-root/);
  assert.match(layer, /scripts\/local-bottom\/20-stugu-usb-udev-root/);
  assert.match(layer, /scripts\/local-premount\/20-stugu-usb-ab-root/);
  assert.match(tryboot, /boot_label" = "bootconfig"/);
  assert.match(tryboot, /Pi 4 USB partition tryboot is disabled/);
  assert.match(tryboot, /exit 1/);
  assert.match(tryboot, /sed 's\/\^\[\^0-9\]\*\/\//);
  assert.match(rescuePatch, /size = 96M/);
  assert.match(rescuePatch, /extraargs = "-s 4 -S <SECTOR_SIZE>"/);
  assert.match(rescuePatch, /mountpoint = "\/boot\/rescue-firmware"/);
  assert.match(rescuePatch, /cp -a "\$\{fs\}\/boot\/firmware\/\." "\$\{rescue_boot_dir\}\/"/);
  assert.match(rescuePatch, /-      file "autoboot\.txt"/);
  assert.doesNotMatch(rescuePatch, /\+.*autoboot\.txt.*>|\+boot_partition=/);
  assert.doesNotMatch(layer, /rpi-connect-ota/);
  assert.match(buildScript, /config core\.autocrlf false/);
  assert.match(buildScript, /config core\.filemode false/);
  assert.match(
    buildScript,
    /restore \\\n  --source="\$rpi_image_gen_ref" --staged --worktree/,
  );
  assert.match(buildScript, /usb_rescue_patch_targets/);
  assert.match(buildScript, /apply --check "\$usb_rescue_patch"/);
  assert.match(buildScript, /IGconf_image_idp_schema=\$usb_idp_schema/);
  assert.match(buildScript, /"nvme", "usb"/);
});

test("clean appliance startup includes every runtime path and repairs interrupted Timescale init", async () => {
  const [dockerfile, composeStart, environment] = await Promise.all([
    readFile(new URL("../../Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu-compose-start", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu.env.example", import.meta.url), "utf8"),
  ]);

  assert.match(dockerfile, /COPY scripts\/stugu-update-agent\/ \.\/stugu-update-agent\//);
  assert.match(dockerfile, /COPY scripts\/cloudflare-stugu\/ \.\/cloudflare-stugu\//);
  assert.match(
    dockerfile,
    /COPY scripts\/stugu-migration-target \.\/scripts\/stugu-migration-target/,
  );
  assert.match(environment, /STUGA_APNS_SECRET_DIR=\/persistent\/stugu\/secrets\/apns/);
  assert.match(composeStart, /"\$state_dir\/secrets\/apns"/);
  assert.match(
    composeStart,
    /start_release\(\)[\s\S]*runtime-secrets[\s\S]*timescaledb[\s\S]*--profile maintenance run[\s\S]*timeseries-credential-reconcile[\s\S]*--remove-orphans/,
  );
});

test("the appliance exposes secure LAN access and persistent Tailscale by default", async () => {
  const [layer, environment, composeStart, control, tailscaleSource, eepromCompat] = await Promise.all([
    readFile(new URL("../../deploy/rpi/layer/stugu.yaml", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu.env.example", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu-compose-start", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stuguctl", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/tailscale-trixie.sources", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu-eeprom-compat", import.meta.url), "utf8"),
  ]);

  assert.match(tailscaleSource, /pkgs\.tailscale\.com\/stable\/debian[\s\S]*Suites: trixie/);
  assert.match(layer, /trixie\.noarmor\.gpg/);
  assert.match(layer, /packages:[\s\S]*- tailscale/);
  assert.match(layer, /Path=\/var\/lib\/tailscale/);
  assert.match(layer, /tailscaled\.service\.d[\s\S]*Requires=stugu-data-grow\.service var-lib-tailscale\.mount/);
  assert.match(layer, /enable-units "\$1" tailscaled stugu-data-grow stugu/);
  assert.match(environment, /^BIND_ADDRESS=0\.0\.0\.0$/mu);
  assert.match(composeStart, /dd if=\/dev\/urandom bs=32 count=1[\s\S]*LOCAL_AUTH_BOOTSTRAP_SECRET/);
  assert.match(control, /#bootstrap=%s/);
  assert.match(control, /tailscale up --operator=stugu/);
  assert.match(control, /known_good_release_env="\$state_dir\/last-known-good\.env"/);
  assert.match(
    control,
    /if valid_release_env "\$known_good_release_env"; then[\s\S]*release_env="\$known_good_release_env"/,
  );
  assert.match(layer, /systemd-networkd-wait-online --any --interface=eth0 --interface=wlan0 --timeout=30/);
  assert.match(layer, /BOOTFS="\/bootfs"/);
  assert.match(layer, /enable-units "\$1" tailscaled stugu-data-grow stugu-eeprom-compat stugu/);
  assert.match(eepromCompat, /desired_boot_order=0xf14/);
  assert.match(eepromCompat, /desired_self_update=1/);
  assert.match(eepromCompat, /desired_usb_power_off=0/);
});

test("factory builds fail closed unless Linux validates the complete SSD layout", async () => {
  const [buildScript, validator] = await Promise.all([
    readFile(new URL("../build-rpi-image.sh", import.meta.url), "utf8"),
    readFile(new URL("../validate-rpi-image.sh", import.meta.url), "utf8"),
  ]);

  assert.match(buildScript, /validate-rpi-image\.sh" "\$raw_image"[\s\S]*zstd/);
  assert.match(validator, /sfdisk --verify/);
  assert.match(validator, /partition table is not GPT/);
  for (const label of [
    "bootconfig",
    "boot_a",
    "boot_b",
    "system_a",
    "system_b",
    "persistent",
  ]) {
    assert.match(validator, new RegExp(`"${label}"`));
  }
  assert.match(validator, /protective MBR does not contain a GPT 0xEE entry/);
  assert.match(validator, /96 \* 1024 \* 1024/);
  assert.match(validator, /bootconfig rescue contains autoboot\.txt and can firmware-loop/);
  assert.match(validator, /bootconfig rescue/);
  assert.match(validator, /initramfs initramfs8 followkernel/);
  assert.match(validator, /2025-01-22 GPT autoboot partition-number fix/);
  assert.match(validator, /boot_a and boot_b differ/);
  assert.match(validator, /system_a and system_b differ/);
});

test("clean appliances default to guarded automatic GitHub container updates", async () => {
  const composeStart = await readFile(
    new URL("../../deploy/rpi/assets/stugu-compose-start", import.meta.url),
    "utf8",
  );

  assert.match(composeStart, /update-operations\/settings\.json/);
  assert.match(composeStart, /"mode": "automatic"/);
  assert.match(composeStart, /"includePrereleases": false/);
  assert.match(composeStart, /"updateDays": \["sun"\]/);
  assert.match(composeStart, /if \[\[ ! -e "\$state_dir\/update-operations\/settings\.json" \]\]/);
});

test("local publishing owns expensive builds and hosted release work is an explicit fallback", async () => {
  const [workflow, publisher] = await Promise.all([
    readFile(new URL("../../.github/workflows/rpi-release.yml", import.meta.url), "utf8"),
    readFile(new URL("../publish-local-release.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /confirm_hosted_build:/);
  assert.match(workflow, /if: \$\{\{ inputs\.confirm_hosted_build \}\}/);
  assert.match(workflow, /runs-on: ubuntu-24\.04-arm/);
  assert.doesNotMatch(workflow, /^\s{2}release:\s*$/mu);
  assert.doesNotMatch(workflow, /github\.event\.release/);
  assert.doesNotMatch(workflow, /deploy-rpi-ota|RPI_CONNECT_API_TOKEN/);

  assert.match(publisher, /linux\/amd64,linux\/arm64/);
  assert.match(publisher, /"buildx",\s*\n\s*"build"/);
  assert.match(publisher, /"linux\/amd64"[\s\S]*ARCH: "arm64"/);
  assert.match(publisher, /qemu-user-static/);
  assert.match(publisher, /binfmt_misc\/(?:qemu-)?aarch64/);
  assert.match(publisher, /"--volume",\s*\n\s*"\/rpi-build"/);
  assert.match(publisher, /RPI_BUILD_ROOT: "\/rpi-build"/);
  assert.match(publisher, /scripts\/build-rpi-image\.sh/);
  assert.match(publisher, /"release",\s*\n\s*"upload"/);
  assert.match(publisher, /--publish/);
  assert.doesNotMatch(publisher, /deploy-rpi-ota|Deploy OTA/);
  assert.doesNotMatch(publisher, /const paths = \[artifacts\.ota/);
  assert.match(workflow, /Attach validated factory image to GitHub release/);
});

test("local release options and output names are deterministic", () => {
  const options = parseArguments([
    "--tag",
    "v1.2.3",
    "--ssh-public-key",
    "recovery.pub",
    "--publish",
    "--reuse-containers",
    "--upload-factory",
  ]);
  assert.equal(options.tag, "v1.2.3");
  assert.equal(options.sshPublicKey, "recovery.pub");
  assert.equal(options.publish, true);
  assert.equal(options.reuseContainers, true);
  assert.equal(options.uploadFactory, true);

  assert.equal(
    repositoryFromRemote("git@github.com:liljestk/open-stuga.git"),
    "liljestk/open-stuga",
  );
  const images = imageDefinitions("ghcr.io/liljestk/open-stuga", "v1.2.3");
  assert.deepEqual(
    images.map(({ target }) => target),
    ["api", "web", "backup", "tapo-export-runner", "update-agent"],
  );
  assert.equal(images[0].ref, "ghcr.io/liljestk/open-stuga-api:v1.2.3");

  const artifacts = artifactDefinitions("/workspace", "1.2.3");
  assert.match(artifacts.ota, /stugu-rpi4-1\.2\.3-ota\.tar\.zst$/);
  assert.match(artifacts.factory, /stugu-rpi4-1\.2\.3\.img\.zst$/);
  assert.notEqual(artifacts.combinedChecksum, artifacts.releaseChecksum);
});

test("the local publisher invokes npm through Node on Windows", () => {
  assert.deepEqual(
    platformInvocation("npm", ["test"], {
      platform: "win32",
      env: { npm_execpath: "C:\\node\\npm-cli.js" },
      execPath: "C:\\node\\node.exe",
    }),
    {
      command: "C:\\node\\node.exe",
      args: ["C:\\node\\npm-cli.js", "test"],
    },
  );
  assert.throws(
    () => platformInvocation("npm", ["test"], { platform: "win32", env: {} }),
    /npm_execpath is required on Windows/,
  );
  assert.deepEqual(
    platformInvocation("npm", ["test"], { platform: "linux" }),
    { command: "npm", args: ["test"] },
  );
});

test("the factory image export uses the portable zstd output option", async () => {
  const buildScript = await readFile(
    new URL("../build-rpi-image.sh", import.meta.url),
    "utf8",
  );

  assert.match(buildScript, /zstd[^\n]+ -o "\$dist_dir\/\$factory_name"/);
  assert.doesNotMatch(buildScript, /--output/);
});

test("the appliance exposes a health-gated migration receiver with rollback", async () => {
  const [control, compose, composeStart, environment, layer] = await Promise.all([
    readFile(new URL("../../deploy/rpi/assets/stuguctl", import.meta.url), "utf8"),
    readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu-compose-start", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu.env.example", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/layer/stugu.yaml", import.meta.url), "utf8"),
  ]);
  assert.match(control, /migration_tool intent[\s\S]*target_safety_backup[\s\S]*stop_application_containers[\s\S]*migration_tool apply/);
  assert.match(control, /target_safety_backup[\s\S]*test -f \/app\/data\/integration-secrets\.json/);
  assert.match(control, /migration_tool apply[\s\S]*authorize_pending_health_check[\s\S]*systemctl restart stugu\.service && expected_release_is_healthy[\s\S]*commit_healthy_migration/);
  assert.match(control, /migration_tool commit "\$migration_id" "\$version" "\$healthy_at"/);
  assert.match(control, /resume\)[\s\S]*commit_healthy_migration[\s\S]*systemctl restart stugu\.service/);
  assert.match(control, /grep -Fxq "version=\$expected_version"/);
  assert.match(
    control,
    /expected_release_is_healthy\(\)[\s\S]*expected_version="\$\(sed -n 's\/\^STUGA_VERSION=\/\/p' "\$release_env" \| tail -n 1\)"/,
  );
  assert.doesNotMatch(
    control,
    /expected_release_is_healthy\(\)[\s\S]*expected_version="\$\(cat \/etc\/stugu-version\)"/,
  );
  assert.match(control, /Target health check failed; rolling back[\s\S]*quiesce_for_migration_rollback[\s\S]*migration_tool rollback/);
  assert.match(control, /current committed data was preserved/);
  assert.match(composeStart, /apply-intent\|applying\|rolling-back/);
  assert.match(composeStart, /applied-pending-health-check/);
  assert.match(composeStart, /health-check-authorization/);
  assert.match(composeStart, /stuguctl migration resume/);
  assert.match(composeStart, /Refusing to start over incomplete migration receipt/);
  assert.match(composeStart, /chown root:"\$appliance_user" "\$lock_file"[\s\S]*chmod 0660 "\$lock_file"/);
  assert.match(compose, /stugu-migration:[\s\S]*stugu-migration-target\.mjs/);
  assert.match(compose, /--include-secrets-if-present/);
  assert.match(compose, /STUGA_MIGRATION_DIRECTORY[^\n]*:\/app\/migrations/);
  assert.match(compose, /stuga-timeseries-data:\/app\/timeseries-data:ro/);
  assert.match(compose, /STUGA_MIGRATION_SETTINGS_DIRECTORY[^\n]*:\/app\/target-settings:z/);
  assert.match(compose, /STUGA_MIGRATION_ENV_FILENAME:-\.env/);
  assert.doesNotMatch(compose, /STUGA_MIGRATION_ENV_FILE[^\n]*:\/app\/target-settings/);
  assert.doesNotMatch(compose, /STUGA_CONFIG_DIRECTORY[^\n]*:\/app\/target-settings/);
  assert.match(environment, /STUGA_MIGRATION_DIRECTORY=\/persistent\/stugu\/migrations/);
  assert.match(environment, /STUGA_MIGRATION_SETTINGS_DIRECTORY=\/persistent\/stugu/);
  assert.match(environment, /STUGA_MIGRATION_ENV_FILENAME=stugu\.env/);
  assert.match(composeStart, /STUGA_MIGRATION_SETTINGS_DIRECTORY=\/persistent\/stugu/);
  assert.match(
    compose,
    /stugu-update-agent:[\s\S]*env_file:[\s\S]*path: \$\{STUGA_UPDATE_COMPOSE_ENV_FILE:-\.env\}[\s\S]*required: false/,
  );
  assert.match(environment, /STUGA_UPDATE_COMPOSE_ENV_FILE=\/persistent\/stugu\/stugu\.env/);
  assert.match(composeStart, /STUGA_UPDATE_COMPOSE_ENV_FILE=\/persistent\/stugu\/stugu\.env/);
  assert.match(layer, /STUGA_VERSION=\$\{IGconf_artefact_version\}/);
  assert.match(layer, /stugu-lock\.conf/);
});

test("live cutover fails closed when target state is ambiguous", async () => {
  const controller = await readFile(new URL("../stugu-live-migrate.mjs", import.meta.url), "utf8");
  assert.match(controller, /Source writers remain stopped to prevent split-brain/);
  assert.match(controller, /statusQueried && targetState === "rolled-back"/);
  assert.doesNotMatch(controller, /status\?\.receipt === null/);
  assert.match(controller, /Cutover always creates a fresh snapshot/);
});

test("ensureArtefact reuses an identical registered artifact", async () => {
  const config = readConfig(baseEnv);
  const existing = {
    id: "artifact-id",
    name: config.artefactName,
    uri: config.uri,
    checksum: config.checksum,
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response({ artefacts: [existing] });
  };

  assert.deepEqual(await ensureArtefact(config, fetchImpl), existing);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/organisation\/artefacts\?name=/);
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret-token");
});

test("createDeployment sends the artifact id as JSON", async () => {
  const config = readConfig(baseEnv);
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return response({ id: "deployment-id", state: "pending" }, 201);
  };

  const result = await createDeployment(config, "artifact-id", fetchImpl);
  assert.equal(result.id, "deployment-id");
  assert.match(request.url, new RegExp(`/devices/${config.deviceId}/deployments$`));
  assert.deepEqual(JSON.parse(request.init.body), { artefact_id: "artifact-id" });
});

test("waitForDeployment returns after a successful transition", async () => {
  const config = readConfig({ ...baseEnv, RPI_OTA_WAIT_MINUTES: "1" });
  const states = ["in_progress", "succeeded"];
  const fetchImpl = async () => response({ id: "deployment-id", state: states.shift() });
  const delayImpl = async () => {};

  const result = await waitForDeployment(config, "deployment-id", fetchImpl, delayImpl);
  assert.equal(result.state, "succeeded");
});
