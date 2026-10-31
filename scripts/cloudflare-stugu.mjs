#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { parse as parsePath, resolve } from "node:path";

import { pathToFileURL } from "node:url";

import { main } from "./cloudflare-stugu/verification.mjs";

export { CloudflareApiError } from "./cloudflare-stugu/configuration-client.mjs";

export { UsageError } from "./cloudflare-stugu/configuration-client.mjs";

export { cloudflareClient } from "./cloudflare-stugu/configuration-client.mjs";

export { parseArguments } from "./cloudflare-stugu/configuration-client.mjs";

export { provision } from "./cloudflare-stugu/provisioning.mjs";

export { readCoordinatorDeployment } from "./cloudflare-stugu/provisioning.mjs";

export { readDeployment } from "./cloudflare-stugu/provisioning.mjs";

export { readExistingDeployment } from "./cloudflare-stugu/tunnel-runtime.mjs";

export { renderRuntimeEnvironment } from "./cloudflare-stugu/tunnel-runtime.mjs";

export { stugubyProtocolApplicationSpec } from "./cloudflare-stugu/tunnel-runtime.mjs";

export { stugubyProtocolPolicySpec } from "./cloudflare-stugu/tunnel-runtime.mjs";

export { assistantConnectorApplicationSpec } from "./cloudflare-stugu/tunnel-runtime.mjs";

export { assistantConnectorPolicySpec } from "./cloudflare-stugu/tunnel-runtime.mjs";

export { validateOptions } from "./cloudflare-stugu/configuration-client.mjs";

export { validateToken } from "./cloudflare-stugu/configuration-client.mjs";

export { verifyCoordinator } from "./cloudflare-stugu/verification.mjs";

export { verifyDeployment } from "./cloudflare-stugu/verification.mjs";

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
