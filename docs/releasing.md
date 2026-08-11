# Releasing

Stable publication is explicit and tag-gated. Merging ordinary changes to `main` runs CI but never publishes to npm.

## Quick Path

1. Invoke the project release skill with execution intent, such as `prepare a release`.
2. Reconcile any disagreement between `package.json`, stable tags, and npm before selecting a bump category.
3. Confirm the recommended major, minor, or patch category. The skill calculates the exact version and prepares a release PR on a branch.
4. Merge the reviewed release PR through the repository's normal PR protections.
5. After push CI succeeds for the merged SHA, give one immediate approval whose effect is explicit: creating and pushing annotated `vX.Y.Z` for that exact SHA will trigger automated npm publication and GitHub Release creation.
6. Do not give a second post-tag publication approval. Confirm the workflow reports the exact npm package and GitHub Release evidence.

## Release Gates

| Gate | Required evidence |
| --- | --- |
| Version | Stable tag format and exact equality with committed `package.json` version |
| Candidate | Annotated tag targets the current `origin/main` SHA; a stale tag fails closed |
| CI | A completed successful push run of `.github/workflows/ci.yml` for that exact SHA |
| GitHub Release state | Before npm publication, the API must prove the release is absent or is an existing non-draft, non-prerelease release whose tag and target SHA exactly match the candidate; unknown or conflicting state fails closed |
| Package | After preflight, the workflow publishes the exact `pnpm pack` tarball with the existing `NPM_TOKEN` and provenance enabled |
| Recovery | An existing npm version is accepted only when its registry integrity matches the exact local tarball; existing tags and incompatible GitHub Releases are never moved or mutated |
| Release notes | After npm publication or identity-matching npm recovery, notes are created only when preflight proved the GitHub Release absent; compatible existing releases are skipped and then verified |

The stale-tag policy is intentionally strict: the tag target must equal `origin/main` when the release workflow starts. If `main` advances, create a new tag only after CI succeeds for the new candidate; never retarget the old tag.

## One-Time Reconciliation

The repository currently has historical drift: `package.json` reports `0.7.0`, while the latest stable tag and npm `latest` are `1.3.0`. The release skill and workflow fail closed rather than choosing a version silently. Reconcile this in a reviewed release-preparation PR before the first release under this architecture.

## Recovery

Rerunning an unchanged tag is safe only when all identity checks pass before npm publication. A matching npm integrity with an absent GitHub Release can continue to release-note creation. An existing compatible stable GitHub Release is skipped and verified. Any mismatched integrity, draft or prerelease release, target-SHA mismatch, moved tag, stale candidate, or unknown registry/API error stops before npm publication.
