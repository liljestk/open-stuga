import { applyApiConfigDefaults, loadConfig } from "../config.js";
import type { CreateApiOptions } from "./support/index.js";

/** createApi's configuration: the caller's or the environment's, with createApi defaults applied. */
export function resolveApiConfig(context: { options: CreateApiOptions }) {
  const config = applyApiConfigDefaults(context.options.config ?? loadConfig());
  const cloudflareAccessRuntimeValues = [
      config.cloudflareAccessAccountId,
      config.cloudflareAccessGroupId,
      config.cloudflareAccessGroupName,
      config.cloudflareAccessApiToken,
      config.cloudflareAccessStaticEmails.length > 0 ? "configured" : null,
    ];
  if (cloudflareAccessRuntimeValues.some(Boolean) && !cloudflareAccessRuntimeValues.every(Boolean)) {
      throw new Error("Cloudflare Access synchronization requires a group identity, a static operator email, and an API token");
    }
  const extended = Object.assign(context, { config });
  return extended;
}

export type ApiConfigContext = ReturnType<typeof resolveApiConfig>;
