const MAX_RELEASE_MANIFEST_BYTES = 32 * 1024;
const RELEASE_MANIFEST_ASSET = "stugu-release-manifest-v1.json";

export const RELEASE_MANIFEST_SCHEMA = "stugu-release-manifest/v1";
export const UPDATE_REQUEST_SCHEMA = "stugu-system-update-request/v3";
export const UPDATE_AGENT_CONTRACT = 3;
export const COMPOSE_CONTRACT = 2;

export interface ReleaseIdentity {
  version: string;
  tagName: string;
}

export interface ReleaseManifest {
  schema: typeof RELEASE_MANIFEST_SCHEMA;
  repository: string;
  version: string;
  tagName: string;
  compatibility: {
    updateAgent: typeof UPDATE_AGENT_CONTRACT;
    compose: typeof COMPOSE_CONTRACT;
  };
  images: {
    api: string;
    web: string;
    backup: string;
    tapo: string;
    updateAgent: string;
    mqtt: string;
    nexus433: string;
  };
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_RELEASE_MANIFEST_BYTES) {
      await response.body?.cancel("release manifest exceeded the size limit");
      throw new Error("release manifest exceeded the size limit");
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_RELEASE_MANIFEST_BYTES) {
        await reader.cancel("release manifest exceeded the size limit");
        throw new Error("release manifest exceeded the size limit");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function immutableReleaseImage(
  imagePrefix: string,
  suffix: string,
  tagName: string,
  value: unknown,
): value is string {
  const prefix = `${imagePrefix}-${suffix}:${tagName}@sha256:`;
  return typeof value === "string"
    && value.startsWith(prefix)
    && value.length === prefix.length + 64
    && /^[0-9a-f]{64}$/.test(value.slice(prefix.length));
}

function releaseManifestFromJson(
  value: unknown,
  release: ReleaseIdentity,
  repository: string,
  imagePrefix: string,
): ReleaseManifest {
  if (!value || typeof value !== "object") throw new TypeError("Release manifest is not an object");
  const input = value as Partial<ReleaseManifest>;
  const images = input.images as Partial<ReleaseManifest["images"]> | undefined;
  if (
    input.schema !== RELEASE_MANIFEST_SCHEMA
    || input.repository !== repository
    || input.version !== release.version
    || input.tagName !== release.tagName
    || input.compatibility?.updateAgent !== UPDATE_AGENT_CONTRACT
    || input.compatibility?.compose !== COMPOSE_CONTRACT
    || !images
    || Object.keys(images).length !== 7
    || !immutableReleaseImage(imagePrefix, "api", release.tagName, images.api)
    || !immutableReleaseImage(imagePrefix, "web", release.tagName, images.web)
    || !immutableReleaseImage(imagePrefix, "backup", release.tagName, images.backup)
    || !immutableReleaseImage(imagePrefix, "tapo-export-runner", release.tagName, images.tapo)
    || !immutableReleaseImage(imagePrefix, "update-agent", release.tagName, images.updateAgent)
    || !immutableReleaseImage(imagePrefix, "mqtt", release.tagName, images.mqtt)
    || !immutableReleaseImage(imagePrefix, "nexus433", release.tagName, images.nexus433)
  ) {
    throw new TypeError("Release manifest identity, compatibility, or image digests are invalid");
  }
  return {
    schema: RELEASE_MANIFEST_SCHEMA,
    repository,
    version: release.version,
    tagName: release.tagName,
    compatibility: {
      updateAgent: UPDATE_AGENT_CONTRACT,
      compose: COMPOSE_CONTRACT,
    },
    images: {
      api: images.api,
      web: images.web,
      backup: images.backup,
      tapo: images.tapo,
      updateAgent: images.updateAgent,
      mqtt: images.mqtt,
      nexus433: images.nexus433,
    },
  };
}

export async function fetchReleaseManifest(options: {
  fetchImpl: typeof fetch;
  currentVersion: string;
  repository: string;
  imagePrefix: string;
  release: ReleaseIdentity;
}): Promise<ReleaseManifest> {
  const url = `https://github.com/${options.repository}/releases/download/${encodeURIComponent(options.release.tagName)}/${RELEASE_MANIFEST_ASSET}`;
  const response = await options.fetchImpl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": `Stugu/${options.currentVersion}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`release manifest returned HTTP ${response.status}`);
  const text = await boundedResponseText(response);
  return releaseManifestFromJson(
    JSON.parse(text) as unknown,
    options.release,
    options.repository,
    options.imagePrefix,
  );
}
