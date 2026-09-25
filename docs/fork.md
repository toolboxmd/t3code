# Fork maintenance

This repo (`toolboxmd/t3code`) is a thin, rebasable layer on upstream
`pingdotgg/t3code`. Upstream `main` is the base; fork work is a small stack of
topic commits kept on top of it. This document describes the model, the
maintenance routine, and the upstream extension points that would shrink the
patch set further.

## Model

- **Base.** Upstream `main` (`https://github.com/pingdotgg/t3code.git`,
  remote name `upstream`). Fork `main` tracks it and adds only the stack below.
- **Stack.** Fork work lives as topic commits on top of the current upstream
  base. No merge commits: upstream updates are absorbed by rebasing the stack,
  never by merging `upstream/main` into the fork.
- **New files first.** Features go in new files and new packages. Edits to
  upstream-owned files stay minimal and every edited file is listed under
  "Upstream edits" below and in the machine-checked allowlist
  `scripts/fork-upstream-edits.txt` (one path per line).
- **Remotes.** `origin` is `toolboxmd/t3code`; `upstream` is
  `pingdotgg/t3code`. Never push to `upstream`, never send fork commits there
  (offering extension points upstream is a separate human decision, out of
  scope for routine maintenance).

## Fork-only content

New files owned by the fork (no upstream counterpart, always allowed):

- `VISION.md`, `MISSION.md`, `OBJECTIVE.md` — Project Direction, merged in #5.
- `docs/fork.md` — this document.
- `scripts/fork-rebase.sh` — the rebase routine.
- `scripts/fork-check.sh` — the stack-model check run by CI.
- `scripts/fork-maintenance.test.ts` — focused tests driving both scripts
  against throwaway git fixtures (run with upstream's own test suite).
- `scripts/fork-upstream-edits.txt` — canonical allowlist of upstream files
  the fork may modify (currently empty).
- `.github/workflows/fork.yml` — fork CI. Upstream's own `ci.yml` is
  untouched; the two workflows together give every PR upstream checks plus
  fork checks.

## Upstream edits

Upstream-owned files modified by the fork. Keep this list exact; CI enforces
that any modification to an upstream file not listed here fails.

- (none)

## Routine

`scripts/fork-rebase.sh` fetches `upstream`, rebases the current branch's
stack onto `upstream/main`, runs the fork check, optionally runs the full
proof, and optionally pushes. It reports conflicts per upstream file and never
force-pushes a published branch without proof passing in the same run.

```bash
# Report the stack and what an absorption would replay, without changing anything.
scripts/fork-rebase.sh --dry-run

# Absorb upstream updates (fetch + rebase + fork check).
scripts/fork-rebase.sh

# Absorb and run the full fork proof (required before pushing a rebased stack).
scripts/fork-rebase.sh --proof

# Absorb, prove, and publish (refuses unless --proof passed in the same run;
# uses --force-with-lease, never --force; refuses on main).
scripts/fork-rebase.sh --proof --push
```

On conflict the script stops at the failing commit, prints the conflicted
upstream files (`git diff --name-only --diff-filter=U`), and exits non-zero
with the rebase left in progress for manual resolution (`git status` to see
the files, resolve, `git rebase --continue`, then re-run the script). Record
the conflicted files and the resolution in the absorption log below and in the
PR.

Rules that the script enforces and humans must follow when working by hand:

- Never `git push --force`. A published rebased branch moves only via
  `git push --force-with-lease` after the same proof passed.
- Never rebase or push `main` directly; land upstream absorptions through a
  PR branch, then merge the PR.
- Bind proof to the final candidate: any rebase or conflict resolution
  invalidates earlier proof, so the proof must run last.

## CI

`.github/workflows/fork.yml` runs on every pull request and on pushes to
`main`, alongside upstream's own `ci.yml`. It adds the `upstream` remote,
fetches it, and runs `scripts/fork-check.sh`, which verifies:

- the stack on top of the upstream base contains no merge commits,
- the stack is small (at most 20 commits),
- every modification to an upstream-owned file is allowlisted in
  `scripts/fork-upstream-edits.txt` (new fork-only files are always fine),
- this document exists.

Upstream's `ci.yml` continues to run the project's own checks and tests
unchanged.

## Absorption log

One entry per absorbed upstream update: exact base and candidate commits,
elapsed time, conflicts by file (or "none"), and proof.

- **2026-09-25** (this issue, #6): absorbed upstream `main` `e3e7cc3fc`
  (`fix(usage): price Claude fast-mode requests at the fast rate (#13599)`)
  onto fork branch `chore/6-fork-maint`. Previous base `b2b43bef7`
  (`fix(server): preserve racy edits in review diff previews (#12613)`) plus
  fork commit `3cfadb7bc` (#5, Project Direction). 54 upstream commits
  replayed under the stack; **conflicts: none**. Routine:
  `git fetch upstream main` + `git rebase upstream/main` via
  `scripts/fork-rebase.sh`, wall time under 2 minutes for fetch plus rebase.
  Full proof (`pnpm install --frozen-lockfile && pnpm exec vp run -r
typecheck && pnpm exec vp lint && pnpm exec vp run -r test && pnpm exec vp
fmt --check`) run on the rebased candidate; results recorded in the PR.

## Candidate upstream extension points

Generic seams the fork's planned work (Model Router threads, OpenBot mode)
will need. Each is written so that, if upstream ever adopted it, the stated
fork patch would disappear. Offering any of them upstream is a human decision
and explicitly out of scope for this maintenance work; this list only records
what each would remove.

- **`parentThreadId` on `thread.create`.** `ThreadCreateCommand`
  (`packages/contracts/src/orchestration.ts`) and `ThreadCreatedPayload` carry
  no parent link, so Model Router job threads would need a fork patch that
  smuggles the parent linkage (via title prefix, metadata, or a parallel
  fork-owned map). A real optional `parentThreadId` field would remove that
  patch entirely.
- **Thread visibility independent of archive state.** Threads are listed or
  hidden by existing lifecycle flags; there is no "hidden from the sidebar
  but reachable from the Agents panel" concept, so Model Router job threads
  would need a fork patch in the sidebar query plus the Agents panel
  (`apps/web/src/components/AgentsPanel.tsx`). A first-class visibility flag
  would remove both edits.
- **Right-panel tab registry.** `RightPanelSurface`
  (`apps/web/src/rightPanelStore.ts`) is a closed union and
  `apps/web/src/components/RightPanelTabs.tsx` renders a fixed tab set, so an
  OpenBot Computer tab would require editing both upstream files. A registry
  (fork registers a tab kind without touching the union or renderer) would
  remove those edits.
- **Thread persona/owner marker.** `ThreadCreatedPayload` carries no agent
  identity, so a Bot-as-thread-with-persona would need a fork patch to attach
  and render it. An optional upstream persona field would remove that patch.
