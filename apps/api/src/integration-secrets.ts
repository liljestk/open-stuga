import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface IntegrationSecrets {
  version: 1;
  homeAssistant?: { url: string; token: string };
  tpLink?: { host: string; username: string; password: string };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function readIntegrationSecrets(path: string): IntegrationSecrets {
  if (!existsSync(path)) return { version: 1 };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (parsed.version !== 1) throw new Error("The integration secrets file has an unsupported version");

  const result: IntegrationSecrets = { version: 1 };
  if (parsed.homeAssistant !== undefined) {
    const value = parsed.homeAssistant as Record<string, unknown>;
    if (!value || !isNonEmptyString(value.url) || !isNonEmptyString(value.token)) {
      throw new Error("The Home Assistant credentials in the integration secrets file are invalid");
    }
    result.homeAssistant = { url: value.url.trim(), token: value.token };
  }
  if (parsed.tpLink !== undefined) {
    const value = parsed.tpLink as Record<string, unknown>;
    if (!value || !isNonEmptyString(value.host) || !isNonEmptyString(value.username) || !isNonEmptyString(value.password)) {
      throw new Error("The TP-Link credentials in the integration secrets file are invalid");
    }
    result.tpLink = { host: value.host.trim(), username: value.username.trim(), password: value.password };
  }
  return result;
}

export function writeIntegrationSecrets(path: string, secrets: IntegrationSecrets): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch { /* Windows ACLs are managed by the host. */ }

  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs are managed by the host. */ }
  renameSync(temporary, path);
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs are managed by the host. */ }
}

export function updateIntegrationSecrets(
  path: string,
  patch: { homeAssistant?: IntegrationSecrets["homeAssistant"] | null; tpLink?: IntegrationSecrets["tpLink"] | null },
): IntegrationSecrets {
  const next = readIntegrationSecrets(path);
  if (patch.homeAssistant === null) delete next.homeAssistant;
  else if (patch.homeAssistant !== undefined) next.homeAssistant = patch.homeAssistant;
  if (patch.tpLink === null) delete next.tpLink;
  else if (patch.tpLink !== undefined) next.tpLink = patch.tpLink;
  writeIntegrationSecrets(path, next);
  return next;
}
