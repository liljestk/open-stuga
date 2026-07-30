export const releaseManifestAsset = "stugu-release-manifest-v1.json";

export function releaseManifest(repository, version, tagName, imageRefs) {
  return {
    schema: "stugu-release-manifest/v1",
    repository,
    version,
    tagName,
    compatibility: {
      updateAgent: 2,
      compose: 1,
    },
    images: {
      api: imageRefs.api,
      web: imageRefs.web,
      backup: imageRefs.backup,
      tapo: imageRefs["tapo-export-runner"],
      updateAgent: imageRefs["update-agent"],
    },
  };
}
