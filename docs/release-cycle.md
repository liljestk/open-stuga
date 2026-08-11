# Application release cycle

This is the transferable agent/operator runbook for merging, tagging, building,
publishing, and verifying a Stugu application release. It is authoritative for
the public GitHub/GHCR appliance feed. The signed Raspberry Pi host-update
ceremony remains a separate trust domain in
[Signed host-update release](host-update-release.md).

## Boundaries and authorization

An agent may inspect code, pull requests, tags, release state, credentials,
Docker availability, and an appliance status without changing them. Explicit
authorization is required before each requested group of external mutations:

- merge a pull request;
- create or push source/feed tags;
- run the publisher with `--publish` (including `--keep-draft`);
- make a draft public or change stable/preview status;
- install on a named appliance.

A request to prepare or review a release does not imply those mutations. A
request to perform the complete release may authorize them together when the
version, channel, host generation, factory-upload choice, and target appliance
are unambiguous.

Use a fresh source checkout and a separate feed checkout. Do not switch or
clean a shared working tree. Never put private source commits, telemetry,
databases, migration captures, secrets, or private keys in the public feed.

## Release types

- **Application release:** container/application changes compatible with the
  current update-agent and Compose contracts. The Pi replaces only application
  services and retains its host OS and data.
- **Factory release:** a full disk image for a new or deliberately erased disk.
  Upload it only when it contains no Wi-Fi profile, Connect key, or other
  provisioning secret.
- **Host update:** signed RAUC/TUF immutable-root changes. Follow the host
  runbook; exact-device qualification and explicit activation remain separate.
- **Factory transition:** required for an incompatible updater/Compose/layout
  contract. Document backup, restore, and migration impact before release.

The standard application publisher still builds a factory image and public-
anchor-only host signing inputs. It therefore requires a monotonic host
generation, TUF root, RAUC CA, and host-update URL even when no signed host
update will be published.

## 1. Collect the release record

Start from a completed copy of the
[operator-context template](release-operator-context-template.md), kept outside
Git. On a configured build machine this may be `.stuga-release-context.md` at
the repository root; it is intentionally ignored and must be revalidated.
Record:

- version and release-notes file;
- pull request and intended merge commit;
- release type and migration/contract impact;
- stable or preview channel;
- next allocated host generation and its evidence;
- whether to upload the factory image;
- exact target appliance, current version, and channel.

Query channel history instead of copying an old assumption:

```powershell
gh release list --repo liljestk/stugu-releases --limit 30 `
  --json tagName,isDraft,isPrerelease,publishedAt
```

The TUF root JSON, RAUC CA PEM, host-update URL, and recovery SSH public key are
public trust/configuration inputs, not signing secrets. Their approved location
and hashes are operator-owned. GitHub/GHCR credentials and all signing private
keys remain secret.

Stop with an exact missing-field list if the operator context, channel choice,
generation allocation, or target identity is unavailable. Do not guess them.

## 2. Review and merge

Before asking to merge:

```powershell
git status --short --branch
git fetch origin main --tags
npm run version:check
git diff --check origin/main...HEAD
gh pr view <PR> --repo liljestk/open-stuga `
  --json state,isDraft,mergeStateStatus,headRefName,baseRefName,url
```

Confirm the release notes and changelog describe data migration, updater and
Compose compatibility, factory/host impact, and user-visible changes. Run the
tests proportionate to the change with `npm run verify:local -- --fast`. The
commit-pinned authoritative gate is `npm run verify:local -- --full`; the
publisher consumes its receipt and never reruns it. See
[Lean verification and appliance diagnosis](lean-tooling.md).

After explicit authorization, merge using the repository's current merge
policy, then observe `state: MERGED` and save the merge commit. Do not tag the
feature-branch commit.

For the current merge-commit policy, the mutating command and verification are:

```powershell
gh pr merge <PR> --repo liljestk/open-stuga --merge
gh pr view <PR> --repo liljestk/open-stuga --json state,mergeCommit,url
```

## 3. Create independent tags

Create the same annotated tag in two repositories, but never the same history:

1. In a separate checkout of public `liljestk/stugu-releases`, tag its harmless
   current `main` commit and push only that tag. Do not copy a source commit,
   tree, bundle, patch, or branch there.
2. In a fresh checkout of private `liljestk/open-stuga`, detach at the observed
   merge commit on `origin/main`, confirm the tree is clean and the version is
   exact, create the annotated source tag, and push only that tag.

Inspect both remote refs before creating anything:

```powershell
$Version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$Tag = "v$Version"
git ls-remote --tags https://github.com/liljestk/stugu-releases.git "refs/tags/$Tag*"
git ls-remote --tags origin "refs/tags/$Tag*"
```

After both checks return no tag and tag creation is authorized, use new empty
directories outside the shared workspace:

```powershell
$FeedCheckout = <NEW_EMPTY_FEED_DIRECTORY>
$SourceCheckout = <NEW_EMPTY_SOURCE_DIRECTORY>

git clone https://github.com/liljestk/stugu-releases.git $FeedCheckout
git -C $FeedCheckout fetch origin main --tags
git -C $FeedCheckout switch --detach origin/main
git -C $FeedCheckout status --porcelain
git -C $FeedCheckout tag -a $Tag -m "Stugu $Version release feed"
git -C $FeedCheckout push origin "refs/tags/$Tag"

git clone https://github.com/liljestk/open-stuga.git $SourceCheckout
git -C $SourceCheckout fetch origin main --tags
git -C $SourceCheckout switch --detach <OBSERVED_MERGE_COMMIT>
git -C $SourceCheckout merge-base --is-ancestor HEAD origin/main
git -C $SourceCheckout status --porcelain
Push-Location $SourceCheckout
npm ci
npm run version:check
git status --porcelain
git tag -a $Tag -m "Stugu $Version"
git push origin "refs/tags/$Tag"
Pop-Location
```

An existing tag is a stop for verification, not permission to delete, move, or
reuse it. The publisher later proves that the source tag is the clean checked-
out commit, is contained in `origin/main`, and is pushed. It separately proves
that the public feed tag exists.

## 4. Run read-only preflight and plan

From the fresh private-source checkout at the source tag:

```powershell
git status --porcelain
git rev-parse HEAD
git rev-parse "$Tag^{commit}"
git merge-base --is-ancestor HEAD origin/main
gh auth status
gh repo view liljestk/stugu-releases --json visibility,defaultBranchRef
docker version
docker buildx version
npm run version:check
npm run verify:local -- --full
Get-FileHash -Algorithm SHA256 <TUF_ROOT_JSON>, <RAUC_CA_PEM>
ssh-keygen -lf <RECOVERY_PUBLIC_KEY>
```

Then print the resolved plan. This example keeps the release draft and marks it
preview; change the channel only from the recorded decision:

```powershell
npm run release:local -- `
  --repository liljestk/stugu-releases `
  --image-prefix ghcr.io/liljestk/open-stuga `
  --notes-file "docs/release-notes-$Tag.md" `
  --host-generation <GENERATION> `
  --host-tuf-root <TUF_ROOT_JSON> `
  --host-rauc-ca <RAUC_CA_PEM> `
  --host-update-base-url <HOST_UPDATE_BASE_URL> `
  --ssh-public-key <RECOVERY_PUBLIC_KEY> `
  --full-ci-receipt <FULL_CI_RECEIPT> `
  --prerelease `
  --keep-draft
```

Without `--publish`, this command only prints a plan. It does **not** validate
files, tags, credentials, repository visibility, Docker, CI, or artifacts.

Add `--host-qualification` only for the exact appliance named by an immutable
qualification receipt. Add `--upload-factory` only after confirming the image
cannot contain provisioning secrets.

## 5. Build and prepare a draft

After explicit publishing authorization, rerun the exact reviewed command with
`--publish`. The recommended first publication is a draft:

```powershell
# Same arguments as the reviewed plan, plus:
npm run release:local -- <REVIEWED_ARGUMENTS> --keep-draft --publish
```

This is not a dry run. Before the GitHub draft exists, the publisher validates
the exact full-CI receipt, logs in to GHCR, builds and publicly pushes all seven AMD64/ARM64 image
tags, resolves their digests, and builds the Pi factory/host inputs. It then
creates or updates the draft and uploads:

- `stugu-release-manifest-v1.json`;
- the full-CI receipt and checksum;
- the host/container compatibility proof and checksum;
- the Nexus433 corresponding-source archive and checksum;
- the factory image and checksum only with `--upload-factory`.

The factory image and host signing inputs remain under ignored `dist/rpi/`.
Preserve required receipts in the ceremony store; never add raw output to Git.

## 6. Audit and publish the draft

Create the `DESIGN.md` visual-acceptance receipt and collect a healthy,
target-bound appliance receipt without changing the appliance:

```powershell
npm run rpi:doctor -- --target <SSH_TARGET>
npm run release:verify -- `
  --target <SSH_TARGET> `
  --target-receipt <DOCTOR_RECEIPT> `
  --visual-receipt <VISUAL_RECEIPT> `
  --channel preview
```

`release:verify` reuses only the exact full-CI receipt and verifies the artifact
manifest, anonymous AMD64/ARM64 image descriptor closure and source provenance,
compatibility proof, visual evidence, and target identity. It never rebuilds,
reruns CI, publishes, or reconnects to the appliance. Before making the draft
visible, verify:

- the CI receipt says `passed`, has a clean tree, and names the source commit;
- the manifest names the public feed, exact tag/version, expected compatibility
  contracts, all seven images, and only `tag@sha256:<64 hex>` references;
- every digest resolves for AMD64 and ARM64, and anonymous clients can read the
  feed and packages;
- the release notes, preview/stable flag, and optional factory assets match the
  release record;
- local host provenance contains the allocated generation and source commit.

Useful inspection commands:

```powershell
gh release view $Tag --repo liljestk/stugu-releases `
  --json isDraft,isPrerelease,assets,url
gh release download $Tag --repo liljestk/stugu-releases `
  --pattern stugu-release-manifest-v1.json --dir <EMPTY_AUDIT_DIRECTORY>
docker buildx imagetools inspect <IMAGE_TAG_AT_DIGEST>
```

After explicit authorization, publish by consuming the release-verification
receipt. The receipt fixes the reviewed stable/preview channel and must still
be fresh; finalization anonymously rechecks all container tags and both
platforms immediately before making the draft public:

```powershell
npm run release:local -- `
  --repository liljestk/stugu-releases `
  --verification-receipt <RELEASE_VERIFY_RECEIPT> `
  --publish
```

Fetch the manifest once without GitHub credentials after publication. A public
feed plus private GHCR packages is not a working anonymous appliance channel.

## 7. Install and verify

On the explicitly named appliance, first record:

```sh
npm run rpi:doctor -- --target <SSH_TARGET>
stuguctl backup
```

Copy a verified backup off-device when release impact warrants it. In Stugu,
use **Advanced -> System -> Check for updates -> Update now**, or wait for the
configured maintenance window. A preview release is invisible unless **Include
preview releases** is enabled.

After the update, run the default doctor again and verify the API/UI version,
service health, expected feature, recent data, and backup/rollback status. The
application updater backs up first, uses the digest-pinned manifest, replaces
application services, health-checks the candidate, and restores the known-good
release on a pre-commit failure. A signed host update is not installed by this
application-release step.

## Retention and cleanup

Treat cleanup as a separate, explicitly authorized mutation after publication
and appliance verification. Re-query GitHub, signed host targets, and appliance
inventory immediately before deleting anything; do not apply a saved list of
release or package IDs.

The minimum protected set is:

- the latest and previous published application release in **each** channel;
- every version reported as installed, known-good, or factory recovery by the
  managed appliances;
- every application version named by a current signed host target; and
- any draft, migration boundary, or recovery release still in active use.

Keep source and feed Git tags immutable. Keep lightweight manifests,
verification receipts, checksums, and the matching Nexus433 corresponding-
source archive. Never prune TUF roots, rotations, current metadata, or target
history as ordinary application cleanup. OCI cleanup must retain the complete
multi-platform index, child manifests, and attestations for every protected
image; an `untagged` label alone is not deletion evidence.

As of 10 August 2026, GitHub documents public Packages as free and Container
Registry storage/bandwidth as free, while Releases have no aggregate storage or
bandwidth quota. Recheck the current
[Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages)
and [Releases limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
before cleanup. Do not trade rollback or source-compliance evidence for an
assumed saving.
Where recovery policy permits, old large factory images are the preferred
release assets to move to an approved recovery store and remove from GitHub.

## Failure and rerun rules

- Before any remote write, fix the cause and rerun normally.
- If all seven correct container tags were pushed but the later build/upload
  failed, verify every tag first, then rerun with `--reuse-containers`.
- If only some tags exist, any digest is wrong, or a non-draft release is
  already public, stop. Prefer a new patch version; do not silently overwrite
  immutable release identity.
- Never delete/repoint public or source tags to conceal a failed ceremony.
- `--keep-draft` limits GitHub release visibility, not GHCR writes.
- Preserve logs and exact failure phase without copying credentials or private
  data into Git or chat.

## Host-signing boundary

The tracked publisher ends at validated public-anchor host inputs. Production
RAUC signing and TUF metadata publication require separate key custody and the
[host-update runbook](host-update-release.md). General release agents must not
receive signing private keys.

The repository tracks the host bundle builder and independent publication
verifier, but not a production TUF signing service. Ad-hoc helpers found under
ignored `dist/` are ceremony output, not canonical tooling. If a host release
is requested and the approved signer/TUF procedure is unavailable, report that
specific operational gap and stop; do not reconstruct a production ceremony
from old local files.

## Completion record

Report, without secrets:

- source PR, merge commit, source tag, and feed tag target;
- version, stable/preview status, release URL, and publication time;
- CI receipt result/commit and manifest SHA-256;
- seven immutable image references and architecture verification;
- host generation, trust-anchor fingerprints, factory-upload decision, and
  whether host signing was intentionally omitted;
- target appliance, before/after version and channel, backup receipt, health,
  and any rollback;
- retention inventory, protected versions, exact cleanup performed, and its
  post-delete verification;
- every incomplete step and the exact missing authority or operator input.
