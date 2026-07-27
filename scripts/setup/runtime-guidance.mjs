import { spawnSync } from "node:child_process";

import {
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

import { dirname, parse as parsePath, resolve } from "node:path";

import { createInterface } from "node:readline/promises";

import { Writable } from "node:stream";

import { fileURLToPath } from "node:url";

import {
  provision as provisionCloudflare,
  validateOptions as validateCloudflareOptions,
  validateToken as validateCloudflareToken,
  verifyDeployment as verifyCloudflareDeployment,
} from ".././cloudflare-stugu.mjs";

import {
  authorizeCloudflareSetup,
  cloudflareSetupOAuthScopes,
  DEFAULT_CLOUDFLARE_OAUTH_REDIRECT_URI,
  validateCloudflareOAuthClientId,
  validateCloudflareOAuthRedirectUri,
} from ".././cloudflare-oauth.mjs";

import { installUpdateAgentService } from ".././stugu-update-agent-service.mjs";

import { run, runtimeHelp } from "./configuration.mjs";

export function verifyContainerRuntime(mode, runner = run) {
  const command = mode;
  const version = runner(command, ["--version"], { quiet: true });
  if (version.error || version.status !== 0) {
    throw new Error(`${mode === "docker" ? "Docker" : "Podman"} is not available. ${runtimeHelp(mode)}`);
  }
  const validation = runner(command, ["compose", "config"], { quiet: true });
  if (validation.error || validation.status !== 0) {
    const recovery = mode === "docker"
      ? "Start Docker and check that Docker Compose is installed."
      : "Install a Compose provider and, on Windows/macOS, start the Podman machine.";
    throw new Error(`${mode === "docker" ? "Docker" : "Podman"} Compose could not validate docker-compose.yml. ${recovery}`);
  }
  const inspectionArguments = mode === "podman"
    ? ["info", "--format", "{{.Host.Security.Rootless}}"]
    : ["info", "--format", "{{json .SecurityOptions}}"];
  const inspection = runner(command, inspectionArguments, { capture: true });
  if (inspection.error || inspection.status !== 0) {
    throw new Error(`${mode === "docker" ? "Docker" : "Podman"} runtime details could not be inspected`);
  }
  const details = String(inspection.stdout ?? "").trim();
  const rootless = mode === "podman"
    ? details.toLowerCase() === "true"
    : /(?:name=)?rootless/iu.test(details);
  return { rootless };
}

export function printPiPlan(action) {
  console.log("\nRaspberry Pi keeps its configuration on the appliance, so the local .env was not changed.");
  if (action === "build") {
    console.log(`
Build on 64-bit Raspberry Pi OS Trixie, Debian Trixie, or Debian Bookworm:

  sudo apt update
  sudo apt install --yes git zstd
  ssh-keygen -t ed25519 -f ~/.ssh/stuga_appliance
  RPI_IMAGE_GEN_INSTALL_DEPS=1 \\
  RPI_SSH_PUBLIC_KEY_FILE="$HOME/.ssh/stuga_appliance.pub" \\
  bash scripts/build-rpi-image.sh

Then flash dist/rpi/stugu-rpi4-<version>.img.zst with Raspberry Pi Imager.`);
  } else {
    console.log(`
1. Verify the factory image checksum.
2. Flash the .img.zst file to a 16 GB or larger USB SSD with Raspberry Pi Imager.
3. Boot the Pi with Ethernet attached.
4. Connect securely:

   ssh -L 8080:127.0.0.1:8080 stugu@stugu.local

5. Open http://127.0.0.1:8080 and create the first owner.`);
  }
  console.log("\nFull guide: docs/raspberry-pi-appliance.md");
}

export function printNextSteps(configuration, started) {
  if (configuration.mode === "local") {
    console.log(`
Stugu is configured for ${configuration.data === "demo" ? "disposable demo data" : "a real home"}.
Run:  npm run dev
Open: http://localhost:5173`);
    return;
  }

  const runtime = configuration.mode;
  if (configuration.cloudflareUiPending) {
    console.log(`
Stugu is ready for secure-sharing setup in its UI.
Open locally: http://127.0.0.1:${configuration.port}
Then: create or sign in as the owner → Stugubys → Set up secure sharing.

${configuration.installUpdateAgent
    ? "The required host agent was installed."
    : "Before using UI setup, install the required host agent:\n  npm run update-agent:service:install"}
Keep Stugu on loopback until Cloudflare setup reports a verified connection.`);
    return;
  }

  if (configuration.cloudflare) {
    if (!started) {
      const approvalGuidance = configuration.cloudflare.tokenInput.startsWith("oauth")
        ? "Rerun setup to approve the temporary Cloudflare access in your browser."
        : configuration.cloudflare.tokenInput === "provision-prompt"
          ? "Rerun interactively to paste the one temporary approval, or supply\n--cloudflare-provision-token-file for non-interactive setup."
          : "Rerun interactively to paste hidden tokens, or supply both protected token-file\noptions for non-interactive setup.";
      console.log(`
Cloudflare plan is ready for https://${configuration.cloudflare.hostname}.
${approvalGuidance} Local recovery remains on:
http://localhost:${configuration.port}`);
      return;
    }
    console.log(`
Stugu is online and the Cloudflare security boundary was verified.
Open:           https://${configuration.cloudflare.hostname}
Local recovery: http://localhost:${configuration.port}
Stop public:    ${runtime} compose stop cloudflared

${configuration.cloudflare.provisionRequired === false
    ? "No new Cloudflare approval was retained."
    : configuration.cloudflare.tokenInput.startsWith("oauth")
      ? "The one-time Cloudflare OAuth access token was revoked automatically."
      : "Revoke the temporary setup token now."}
Keep the generated Cloudflare secret directory protected and keep the runtime
Access token active.`);
    if (configuration.cloudflare.mode === "stuguby-coordinator") {
      console.log("Create new Stuguby invitations only from the verified HTTPS address.");
    }
    return;
  }

  console.log(`
Stugu is configured for ${configuration.data === "demo" ? "disposable demo data" : "a real home"}.
${started ? "Started" : "Start"}: ${runtime} compose up --build -d
Open:    http://localhost:${configuration.port}
Stop:    ${runtime} compose down`);
  if (configuration.mode === "podman") {
    console.log("Note: the core stack is enabled; Docker-socket self-update is disabled under Podman.");
  }
  console.log("Keep a new install on loopback until the first owner account exists.");
}

export function printCloudflareDryRun(configuration) {
  if (configuration.cloudflareUiPending) {
    console.log("[setup] Would start Stugu on loopback and defer secure-sharing setup to the authenticated local UI");
    return;
  }
  if (!configuration.cloudflare) return;
  const cloudflare = configuration.cloudflare;
  console.log(`[setup] Would ${cloudflare.provisionRequired === false ? "reuse" : "provision"} ${cloudflare.mode} at https://${cloudflare.hostname}`);
  if (cloudflare.provisionRequired !== false) {
    console.log(`[setup] Would ${cloudflare.tokenInput === "files"
      ? "read the required protected token file or files"
      : cloudflare.tokenInput === "oauth"
        ? "request and revoke one temporary approval in Cloudflare's browser UI"
        : cloudflare.tokenInput === "oauth-prompt"
          ? "request temporary browser approval and prompt for the limited runtime token"
          : cloudflare.tokenInput === "provision-prompt"
            ? "reuse the retained runtime approval and request one temporary approval"
            : "request two different approvals through hidden prompts or protected files"}`);
  }
  console.log(`[setup] Would recreate api, web, and cloudflared, verify every public/protected path, and stop the connector if verification failed`);
}

export function printUpdateAgentDryRun(configuration) {
  if (!configuration.installUpdateAgent) return;
  console.log("[setup] Would install and start a per-user update-agent service with this account's Docker access");
}
