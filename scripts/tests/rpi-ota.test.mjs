import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  releaseManifest,
  requirePublicReleaseRepository,
  requireReleaseRepositoryTag,
  repositoryFromRemote,
  validateHostReleaseSettings,
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

test("factory appliances generate persistent SSH host keys per installation", async () => {
  const [layer, sharedInit, hostKeyInit] = await Promise.all([
    readFile(new URL("../../deploy/rpi/layer/stugu.yaml", import.meta.url), "utf8"),
    readFile(
      new URL("../../deploy/rpi/assets/rpi-persistent-shared-init", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../deploy/rpi/assets/stugu-init-ssh-host-keys", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(layer, /find "\$1\/etc\/ssh"[^\n]*-name 'ssh_host_\*' -delete/);
  assert.match(layer, /Path=\/etc\/ssh/);
  assert.match(sharedInit, /\/etc\/ssh[\s\S]*--exclude='ssh_host_\*'/);
  assert.match(layer, /stugu-init-ssh-host-keys"[\s\S]*\/usr\/local\/sbin\/stugu-init-ssh-host-keys/);
  assert.match(layer, /ssh\.service\.d\/stugu-host-keys\.conf[\s\S]*Requires=etc-ssh\.mount[\s\S]*After=etc-ssh\.mount/);
  assert.match(layer, /ExecStartPost=\/usr\/local\/sbin\/stugu-init-ssh-host-keys/);
  assert.match(hostKeyInit, /\.stugu-ssh-host-keys-v1/);
  assert.match(hostKeyInit, /for key_type in dsa \$key_types/);
  assert.match(hostKeyInit, /ssh-keygen -A -f "\$shared_base"/);
  assert.match(hostKeyInit, /ssh-keygen -y -P '' -f "\$private_key"/);
  assert.match(hostKeyInit, /chmod 0600 "\$private_key"/);
  assert.match(hostKeyInit, /ssh-keygen -lf[\s\S]*-E sha256/);
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
    initramfsCompat,
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
    readFile(
      new URL(
        "../../deploy/rpi/assets/patch-initramfs-tools-monolithic.py",
        import.meta.url,
      ),
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
  assert.match(resolver, /linux_root_port=\$\(\(root_port - 1\)\)/);
  assert.match(resolver, /\/lun/);
  assert.match(resolver, /bus\/usb\/devices/);
  assert.doesNotMatch(resolver, /match="sda"/);

  assert.match(rootBinder, /boot_mode[\s\S]*4\|5/);
  assert.match(rootBinder, /1\)[\s\S]*boot_disk="mmcblk0"/);
  assert.match(rootBinder, /partition_separator="p"/);
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
  assert.match(rootBinder, /bootconfig_active_suffix\(\)/);
  assert.match(rootBinder, /STUGU_BOOTCONFIG_SLOT_FILE/);
  assert.match(rootBinder, /stugu-active-slot/);
  assert.match(rootBinder, /selected_suffix="a"/);
  assert.match(rootBinder, /a\|b\) selected_suffix="\$requested_suffix"/);
  assert.match(
    rootBinder,
    /bootconfig\)[\s\S]*active_suffix="\$\(bootconfig_active_suffix\)"/,
  );
  assert.doesNotMatch(rootBinder, /ln -snf/);
  assert.match(rootBinder, /ln -sf "\$active_system_device"/);
  assert.match(rootBinder, /readlink "\$link_path"/);

  assert.match(rootUdevBinder, /\/run\/stugu-usb-ab-ready/);
  assert.match(rootUdevBinder, /readlink "\$\{slot_root\}\/\$\{alias_path\}"/);
  assert.match(rootUdevBinder, /\/dev\/mmcblk\[0-9\]p\[0-9\]\*/);
  assert.match(rootUdevBinder, /KERNEL==\\?"\$\{partition\}\\?"/);
  assert.match(rootUdevBinder, /SYMLINK\+=\\?"\$\{devlink\}\\?"/);
  assert.match(rootUdevBinder, /mount -o bind "\$rule_source" "\$rule_target"/);
  assert.match(rootUdevBinder, /direct-boot udev rules bound into real root/);

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
  assert.match(rescuePatch, /printf 'a\\n' > "\$\{rescue_boot_dir\}\/stugu-active-slot"/);
  assert.match(rescuePatch, /-      file "autoboot\.txt"/);
  assert.doesNotMatch(rescuePatch, /\+.*autoboot\.txt.*>|\+boot_partition=/);
  assert.doesNotMatch(layer, /rpi-connect-ota/);
  assert.match(layer, /grep -qx 'auto_initramfs=1'/);
  assert.match(layer, /patch-initramfs-tools-monolithic\.py/);
  assert.doesNotMatch(layer, /kernel=kernel8\.img|initramfs initramfs8 followkernel/);
  assert.match(initramfsCompat, /source\.count\(old\) != 1/);
  assert.match(initramfsCompat, /find \. -false/);
  assert.match(initramfsCompat, /one compressed initramfs stream/);
  assert.match(layer, /rootdelay=6 cgroup_enable=memory/);
  assert.match(layer, /USB storage discovery races initramfs/);
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

test(
  "the Pi 4 USB resolver translates the firmware USB 3 root port",
  { skip: process.platform === "win32" },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "stugu-pi4-usb-resolver-"));
    const procRoot = join(directory, "proc");
    const sysRoot = join(directory, "sys");
    const usbDt = join(procRoot, "device-tree", "chosen", "bootloader", "usb");
    const usbDevice = join(sysRoot, "bus", "usb", "devices", "2-2");
    const blockPath = join(
      usbDevice,
      "2-2:1.0",
      "host0",
      "target0:0:0",
      "0:0:0:0",
      "block",
      "sda",
    );
    const decoyDevice = join(sysRoot, "bus", "usb", "devices", "2-3");
    const decoyBlockPath = join(
      decoyDevice,
      "2-3:1.0",
      "host1",
      "target1:0:0",
      "1:0:0:0",
      "block",
      "sdb",
    );

    try {
      mkdirSync(usbDt, { recursive: true });
      mkdirSync(blockPath, { recursive: true });
      mkdirSync(decoyBlockPath, { recursive: true });
      for (const [name, value] of [
        ["usb-version", 3],
        ["root-hub-port-number", 3],
        ["route-string", 0],
        ["lun", 0],
      ]) {
        const encoded = Buffer.alloc(4);
        encoded.writeUInt32BE(value);
        writeFileSync(join(usbDt, name), encoded);
      }
      writeFileSync(join(usbDevice, "devpath"), "2\n");
      writeFileSync(join(usbDevice, "version"), "3.00\n");
      writeFileSync(join(decoyDevice, "devpath"), "3\n");
      writeFileSync(join(decoyDevice, "version"), "3.00\n");

      const resolver = fileURLToPath(
        new URL("../../deploy/rpi/assets/stugu-usb-bootdev", import.meta.url),
      );
      const output = execFileSync("sh", [resolver], {
        encoding: "utf8",
        env: {
          ...process.env,
          STUGU_PROC_ROOT: procRoot,
          STUGU_SYS_ROOT: sysRoot,
        },
      });
      assert.equal(output, "sda\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

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
  assert.match(environment, /STUGA_R2_SECRET_DIR=\/persistent\/stugu\/secrets\/r2/);
  assert.match(composeStart, /"\$state_dir\/secrets\/apns"/);
  assert.match(composeStart, /"\$state_dir\/secrets\/r2"/);
  assert.match(
    composeStart,
    /STUGA_R2_SECRET_DIR=\/persistent\/stugu\/secrets\/r2/,
  );
  assert.match(
    composeStart,
    /start_release\(\)[\s\S]*runtime-secrets[\s\S]*timescaledb[\s\S]*--profile maintenance run[\s\S]*timeseries-credential-reconcile[\s\S]*--remove-orphans/,
  );
});

test("Compose and appliance upgrades expose bug reporting without leaking its token", async () => {
  const [compose, composeStart, environment] = await Promise.all([
    readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu-compose-start", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu.env.example", import.meta.url), "utf8"),
  ]);
  const api = compose.match(/^  api:\r?\n(?<body>[\s\S]*?)(?=^  stugu-update-agent:)/mu)?.groups?.body ?? "";

  assert.match(api, /BUG_REPORT_RELAY_URL: \$\{BUG_REPORT_RELAY_URL:-\}/);
  assert.match(api, /BUG_REPORT_RELAY_TOKEN_FILE: \/run\/secrets\/bug-report\/relay-token/);
  assert.match(api, /STUGA_BUG_REPORT_SECRET_DIR:-\.\/secrets\/bug-report/);
  assert.doesNotMatch(api, /^\s+BUG_REPORT_RELAY_TOKEN:/mu);
  assert.match(environment, /^BUG_REPORT_RELAY_URL=$/mu);
  assert.match(environment, /^STUGA_BUG_REPORT_SECRET_DIR=\/persistent\/stugu\/secrets\/bug-report$/mu);
  assert.match(composeStart, /"\$state_dir\/secrets\/bug-report"/);
  assert.match(composeStart, /STUGA_BUG_REPORT_SECRET_DIR=\/persistent\/stugu\/secrets\/bug-report/);
  assert.match(composeStart, /"BUG_REPORT_RELAY_URL="/);
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
  assert.match(layer, /packages:[\s\S]*- iproute2/);
  assert.match(layer, /Path=\/var\/lib\/tailscale/);
  assert.match(layer, /tailscaled\.service\.d[\s\S]*Requires=stugu-data-grow\.service var-lib-tailscale\.mount/);
  assert.match(layer, /enable-units "\$1" tailscaled stugu-data-grow stugu/);
  assert.match(environment, /^BIND_ADDRESS=0\.0\.0\.0$/mu);
  assert.match(composeStart, /dd if=\/dev\/urandom bs=32 count=1[\s\S]*LOCAL_AUTH_BOOTSTRAP_SECRET/);
  assert.match(control, /#bootstrap=%s/);
  assert.match(control, /tailscale up --operator=stugu/);
  assert.match(control, /known_good_release_env="\$state_dir\/update-release\/known-good-v3\.env"/);
  assert.match(
    control,
    /if \[\[ -e "\$known_good_release_env" \]\]; then[\s\S]*valid_release_env "\$known_good_release_env"[\s\S]*release_env="\$known_good_release_env"/,
  );
  assert.match(layer, /systemd-networkd-wait-online --any --interface=eth0 --interface=wlan0 --timeout=30/);
  assert.match(layer, /BOOTFS="\/bootfs"/);
  assert.match(layer, /enable-units "\$1" tailscaled stugu-data-grow stugu-eeprom-compat stugu/);
  assert.match(eepromCompat, /desired_boot_order=0xf14/);
  assert.match(eepromCompat, /desired_self_update=1/);
  assert.match(eepromCompat, /desired_usb_power_off=0/);
});

test("the appliance continuously synchronizes its host clock without blocking offline startup", async () => {
  const [layer, service, timesync] = await Promise.all([
    readFile(new URL("../../deploy/rpi/layer/stugu.yaml", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu.service", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu-timesyncd.conf", import.meta.url), "utf8"),
  ]);

  assert.match(layer, /packages:[\s\S]*- systemd-timesyncd/);
  assert.match(layer, /enable-units "\$1"[^\n]*systemd-timesyncd/);
  assert.match(layer, /stugu-timesyncd\.conf[\s\S]*systemd\/timesyncd\.conf\.d\/stugu\.conf/);
  assert.match(service, /^Wants=.*systemd-timesyncd\.service$/mu);
  assert.match(service, /^After=.*systemd-timesyncd\.service/mu);
  assert.doesNotMatch(service, /^Requires=.*systemd-timesyncd\.service$/mu);
  assert.match(timesync, /^NTP=0\.pool\.ntp\.org 1\.pool\.ntp\.org 2\.pool\.ntp\.org 3\.pool\.ntp\.org$/mu);
  assert.match(timesync, /^FallbackNTP=time\.cloudflare\.com time\.google\.com$/mu);
  assert.match(timesync, /^SaveIntervalSec=60$/mu);
});

test("recovery-key operators get exact host power commands without general sudo", async () => {
  const [layer, control] = await Promise.all([
    readFile(new URL("../../deploy/rpi/layer/stugu.yaml", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stuguctl", import.meta.url), "utf8"),
  ]);

  const sudoersMatch = layer.match(
    /cat > "\$1\/etc\/sudoers\.d\/020_stuguctl" <<-EOF\r?\n(?<body>[\s\S]*?)\r?\n\s+EOF/,
  );
  assert.ok(sudoersMatch?.groups?.body, "stuguctl sudoers policy is missing");
  const sudoersLines = sudoersMatch.groups.body
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  assert.deepEqual(sudoersLines, [
    "${IGconf_device_user1} ALL=(root) NOPASSWD: /usr/bin/systemctl start stugu.service",
    "${IGconf_device_user1} ALL=(root) NOPASSWD: /usr/bin/systemctl stop stugu.service",
    "${IGconf_device_user1} ALL=(root) NOPASSWD: /usr/bin/systemctl restart stugu.service",
    "${IGconf_device_user1} ALL=(root) NOPASSWD: /usr/bin/systemctl reboot",
    "${IGconf_device_user1} ALL=(root) NOPASSWD: /usr/bin/systemctl poweroff",
    "${IGconf_device_user1} ALL=(root) NOPASSWD: /usr/bin/tailscale up --operator=${IGconf_device_user1}",
  ]);

  const applicationValidation = control.indexOf(
    "if [[ \"$(grep -c '^SYSTEM_UPDATE_IMAGE_PREFIX='",
  );
  assert.ok(applicationValidation > 0, "application validation is missing");
  const recoveryControl = control.slice(0, applicationValidation);
  assert.match(
    recoveryControl,
    /reboot\)\s+\[\[ "\$#" -eq 1 \]\][\s\S]*exec sudo -n \/usr\/bin\/systemctl reboot/,
  );
  assert.match(
    recoveryControl,
    /poweroff\)\s+\[\[ "\$#" -eq 1 \]\][\s\S]*exec sudo -n \/usr\/bin\/systemctl poweroff/,
  );
  assert.doesNotMatch(recoveryControl, /systemctl "\$@"/);
});

test("factory builds fail closed unless Linux validates the complete SSD layout", async () => {
  const [buildScript, validator] = await Promise.all([
    readFile(new URL("../build-rpi-image.sh", import.meta.url), "utf8"),
    readFile(new URL("../validate-rpi-image.sh", import.meta.url), "utf8"),
  ]);

  assert.match(buildScript, /validate-rpi-image\.sh" "\$raw_image"[\s\S]*zstd/);
  assert.match(buildScript, /readonly target_dir="\$build_root\/chroot-\$version"/u);
  assert.match(
    buildScript,
    /readonly sbom_source="\$target_dir\/stugu-host-sbom\.spdx\.json"/u,
  );
  assert.doesNotMatch(
    buildScript,
    /readonly sbom_source="\$output_dir\/stugu-host-sbom\.spdx\.json"/u,
  );
  assert.match(buildScript, /TUF root roles \{left\} and \{right\} must use separate keys/u);
  assert.match(buildScript, /timedelta\(days=365\)/u);
  assert.match(buildScript, /2\*\*53 - 1/u);
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
  assert.match(validator, /bootconfig rescue does not default its direct boot to slot A/);
  assert.match(validator, /bootconfig rescue/);
  assert.match(validator, /does not enable automatic initramfs loading/);
  assert.match(validator, /unsafe explicit kernel\/initramfs override/);
  assert.match(validator, /initramfs8 is not a single zstd stream/);
  assert.match(validator, /initramfs8 contains data outside its zstd stream/);
  assert.match(validator, /does not wait for root storage/);
  assert.match(validator, /does not include rootdelay=6/);
  assert.match(validator, /does not enable memory cgroups/);
  assert.match(validator, /diagnostic netconsole configuration/);
  assert.match(validator, /direct-boot payload differs from bootconfig rescue/);
  assert.match(validator, /2025-01-22 GPT autoboot partition-number fix/);
  assert.match(validator, /boot_a and boot_b differ/);
  assert.match(validator, /system_a and system_b differ/);
});

test("host boot-control records live outside FAT and activation is qualification-gated", async () => {
  const [patch, validator, layer, daemonUnit, bootstrapUnit, qualification, raucConfig, watchdog] = await Promise.all([
    readFile(new URL("../../deploy/rpi/patches/0001-pi4-usb-rescue-bootconfig.patch", import.meta.url), "utf8"),
    readFile(new URL("../validate-rpi-image.sh", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/layer/stugu.yaml", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu-host-updated.service", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu-host-bootstrap.service", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu-hardware-qualification.json", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu-rauc-system.conf", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/rpi/assets/stugu-system-watchdog.conf", import.meta.url), "utf8"),
  ]);
  assert.match(patch, /partition bootconfig[\s\S]*size = 96M/u);
  assert.match(patch, /final MiB outside FAT[\s\S]*size = 95M/u);
  assert.match(validator, /fixed record tail is not zero-initialized/u);
  assert.match(layer, /stugu-host-bootstrap\.service/u);
  assert.match(layer, /enable-units[\s\S]*stugu-host-bootstrap/u);
  assert.match(daemonUnit, /^Group=stugu$/mu);
  assert.match(daemonUnit, /^RuntimeDirectory=stugu-host-update$/mu);
  assert.match(daemonUnit, /^RuntimeDirectoryMode=0750$/mu);
  assert.doesNotMatch(`${daemonUnit}\n${bootstrapUnit}`, /ProtectSystem|PrivateTmp|ReadWritePaths/u);
  assert.equal(JSON.parse(qualification).activationEnabled, false);
  assert.deepEqual(JSON.parse(qualification).recordOffsets, [99614720, 99618816]);
  assert.match(raucConfig, /compatible=stugu-rpi4-usb:stugu-gpt-ab-v2:arm64/u);
  assert.match(raucConfig, /check-purpose=codesign/u);
  assert.match(watchdog, /RuntimeWatchdogSec=0s/u);
  assert.match(layer, /-name '\*\.pyc'[\s\S]*-name __pycache__/u);
  assert.match(
    await readFile(new URL("../build-rpi-image.sh", import.meta.url), "utf8"),
    /Generated from the immutable hardware qualification receipt[\s\S]*RuntimeWatchdogSec=\{seconds\}s/u,
  );
  const builder = await readFile(new URL("../build-rpi-image.sh", import.meta.url), "utf8");
  assert.match(builder, /aarch64-linux-gnu-gcc/u);
  assert.match(builder, /-Werror -static/u);
  assert.match(builder, /boot selector is not an AArch64 executable/u);
  assert.match(builder, /boot selector must be static for early initramfs/u);
});

test("host releases include and inspect RAUC's extraction and service runtime", async () => {
  const [layer, builder, publisher] = await Promise.all([
    readFile(new URL("../../deploy/rpi/layer/stugu.yaml", import.meta.url), "utf8"),
    readFile(new URL("../build-rpi-image.sh", import.meta.url), "utf8"),
    readFile(new URL("../publish-local-release.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(layer, /packages:[\s\S]*- rauc[\s\S]*- rauc-service[\s\S]*- squashfs-tools/u);
  assert.match(publisher, /apt-get install[^"\n]*\berofs-utils\b/u);
  assert.match(builder, /dump\.erofs --path="\$required_host_runtime"/u);
  assert.match(builder, /\/usr\/bin\/rauc \/usr\/bin\/unsquashfs/u);
  assert.match(builder, /Access: 0755\//u);
  assert.match(builder, /\/usr\/lib\/systemd\/system\/rauc\.service:0644/u);
  assert.match(
    builder,
    /\/usr\/share\/dbus-1\/system-services\/de\.pengutronix\.rauc\.service:0644/u,
  );
  assert.match(builder, /\/usr\/share\/dbus-1\/system\.d\/de\.pengutronix\.rauc\.conf:0644/u);
  assert.match(builder, /\/usr\/share\/rauc\/rauc-service\.sh:0755/u);
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

test("contract-3 boot preserves older rollback state without executing mutable tags", async () => {
  const composeStart = await readFile(
    new URL("../../deploy/rpi/assets/stugu-compose-start", import.meta.url),
    "utf8",
  );

  assert.match(composeStart, /legacy_known_good_env="\$state_dir\/last-known-good\.env"/);
  assert.doesNotMatch(
    composeStart,
    /install[\s\S]{0,180}"\$legacy_known_good_env" "\$known_good_env"/,
  );
  assert.match(
    composeStart,
    /valid_legacy_release\(\)[\s\S]*wc -l[\s\S]*STUGA_UPDATE_AGENT_IMAGE=/,
  );
  assert.match(
    composeStart,
    /archive_legacy_release\(\)[\s\S]*\.legacy-v1[\s\S]*mv -- "\$candidate" "\$archive"/,
  );
  assert.match(
    composeStart,
    /elif valid_legacy_release "\$update_release_env"; then[\s\S]*archive_legacy_release "\$update_release_env" "candidate release"/,
  );
});

test("appliance updates preserve the published release repository and GHCR credentials", async () => {
  const [buildScript, publisher, environment, composeStart, control, compose] =
    await Promise.all([
      readFile(new URL("../build-rpi-image.sh", import.meta.url), "utf8"),
      readFile(new URL("../publish-local-release.mjs", import.meta.url), "utf8"),
      readFile(new URL("../../deploy/rpi/assets/stugu.env.example", import.meta.url), "utf8"),
      readFile(new URL("../../deploy/rpi/assets/stugu-compose-start", import.meta.url), "utf8"),
      readFile(new URL("../../deploy/rpi/assets/stuguctl", import.meta.url), "utf8"),
      readFile(new URL("../../docker-compose.yml", import.meta.url), "utf8"),
    ]);

  assert.match(environment, /^SYSTEM_UPDATE_REPOSITORY=liljestk\/open-stuga$/mu);
  assert.match(environment, /^SYSTEM_UPDATE_IMAGE_PREFIX=ghcr\.io\/liljestk\/open-stuga$/mu);
  assert.match(environment, /^STUGA_DOCKER_CONFIG_DIRECTORY=\/persistent\/stugu\/docker-config$/mu);
  assert.match(buildScript, /STUGA_RELEASE_REPOSITORY/);
  assert.match(
    buildScript,
    /stugu\.env\.example" "\$release_repository" "\$image_prefix"[\s\S]*SYSTEM_UPDATE_REPOSITORY[\s\S]*SYSTEM_UPDATE_IMAGE_PREFIX/,
  );
  assert.match(publisher, /STUGA_RELEASE_REPOSITORY: repository/);
  assert.match(publisher, /Release \$\{tag\} is already published and immutable/);
  assert.match(publisher, /Release repository \$\{repository\} must be public/);
  assert.doesNotMatch(publisher, /--skip-checks|skipChecks/);
  assert.match(composeStart, /SYSTEM_UPDATE_REPOSITORY SYSTEM_UPDATE_IMAGE_PREFIX/);
  assert.match(composeStart, /"\$\{image_prefix\}-api:v\$version"/);
  assert.match(control, /"\$\{image_prefix\}-api:v\$version"/);
  assert.doesNotMatch(
    `${composeStart}\n${control}`,
    /"ghcr\.io\/liljestk\/open-stuga-api:v\$version"/,
  );
  assert.match(
    compose,
    /DOCKER_CONFIG: \/persistent\/stugu\/docker-config[\s\S]*STUGA_DOCKER_CONFIG_DIRECTORY:-\.\/data\/docker-config/,
  );
});

test("local publishing owns expensive builds and hosted release work is an explicit fallback", async () => {
  const [workflow, publisher] = await Promise.all([
    readFile(new URL("../../.github/workflows/rpi-release.yml", import.meta.url), "utf8"),
    readFile(new URL("../publish-local-release.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /confirm_hosted_build:/);
  assert.match(
    workflow,
    /if: \$\{\{ inputs\.confirm_hosted_build \}\}/,
  );
  assert.doesNotMatch(workflow, /confirm_nexus433_compliance/);
  assert.match(workflow, /runs-on: ubuntu-24\.04-arm/);
  assert.match(
    workflow,
    /source_bundle:[\s\S]*Build and verify corresponding source[\s\S]*Preserve source before publishing containers[\s\S]*containers:[\s\S]*needs: source_bundle/,
  );
  assert.match(
    workflow,
    /Download verified corresponding source[\s\S]*stugu-nexus433-corresponding-source-[\s\S]*Attach validated factory image to GitHub release[\s\S]*files:[\s\S]*steps\.ota\.outputs\.source_path/,
  );
  assert.doesNotMatch(workflow, /^\s{2}release:\s*$/mu);
  assert.doesNotMatch(workflow, /github\.event\.release/);
  assert.doesNotMatch(workflow, /deploy-rpi-ota|RPI_CONNECT_API_TOKEN/);
  assert.match(
    workflow,
    /writeFileSync\("dist\/rpi\/release\/stugu-release-manifest-v1\.json"[\s\S]*writeFileSync\("dist\/rpi\/host-inputs\/stugu-release-manifest-v1\.json"/u,
  );
  assert.match(workflow, /Upload host inputs for the isolated RAUC signer/u);
  assert.doesNotMatch(workflow, /RPI_HOST_(?:RAUC|TUF)_(?:PRIVATE_)?KEY/u);
  assert.doesNotMatch(workflow, /build-host-update-bundle|build:host-bundle/u);
  assert.match(workflow, /overwrite_files: false/u);

  assert.match(publisher, /linux\/amd64,linux\/arm64/);
  assert.match(publisher, /"buildx",\s*\n\s*"build"/);
  assert.match(publisher, /"linux\/amd64"[\s\S]*ARCH: "arm64"/);
  assert.match(publisher, /qemu-user-static/);
  assert.match(publisher, /gcc-aarch64-linux-gnu/);
  assert.match(publisher, /libc6-dev-arm64-cross/);
  assert.match(publisher, /binfmt_misc\/(?:qemu-)?aarch64/);
  assert.match(publisher, /"--volume",\s*\n\s*"\/rpi-build"/);
  assert.match(publisher, /RPI_BUILD_ROOT: "\/rpi-build"/);
  assert.match(publisher, /scripts\/build-rpi-image\.sh/);
  assert.match(publisher, /ci:local/);
  assert.match(publisher, /--skip-container-builds/);
  assert.match(publisher, /localCiReport/);
  assert.match(publisher, /"release",\s*\n\s*"upload"/);
  assert.doesNotMatch(publisher, /confirm-nexus433-compliance/);
  assert.match(publisher, /artifacts\.nexus433SourceChecksum/);
  assert.match(
    publisher,
    /copyFileSync\(artifacts\.releaseManifest, artifacts\.hostContainerManifest\)/u,
  );
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
    "--host-generation",
    "42",
    "--host-tuf-root",
    "root.json",
    "--host-rauc-ca",
    "rauc-ca.pem",
    "--host-update-base-url",
    "https://updates.example.test/stugu",
    "--publish",
    "--prerelease",
    "--keep-draft",
    "--reuse-containers",
    "--upload-factory",
  ]);
  assert.equal(options.tag, "v1.2.3");
  assert.equal(options.sshPublicKey, "recovery.pub");
  assert.equal(options.hostGeneration, "42");
  assert.equal(options.hostTufRoot, "root.json");
  assert.equal(options.publish, true);
  assert.equal(options.prerelease, true);
  assert.equal(options.keepDraft, true);
  assert.equal(options.reuseContainers, true);
  assert.equal(options.uploadFactory, true);
  assert.throws(() => parseArguments(["--skip-checks"]), /Unknown argument/);
  assert.doesNotThrow(() => validateHostReleaseSettings({
    generation: "42",
    baseUrl: "https://updates.example.test/stugu",
  }));
  assert.throws(
    () => validateHostReleaseSettings({ generation: "0", baseUrl: "http://updates.test" }),
    /generation/u,
  );
  assert.doesNotThrow(() => requirePublicReleaseRepository("owner/releases", "PUBLIC"));
  assert.throws(
    () => requirePublicReleaseRepository("owner/private-source", "PRIVATE"),
    /must be public/,
  );
  assert.doesNotThrow(() => requireReleaseRepositoryTag("owner/releases", "v1.2.3", 0));
  assert.throws(
    () => requireReleaseRepositoryTag("owner/releases", "v1.2.3", 1),
    /must already contain its own v1\.2\.3 tag/,
  );

  assert.equal(
    repositoryFromRemote("git@github.com:liljestk/open-stuga.git"),
    "liljestk/open-stuga",
  );
  const images = imageDefinitions("ghcr.io/liljestk/open-stuga", "v1.2.3");
  assert.deepEqual(
    images.map(({ target }) => target),
    ["api", "web", "backup", "tapo-export-runner", "update-agent", "mqtt", "nexus433"],
  );
  assert.equal(images[0].ref, "ghcr.io/liljestk/open-stuga-api:v1.2.3");

  const artifacts = artifactDefinitions("/workspace", "1.2.3");
  assert.match(artifacts.ota, /stugu-rpi4-1\.2\.3-ota\.tar\.zst$/);
  assert.match(artifacts.factory, /stugu-rpi4-1\.2\.3\.img\.zst$/);
  assert.match(artifacts.localCiReport, /stugu-1\.2\.3-local-ci\.json$/);
  assert.equal(artifacts.localCiChecksum, `${artifacts.localCiReport}.sha256`);
  assert.match(artifacts.releaseManifest, /stugu-release-manifest-v1\.json$/);
  assert.match(artifacts.hostBoot, /host-inputs[\\/]boot\.vfat$/);
  assert.match(artifacts.hostRoot, /host-inputs[\\/]system\.erofs$/);
  assert.match(artifacts.hostContainerManifest, /host-inputs[\\/]stugu-release-manifest-v1\.json$/);
  assert.match(artifacts.hostBundle, /stugu-rpi4-1\.2\.3-host\.raucb$/);
  assert.equal(artifacts.hostTargetRequest, `${artifacts.hostBundle}.tuf-target.json`);
  assert.match(
    artifacts.nexus433Source,
    /stugu-nexus433-corresponding-source-1\.2\.3\.tar\.gz$/,
  );
  assert.equal(artifacts.nexus433SourceChecksum, `${artifacts.nexus433Source}.sha256`);
  assert.notEqual(artifacts.combinedChecksum, artifacts.releaseChecksum);

  const digests = Object.fromEntries(images.map(({ target, ref }) => [
    target,
    `${ref}@sha256:${"a".repeat(64)}`,
  ]));
  assert.deepEqual(
    releaseManifest("liljestk/open-stuga", "1.2.3", "v1.2.3", digests),
    {
      schema: "stugu-release-manifest/v1",
      repository: "liljestk/open-stuga",
      version: "1.2.3",
      tagName: "v1.2.3",
      compatibility: { updateAgent: 3, compose: 2 },
      images: {
        api: digests.api,
        web: digests.web,
        backup: digests.backup,
        tapo: digests["tapo-export-runner"],
        updateAgent: digests["update-agent"],
        mqtt: digests.mqtt,
        nexus433: digests.nexus433,
      },
    },
  );
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
  assert.match(
    compose,
    /\$\{STUGA_TIMESERIES_DATA_SOURCE:-stuga-timeseries-data\}:\/app\/timeseries-data:ro/,
  );
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
  assert.match(compose, /STUGA_COMPOSE_PROJECT_NAME: \$\{STUGA_COMPOSE_PROJECT_NAME:-stuga\}/);
  assert.match(environment, /STUGA_COMPOSE_PROJECT_NAME=stugu/);
  assert.match(composeStart, /STUGA_COMPOSE_PROJECT_NAME=stugu/);
  assert.match(compose, /STUGA_FACTORY_RELEASE_ENV_FILE: \/opt\/stugu\/release\.env/);
  assert.match(
    compose,
    /STUGA_KNOWN_GOOD_RELEASE_ENV_FILE: \/persistent\/stugu\/update-release\/known-good-v3\.env/,
  );
  assert.match(layer, /STUGA_RELEASE_ENV_SCHEMA=3/);
  assert.match(layer, /STUGA_UPDATE_AGENT_CONTRACT=3/);
  assert.match(layer, /STUGA_COMPOSE_CONTRACT=2/);
  assert.match(composeStart, /@sha256:\$digest/);
  assert.doesNotMatch(composeStart, /STUGA_API_IMAGE=ghcr[^"\n]*:v\$version"/);
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
