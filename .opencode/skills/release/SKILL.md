---
name: release
description: "Trigger: vamos a sacar una release, sacar una release, prepare a release, publish a release. Execute the explicit tag-gated release process; stay quiet for architecture-only discussion."
license: Apache-2.0
metadata:
  author: "Joaquinvesapa"
  version: "1.0"
---

# Release

## Activation Contract

Activate only when the user intends to execute or prepare a release. Do not activate for release architecture, workflow design, or general SemVer discussion.

## Hard Rules

- Inspect fresh repository, GitHub, npm, manifest, tag, PR, and CI state on every invocation.
- Use `pnpm`; keep the committed `package.json` version authoritative and never use runtime version mutation.
- Never choose a bump category or merge a PR without the exact human confirmation for that action. The annotated tag push is the publication approval: ask once immediately before it, state that creating and pushing `vX.Y.Z` for the exact SHA will trigger automated npm publication and GitHub Release creation, and never ask for a second post-tag publication approval.
- Never move an existing tag or republish an existing npm version. If identity cannot be proven, stop with a recovery command.

## Decision Gates

| State | Action |
| --- | --- |
| A. Sources disagree or worktree is unsafe | Stop. Reconcile package metadata, latest stable `vX.Y.Z` tag, npm `latest`, and local changes explicitly; never infer the reconciliation version. |
| B. No release-preparation version commit/PR | Analyze commits since the latest stable tag. Recommend major for breaking changes, minor for features, otherwise patch, with commit evidence. Ask for category confirmation, calculate the exact next version, update `package.json` and lockfile on a release branch, run checks, then prepare a PR using `.github/PULL_REQUEST_TEMPLATE.md`. |
| C. Release PR exists and is unmerged | Report its number, branch, version, and checks. Stop; never bypass review or merge it. |
| D. Version commit is on `main`, exact-SHA CI succeeded, and no stable tag exists | Show exact version, SHA, and CI URL. Ask once, immediately, for approval to create and push the annotated stable tag. State losslessly that creating and pushing `vX.Y.Z` for that exact SHA will trigger automated npm publication and GitHub Release creation. Do not ask again after the tag push. |
| E. Tag, npm, or GitHub Release is partial | Verify tag target, manifest version, CI run, npm integrity, and release identity. Complete only identity-proven missing work; never republish or move anything. |
| F. Fully published | Report the exact tag, SHA, npm version/integrity, GitHub Release URL, and CI evidence. |

## Execution Steps

1. Re-enter by inspecting state; do not trust prior conversation state. Treat PR merge and publication as separate decisions, but make the tag approval the single immediate approval for tag creation plus automated publication.
2. For a confirmed category, calculate the next SemVer from the latest stable version; the user must not type the exact version.
3. Require a clean release scope, a reviewed version commit/PR prepared under `CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md`, completed push CI for the exact main SHA, and the workflow preflight before publication.
4. Use the repository workflow for the annotated tag, npm provenance publication, and generated GitHub notes; report actionable failures.

## Output Contract

Return `state`, `recommended_or_confirmed_bump`, `exact_version`, `tag`, `candidate_sha`, `PR`, `CI_evidence`, `npm_state`, `GitHub_release`, `approval_needed`, and `next_action`. Use `N/A` for unknown values and state why.

## References

- `docs/releasing.md`
- `CONTRIBUTING.md`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.github/PULL_REQUEST_TEMPLATE.md`
