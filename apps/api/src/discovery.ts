import Bonjour from "bonjour-service";

export interface HomeAssistantDiscoveredInstance {
  name: string;
  url: string;
  host: string;
  port: number;
  version: string | null;
}

export interface HomeAssistantServiceRecord {
  name?: string;
  host?: string;
  port?: number;
  addresses?: string[];
  txt?: Record<string, unknown>;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Buffer.isBuffer(value)) {
    const decoded = value.toString("utf8").trim();
    return decoded || null;
  }
  return null;
}

function httpUrl(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

function usableAddress(addresses: string[] | undefined): string | null {
  return addresses?.find((address) => !address.startsWith("127.") && address !== "::1" && !address.startsWith("fe80:")) ?? null;
}

export function homeAssistantInstanceFromService(service: HomeAssistantServiceRecord): HomeAssistantDiscoveredInstance | null {
  const port = Number(service.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const txt = service.txt ?? {};
  const host = usableAddress(service.addresses) ?? text(service.host);
  const url = httpUrl(txt.internal_url) ?? (host
    ? `http://${host.includes(":") ? `[${host}]` : host}:${port}`
    : null);
  if (!host || !url) return null;
  return {
    name: text(txt.location_name) ?? text(service.name) ?? "Home Assistant",
    url,
    host,
    port,
    version: text(txt.version),
  };
}

export function discoverHomeAssistant(timeoutMs = 4_000): Promise<HomeAssistantDiscoveredInstance[]> {
  return new Promise((resolve, reject) => {
    const found = new Map<string, HomeAssistantDiscoveredInstance>();
    let settled = false;
    let browser: ReturnType<Bonjour["find"]> | null = null;
    let bonjour: Bonjour | null = null;
    let timer: NodeJS.Timeout | null = null;

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      browser?.stop();
      bonjour?.destroy();
      if (error) reject(error);
      else resolve([...found.values()].sort((a, b) => a.name.localeCompare(b.name)));
    }

    bonjour = new Bonjour(undefined, (error: Error) => finish(error));
    browser = bonjour.find({ type: "home-assistant", protocol: "tcp" }, (service) => {
      const instance = homeAssistantInstanceFromService(service);
      if (instance) found.set(instance.url, instance);
    });
    timer = setTimeout(() => finish(), timeoutMs);
  });
}
