# Mike's Hermes downstream

This fork is a thin integration and release vehicle for temporary Hermes core changes that are still moving upstream. It is not an independent Hermes distribution.

## Branches

- `main` is an exact fast-forward-only mirror of `NousResearch/hermes-agent:main`. It receives no local commits.
- `downstream/main` is the protected integration branch. Local releases are cut only from reviewed commits on this branch.
- `fix/*` and `feat/*` branches contain one upstreamable change each and start from a pinned `upstream/main` commit.
- `sync/upstream-<short-sha>` branches are disposable update candidates used to replay the carried patch stack against a new upstream base.

## Remotes and local safety

The canonical development clone uses:

- `upstream`: `https://github.com/NousResearch/hermes-agent.git`
- `origin`: `https://github.com/mikeotoole/hermes-agent.git`

Local Git is configured with `pull.ff=only`, fetch pruning, and `origin` as the push default. The installed Hermes runtime is not a development clone and must not own development worktrees.

## Upstream sync

Run the local `git sync-upstream` alias from the canonical development clone. It must:

1. fetch and prune `upstream`;
2. fast-forward local `main` to `upstream/main`;
3. push that exact fast-forward to `origin/main`;
4. stop on divergence or any non-fast-forward condition.

Never merge or rebase local changes onto fork `main`.

## Patch lifecycle

Every carried core patch needs an external patch-ledger entry recording:

- upstream base SHA;
- local branch and commit;
- why the core change cannot live in a plugin/skill/MCP server;
- upstream issue and pull request;
- dependencies and compatibility contract;
- focused, neighboring, full, integration, and review evidence;
- removal condition.

When upstream lands equivalent behavior, prove the downstream commit can be removed, remove it on the next sync candidate, and rerun all affected gates.

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
- Record the upstream base SHA and ordered downstream commits in the release notes.
- Build immutable artifacts/images from the tag and deploy by digest or artifact hash.
- Roll back by selecting the previous verified tag/digest; never reconstruct a production build from an untagged branch.

Fork integration, release creation, runtime installation, service restart, AgentCTRL release, and deployment are separate gates.
