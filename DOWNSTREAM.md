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

- Upstream version line: Hermes Agent v0.19.0, official tag `v2026.7.20`.
- Accepted downstream code head: `e2f27bcdbf491bb367b4f8a0fd2863efa6bb4a7e`.
- Accepted behavior: ordered OpenAI commentary during tool calls, reconnect survival, and AgentCTRL compatibility.
- Packaging may add only reviewed governance/release metadata. Runtime-source bytes must remain identical to the accepted code head.

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
