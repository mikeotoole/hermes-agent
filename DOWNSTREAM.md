# Lagoon downstream release

This branch is a clean-slate downstream candidate built from an exact upstream
Hermes release. It does not merge either historical fork PR and does not stack
new work on the older v0.20.0 downstream source tree.

## Candidate identity

- Planned downstream release: `lagoon/2026.08.30.1`
- Product version: Hermes `0.20.6`
- Upstream tag: `v2026.8.27`
- Upstream tag object: `fcebd62163497e77e5de00d26d2ed86cb4ef8761`
- Upstream commit: `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`
- Upstream tree: `222ec43b5237deb643277bc2f64fa4b873dd7f28`
- Upstream tag signature: not present; provenance is forge/tag/commit binding
- Candidate release commit: pending approval
- Accepted combined source tree: `7d96918c92a39a8d7acde38deb97f363ba2669bf`
- Final packaging tree: recorded after freeze in the external immutable release
  manifest; it is not embedded here because this tracked file contributes to
  that tree

## Downstream changes

### 1. Commentary and reconnect continuity

The commentary successor preserves partially streamed assistant output and its
interim/correction boundaries across reconnects, profiles, and Desktop/TUI
surfaces. Stable turn identity is generated once by the serving process and
propagated through the compute-host frame so isolated and inline execution obey
this invariant:

```text
message.start.turn_id == session.activate.inflight.turn_id
```

Frozen source artifact:

- Name: `pr8-successor-v11.patch`
- SHA-256: `b43f446821b399f635d64ac13bc9fd50beed2b268adbebae7218636036a444a8`
- Resulting tree: `b42f428a524a46d6eb8cdbc2331a8a954149d04a`
- Scope: 39 paths

This succeeds the previously accepted v10 artifact. The additional v11 change
is limited to compute-host turn-ID propagation and behavioral tests discovered
by the full local verification pass.

### 2. Temporary Gitea webhook compatibility

The existing Gitea event-header compatibility patch is carried unchanged while
upstream issue `#89427` remains the intended long-term replacement.

Frozen source artifact:

- Name: `gitea-webhook-v7.patch`
- SHA-256: `c5a8786ea6e760552915b0b16299cfa3a597ac9cfae39c0f22e79ee2bcecb021`
- Scope: 2 paths

Known temporary risk, explicitly accepted for this downstream candidate:
unsigned duplicate or conflicting `X-Gitea-Event-Type` / `X-GitHub-Event`
headers may be ambiguous. This exception applies only to that known Gitea
header behavior. It does not waive any other security, correctness, scope, or
composition finding.

### Combined source identity

- Name: `combined-two-change-v12.patch`
- SHA-256: `7c5df944ba6b4588f2aea211d3617bcf3d77cfc026fd6614c559bdcaab9be6bf`
- Resulting tree: `7d96918c92a39a8d7acde38deb97f363ba2669bf`
- Scope: 41 paths

The combined artifact was regenerated from temporary Git indexes rooted at the
exact upstream commit. It cleanly composes commentary v11 with byte-identical
Gitea v7 and reproduces the source candidate working tree.

### 3. Downstream governance

The release adds only these governance files after the combined source tree:

- `.github/workflows/downstream-ci.yml`
- `DOWNSTREAM.md`
- `contributors/emails/mike@otoole.io`

The workflow retains pinned GitHub Action SHAs and the repository's locked
Python and npm dependency contracts.

## Verification evidence

Candidate-owned environments were created inside the isolated worktree from
`uv.lock` and `package-lock.json`. Production Hermes interpreters and the live
checkout were not used for source tests.

Passing focused gates:

- Python: 667 tests across Gitea webhook, TUI gateway, retained-turn, and
  commentary/interim boundaries.
- Desktop changed-path tests: 350 tests.
- Shared JSON-RPC replay: 10 tests.
- Ink TUI lifecycle: 12 tests.
- Applicable TUI gateway sibling tests: 620 tests.

The root JavaScript workspace checks completed typechecking, linting, builds,
and all changed-path tests. Under the monolithic macOS UI run, unrelated
property/DOM tests exceeded their wall-clock budgets; every reported failed
file passed when rerun under low load. The large Python macOS run also exposed
unrelated platform/timing baselines, including Linux-only abstract systemd
socket behavior. One unrelated v0.20.6 model-options test remains locally red
outside every changed path. Downstream Linux CI is therefore still a required
publication gate; these local baselines are not represented as a green full
suite.

The optional Matrix extra cannot build locally because upstream `libolm` is
incompatible with AppleClang 21. The authoritative v0.20.6 CI dependency slice
excludes that optional extra. Live Matrix acceptance remains a separate
post-install gate.

## Review and release gates

The combined v12 artifact requires independent exact-hash acceptance before
any commit, publication, tag, install, or restart.

After source acceptance, release execution still requires separate approval
for:

1. creating the logical downstream commits;
2. pushing a candidate branch and opening the release PR;
3. merging and creating the downstream tag;
4. backing up and updating the installed Hermes checkout;
5. restarting the launchd-owned Hermes service;
6. running post-update application, plugin, profile, Matrix, and rollback
   acceptance.

No source-review decision by itself authorizes deployment.

## Installed-state safeguards

The current installed runtime remains Hermes `0.20.0` until the release and
installation gates are approved. Before installation:

- create and verify an online SQLite backup of the live default-profile
  `state.db`, including WAL-consistent content;
- preserve profile/plugin/config inventories outside `HERMES_HOME`;
- prove a rollback target for both source and persisted state;
- resolve the launchd `maxfiles` acceptance boundary;
- keep the launchd-owned process as the sole restart owner.
