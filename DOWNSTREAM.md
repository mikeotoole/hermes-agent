# Mike's Hermes downstream

This fork is a thin integration and release vehicle for temporary Hermes core changes that are still moving upstream. It is not an independent Hermes distribution.

## Branches

- `main` may be maintained as an exact fast-forward-only mirror of `NousResearch/hermes-agent:main`. It receives no local commits, but mirror freshness is not a downstream release gate.
- `downstream/main` is the protected integration branch. Local releases are cut only from reviewed commits on this branch.
- `fix/*` and `feat/*` branches contain one upstreamable change each and start from a pinned official release tag or an explicitly recorded accepted base.
- `release/lagoon-*` branches package an already reviewed downstream head with governance-only release metadata before promotion.

## Remotes and local safety

The canonical development clone uses:

- `upstream`: `https://github.com/NousResearch/hermes-agent.git`
- `origin`: `https://github.com/mikeotoole/hermes-agent.git`

Local Git is configured with `pull.ff=only`, fetch pruning, and `origin` as the push default. The installed Hermes runtime is not a development clone and must not own development worktrees.

## Upstream release baseline

Downstream releases pin to an official NousResearch release tag. Moving upstream `main` does not invalidate an already reviewed and accepted downstream artifact.

1. Record the selected upstream release tag and its dereferenced commit.
2. Preserve the accepted downstream code head unchanged through packaging.
3. Migrate the carried patch stack only when Mike intentionally selects a newer official release tag.
4. Treat that migration as a new compatibility, test, freeze, and independent-review tranche.

Fork `main` may be synced separately by exact fast-forward only. Never merge or rebase local changes onto fork `main`, and never chase unreleased `main` as a prerequisite for a downstream release.

## Current release candidate

- Upstream version line: Hermes Agent v0.20.0, official tag `v2026.8.3`.
- Verified annotated tag object: `7de39e700d2c329e15d32eb0b96e2f7cdd9fbdb2`.
- Dereferenced upstream commit: `3c27eb6234bf91b8ceee9e9071591b31e9b148cb`.
- Upstream tree: `b217767ccb994605dad522e693fa1b4cdbc2f352`.
- Linear release-import commit: `890b61bb3d478259b1e6f16e7bae6c9db2148220` (tree-identical to the official tag, parented by the prior protected downstream release).
- Packaged downstream runtime head: `95adb45a50215f08c5d8f9afe5ef5fa2910ce772`, tree `a1bacee7b028b6afa99c28ea18146860f19c240a`.
- Candidate branch: `release/lagoon-2026.08.05.1-v020`.
- Candidate tag: `lagoon/2026.08.05.1`.
- Candidate behavior: ordered interim commentary during tool calls, cumulative-boundary preservation, reconnect survival in Desktop and TUI, and AgentCTRL compatibility on Hermes v0.20.0.
- Runtime patch: one commentary/reconnect commit ported from downstream commit `54170df967a3fceee0590a537c2e7d688de57b11`. Its source provenance is:
  1. `f1fae872961a73c041fee6bb0822b7a48e23e0f1` — backend interim segments and reconnect snapshot contracts;
  2. `ceb42ae72bc5ca4bbf21ae7a333f46cd2aa6a998` — per-turn callback snapshotting;
  3. `1a814b7af36754f399e78ca84cbea352acb1de71` — Desktop reconnect restoration;
  4. `81921a6615cbdb56c8799ff55ad24018c3c73d54` — TUI reconnect restoration;
  5. `61a6ea802844fd272e627972dd5c7fbbd744dd6e` — UTF-16 boundary ordering across reconnect.
- Explicit exclusions: prior downstream updater-EOL changes, broad macOS/runtime portability changes, unrelated timing/concurrency/test-harness stabilization, and compaction-queue changes are not carried.
- Runtime equivalence: every non-governance path in the packaging commit is byte-identical to the packaged runtime head.
- Packaging changes only `.github/workflows/downstream-ci.yml`, `DOWNSTREAM.md`, and `contributors/emails/mike@otoole.io`.
- Exact packaging-head review and current-head CI remain mandatory under the promotion gate below; their identities belong in the immutable release record rather than a self-referential commit field.

## Patch lifecycle

Every carried core patch needs an external patch-ledger entry recording:

- selected official upstream release tag plus the exact accepted base SHA;
- local branch and commit;
- why the core change cannot live in a plugin/skill/MCP server;
- upstream issue and pull request;
- dependencies and compatibility contract;
- focused, neighboring, full, integration, and review evidence;
- removal condition.

When a newer official upstream release lands equivalent behavior, prove the downstream commit can be removed, remove it on that tagged-release migration candidate, and rerun all affected gates.

## Promotion gate

A change may enter `downstream/main` only through a pull request after:

1. RED evidence on its pinned base;
2. GREEN focused and neighboring tests;
3. static checks and the relevant full suite;
4. exact diff hygiene and secret scan;
5. immutable artifact freeze;
6. independent read-only review bound to the frozen identity;
7. passing Downstream CI.

Conflicted upstream updates and failed checks never auto-merge or auto-deploy.

## Releases and rollback

- Tag reviewed releases as `lagoon/YYYY.MM.DD.N`.
- Record the selected upstream release tag, exact accepted base SHA, and ordered downstream commits in the release notes.
- Build immutable artifacts/images from the tag and deploy by digest or artifact hash.
- Roll back by selecting the previous verified tag/digest; never reconstruct a production build from an untagged branch.

Fork integration, release creation, runtime installation, service restart, AgentCTRL release, and deployment are separate gates.
