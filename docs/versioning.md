# Versioning and pre-1.0 change policy

Stugu uses Semantic Versioning for the product release shown by the local API,
web/API packages, shared contracts, and Apple app metadata. The current release is `0.35.5`.

Before `1.0.0`, the data model, API, configuration, and UI may change in
backwards-incompatible ways while the architecture is still being established.
Those changes are intentional but not silent:

- every feature or breaking-change pull request increments the minor version;
- a compatible bug/documentation-only release increments the patch version;
- every pull request updates `CHANGELOG.md` and describes migration impact;
- the root and workspace manifests, root lockfile, shared contract version,
  compiled API runtime version, this release document, and checked-in XcodeGen
  and Xcode marketing versions must agree;
- `npm run version:check` enforces that agreement and the changelog entry;
- local CI compares the product version with the merge base and rejects a
  change unless its version is strictly newer;
- independently versioned model/API contracts retain their own version fields.

At `1.0.0`, public compatibility becomes the default. Breaking changes will
require a major product/API version, a documented migration, and an explicit
deprecation window where practical.

The release number does not replace `/api/v1` or `/api/v2`: those paths identify
API contract families, while the product version identifies the shipped system.
