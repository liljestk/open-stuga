export const releaseManifestAsset = "stugu-release-manifest-v1.json";

export function releaseManifest(repository, version, tagName, imageRefs) {
  return {
    schema: "stugu-release-manifest/v1",
    repository,
    version,
    tagName,
    compatibility: {
      updateAgent: 3,
      compose: 2,
    },
    images: {
      api: imageRefs.api,
      web: imageRefs.web,
      backup: imageRefs.backup,
      tapo: imageRefs["tapo-export-runner"],
      updateAgent: imageRefs["update-agent"],
      mqtt: imageRefs.mqtt,
      nexus433: imageRefs.nexus433,
    },
  };
}
