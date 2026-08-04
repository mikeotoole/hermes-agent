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

- Upstream version line: Hermes Agent v0.19.1, official tag `v2026.7.30`.
- Dereferenced upstream commit: `cc4cab2f592e60a197e796506de9168f74baf3ea`.
- Linear release-import commit: `0d85d261fd5185e88c22b758180a0d18344ed8ef` (tree-identical to the official tag, parented by the prior protected downstream release).
- Accepted downstream runtime head: `a90d2013ef487c3d66de38729631ada07e4bb5d3`.
- Reviewed source candidate: `216ddf8a6f534434d0bd040a00c431f1ff20a65d`, tree `0914c491416258ab479c68387293bdc85f5e22fb`.
- Candidate branch: `release/lagoon-2026.08.02.1-promote`.
- Candidate tag: `lagoon/2026.08.02.1`.
- Accepted behavior: ordered interim commentary during tool calls, reconnect survival in Desktop and TUI, AgentCTRL compatibility, and deterministic macOS release verification without weakening Linux behavior.
- Ordered carried commits:
  1. `f1fae872961a73c041fee6bb0822b7a48e23e0f1` — backend interim segments and reconnect snapshot contracts;
  2. `ceb42ae72bc5ca4bbf21ae7a333f46cd2aa6a998` — per-turn callback snapshotting;
  3. `1a814b7af36754f399e78ca84cbea352acb1de71` — Desktop reconnect restoration;
  4. `81921a6615cbdb56c8799ff55ad24018c3c73d54` — TUI reconnect restoration;
  5. `61a6ea802844fd272e627972dd5c7fbbd744dd6e` — UTF-16 boundary ordering across reconnect;
  6. `cfb88c1fac4667b939b0e40b6ec1025e01993acb` — upstream EOL-only churn detection fix;
  7. `949b4403593da134d370b3119c360668b3164a0b` — upstream racy-Git determinism coverage;
  8. `b400b932daa695c3d22099ae632e606f52e76d2a` — macOS runtime portability and hermetic release gates.
- Release stabilization commits:
  1. `adc528881b80b59349ffbcc6904b01db5779e400` — timing-sensitive release gates;
  2. `fbd77b756b6ea2a99f46101eb70365918fe5de75` — deterministic parallel MCP shutdown coverage;
  3. `54719a2e01dd5caa6bb3c231264fdc83c41bf4e9` — synchronized stale-watchdog coverage;
  4. `590ced8b500f1ce6f5fe9e19a303e7273fffae23` — synchronized compression-fence coverage;
  5. `54f47197783b97c86fa707af4cc2e8c1e31f4995` — loaded-suite runtime and harness stabilization;
  6. `a90d2013ef487c3d66de38729631ada07e4bb5d3` — deterministic off-loop cleanup coverage.
- Runtime equivalence: before packaging, every non-governance path is byte-identical to the reviewed source candidate.
- Packaging may change only `.github/workflows/downstream-ci.yml`, `DOWNSTREAM.md`, and `contributors/emails/mike@otoole.io`. Every other path must remain byte-identical to the accepted runtime head.

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
