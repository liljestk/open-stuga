## Summary

Describe the user-visible outcome and any migration impact.

## Release

- [ ] I bumped the Stuga SemVer in the root/workspace manifests, lockfile, contract version, and runtime/OpenAPI versions.
- [ ] I added the release entry to `CHANGELOG.md`.
- [ ] I ran `npm run version:check`.

Pull-request CI also compares this release with the target branch and requires
the product version to be strictly newer.

Before `1.0.0`, breaking changes are permitted but must be called out explicitly in this PR and use at least a minor-version bump.

## Verification

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:coverage:python`
- [ ] `npm run build`
- [ ] `npm run smoke:built-api`
