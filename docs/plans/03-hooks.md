# Plan 03 — Pre-commit hooks at publish

The pre-commit half of slice 4 in `docs/research-2026-09-30.md` §3.10, per §3.7: "pre-commit hooks run lazily, at publish". Undo, the mergetool break-out, formatting, and the list-then-fetch document API are plan 04; this plan builds the persistent worktree they will reuse.

## Goal

Apply runs the repository's `pre-commit` hook once per rewritten commit, in stack order, before anything is published. A hook that rewrites files (a formatter) has its changes folded into that commit, and the commits above build on the reformatted version without conflicting over the formatting. A hook that fails stops the apply with nothing published, and the UI shows the hook's output next to the commit it failed on, with the ways forward: edit that commit, apply again, or apply without running hooks. A hook that hangs can be cancelled.

## Where hooks run

- A persistent detached worktree at `<gitDir>/suonetar/wt`, created with `git worktree add -f --detach --no-checkout` on first use (`-f` covers a registration whose directory was deleted). Inside the git directory it is invisible to the main worktree's `git status`; it does show in `git worktree list`, as a detached worktree, which is the honest description. `--no-checkout` skips `post-checkout`.
- Hooks may be tracked in the repository (`core.hooksPath=.githooks`): git resolves a relative hooks path against the worktree the hook runs in, so each commit's own hook version runs, as it would have at `git commit` time.
- Materialising commit *i* is plumbing only, so no other hook fires: `update-ref --no-deref HEAD <parent commit>` in the worktree, then `read-tree --reset -u <input tree>` (verified: it switches index and files, overwriting stray untracked files in this private worktree). The index then holds the commit's content and HEAD its parent, so `git diff --cached` shows exactly the commit's change, which is what hook frameworks (pre-commit, lint-staged) read to decide which files to check. The worktree matches the index, so there are no unstaged changes to stash.
- `GIT_LFS_SKIP_SMUDGE=1` for these commands, so materialising never downloads LFS objects.
- The hook runs as `git hook run --ignore-missing pre-commit` with the worktree as cwd; git sends the hook's stdout to stderr, so stderr is the whole transcript. `commit-msg`, `prepare-commit-msg`, and `post-commit` are not run (§3.7).
- Nothing is run and no worktree is created when the repository has no `pre-commit` hook: `rev-parse --path-format=absolute --git-path hooks/pre-commit` (which honours `core.hooksPath`) in the main worktree names no executable file. A hooks path relative to a tree that has no hook in the main worktree but has one in some commit is the one case this misses, accepted.

## The hook pass

New module `src/engine/hooks.ts`: `hooksRun(repo, worktree, baseOid, steps, cache, progress, signal)`. `steps` is the clean replay (`ReplayStep[]`, trees T₁…Tₙ, unformatted); it returns the steps with hooked trees H₁…Hₙ, or the failure.

For each step in order, skipping those with `rewrite: false` (their tree is published unchanged and Hᵢ = Tᵢ):

1. **Input tree.** Hᵢ₋₁ is the hooked parent. If Hᵢ₋₁ = Tᵢ₋₁ (no earlier hook changed anything) the input is Tᵢ. Otherwise the input is Hᵢ₋₁ with the paths the commit itself changes (`diff-tree -r Tᵢ₋₁ Tᵢ`) set to their Tᵢ entries. Path-level, not a three-way merge: a merge would conflict wherever the commit edits lines an earlier formatting pass touched, which is the common case. Files the commit changes carry their unformatted earlier history, and the hook reformats them again; files it does not change keep the earlier hook's result.
2. **Parent commit.** HEAD must be a commit whose tree is Hᵢ₋₁. For the first rewritten step it is the real parent (the base or an unchanged stack commit); after that, an unsigned stand-in commit object with Hᵢ₋₁'s tree, the previous commit's author and message, and the previous stand-in as parent, so `git log` inside the hook looks like the stack being built. Stand-ins are never referenced once the worktree moves on.
3. **Run** the hook. Afterwards `git add -u` in the worktree (files the hook modified or deleted; new untracked files it created are not picked up, as with `git commit`) and `write-tree` gives the result R. Files the hook itself staged are included.
4. **Settle.** Exit 0 and R = input: passed, Hᵢ = R. R ≠ input: the hook changed files (pre-commit exits 1 in that case, lint-staged 0); run it again on R, as a user would re-run `git commit` after a formatter; accept when a run exits 0 and changes nothing further; three runs without settling is a failure ("the hook keeps changing files"). Exit ≠ 0 with no change: failure.
5. **Cache.** Successful results are cached in the session by `(Hᵢ₋₁, input tree)` → R, so applying again after a later failure, a cancel, or a CAS miss does not re-run hooks on commits that already passed. Memory only; a changed untracked hook is not detected within one session, accepted.

After the pass, `empty` is recomputed against the hooked parent. The result lists, per commit, the paths the hook changed, which the UI reports after publishing ("pre-commit changed 3 files in 2 commits").

**Failure** returns `{ kind: "hook-failed", commit: { oid, subject }, code, output, changed }`: the stack commit (so the UI can select it), the exit code, the transcript (last 64 KiB), and the paths the hook had changed before failing. Nothing is written except objects; drafts and resolutions are untouched.

## Cancellation

- `GitCallOptions` gains `signal?: AbortSignal`. When given, the spawn runner starts the child in its own process group and on abort kills the group (SIGTERM, then SIGKILL after 2 s), so a hook's own children (pre-commit → python → clang-format) die too. Only the hook run uses it.
- `Session.applyCancel()` aborts the apply in progress; it bypasses the mutex (the apply holds it). Cancel is effective during the hook pass only; publishing is short and is never interrupted. The result is `{ kind: "cancelled" }`, nothing published.
- Closing the window during an apply cancels it before `closeWhenIdle`.

## Session and API changes

- `Session.apply(hooks: "run" | "skip", progress: (p: ApplyProgress) => void)`. `ApplyProgress = { step: "hook"; index; total; subject } | { step: "write" } | { step: "publish" }`. `ApplyResult` gains `hook-failed` and `cancelled`; `published` gains `hookChanges: { subject; paths }[]`.
- A generic main→renderer channel `suonetar:event` carrying `SuonetarEvent = { kind: "apply-progress"; progress: ApplyProgress }`; the preload exposes `suonetarShell.onEvent(handler)`. The `apply` IPC handler sends progress to the calling page only. `applyCancel` is a new API method.

## UI

- While applying, the status line shows the progress ("Running pre-commit on 2 of 5: <subject>") and a Cancel button replaces Apply.
- `hook-failed` opens a new view (`hook-view.ts`, kind `hook` in `ViewShown`), kept like the resolve view until the user leaves it: the commit's subject, the exit code, the transcript in a monospace block (ANSI escapes stripped), the files the hook had changed, and three actions: **Edit this commit** (selects it in the commit view; the fix is an ordinary draft), **Apply again**, and **Apply without hooks** (confirmation first, naming what is skipped).
- After a successful apply with hook changes, the status line says which commits the hook changed.

## Tests

Engine (real git, hooks written as shell scripts by the test):

- No hook: apply publishes as before and no worktree is created.
- Passing hook: runs once per rewritten commit and not for unchanged ones; inside it, `git diff --cached --name-only` lists exactly the commit's changes, `git rev-parse --show-toplevel` is the private worktree, and the main worktree's status is untouched.
- Formatting hook (strips trailing whitespace from staged files, exits 1 when it changed something): each rewritten commit is published formatted; a later commit editing the same file publishes without a conflict and its diff holds only its own change; `hookChanges` names the files.
- Failing hook: `hook-failed` with the code and output; branch, worktree, drafts unchanged.
- A hook that changes something on every run fails with "keeps changing files".
- Cancel: a hook that sleeps; `applyCancel` returns `cancelled` promptly and the sleeping process is gone.
- Cache: after a failure on commit 3 is fixed, the next apply does not re-run commits 1 and 2.
- `hooks: "skip"` publishes without running the hook.
- A relative `core.hooksPath` pointing at a tracked directory runs each commit's own hook.
- The worktree is recreated when its directory was deleted.

IPC: `apply` passes the hooks choice and routes progress to the sender; `applyCancel` reaches the session. The hook view is UI and is covered by a manual smoke under Xvfb with a real formatting hook and a failing one.

## Revisions after hostile review

A hostile review (Opus, with reproductions against git 2.55 and the pre-commit framework) found four blocking problems. All are accepted, and where they conflict with the sections above, this section wins.

- **B1, config-based hooks.** git 2.55 runs `hook.<name>.event=pre-commit` hooks, and there is no file for the plan's check to find. Detection is `git hook list pre-commit` (exit 1 means none), which covers hook files, `core.hooksPath`, and config hooks.
- **B2, untracked hooks directories.** husky v9 sets `core.hooksPath=.husky/_`, and `_/` is ignored, so it is absent from the private worktree. `--ignore-missing` would turn that into a silent pass.
  - When `core.hooksPath` is relative and that directory is not in the commit's input tree, the hook runs with `-c core.hooksPath=<absolute path in the main worktree>`.
  - `--ignore-missing` is dropped.
  - A commit whose own tree has a tracked hooks directory but no pre-commit hook is skipped and listed in the result. It is never passed silently.
- **B3, the hook environment.** The private worktree has no untracked files: no `node_modules`, no `.venv`, no generated directories.
  - The design assumes hooks work in a clean checkout, as hook frameworks that manage their own environments (pre-commit) do. A hook that needs untracked files fails loudly, and the user skips it for that commit or for the apply.
  - Node's module resolution walking up into the main worktree's `node_modules` is a known inconsistency of the location, recorded here. The location stays `.git/suonetar/wt`, as §3.6 chose; a directory outside the repository would avoid walk-up and full-tree traversals by `find`, at the cost of cache directories keyed by repository path.
  - The author's actual hook stack has not been smoke-tested and is asked about in the report.
- **B4, no exclusion across processes.** Two Suonetar processes would share the worktree. The pass holds `<commonDir>/suonetar/wt.lock` (created `O_EXCL`, containing the pid, with stale detection by pid liveness), and another live holder yields `busy`.

Should-fix items adopted:

- **S1, stand-ins in `git log --all`.**
  - The worktree's HEAD reflog is deleted at creation, and HEAD moves with `core.logAllRefUpdates=false`.
  - After every pass (success, failure, or cancel) HEAD is parked at the stack base.
  - Stand-in commits carry a fixed message ("suonetar: hook parent") and the stack commit's author. They end up unreferenced and are collected by gc.
- **S2, the hook's environment.** Hooks run through a separate spawner injected on `Repo` (`runHook`), not through `GitRunner`.
  - Its environment is the user's, minus the git variables that redirect repositories, minus `npm_*`, `INIT_CWD`, and the `node_modules/.bin` and `node-gyp-bin` PATH entries that `npm run` prepends.
  - It sets no forced locale.
  - It adds `GIT_EDITOR=:` and an absolute `GIT_INDEX_FILE` for the worktree's index, as `git commit` does.
- **S3, background children holding the pipes.** The spawner resolves on process exit, gives the pipes 200 ms to drain, and then kills the rest of the process group. This happens every time, not only on cancel.
- **S4, worktree recovery.** `worktree-private.ts` owns the worktree as a class with a lifecycle:
  - It acquires the lock.
  - It checks health: `rev-parse --absolute-git-dir` from inside must name an admin directory under `<commonDir>/worktrees/` whose `gitdir` points back. Otherwise it removes the directory (it is ours), prunes, and re-adds with `-f -f`.
  - It removes a stale worktree `index.lock` while holding our lock.
  - It materialises, parks, and releases.
  - The worktree is created locked (`git worktree lock --reason "suonetar private worktree"`), so `git worktree list` explains it and `git worktree remove` refuses it.
  - The admin directory's name is never assumed.
- **S5, pre-flight.** The pre-flight checks that need no new tip (HEAD on the branch, nothing in progress, not checked out elsewhere) run before the hook pass as well as in `publish`.
- **S6, the settle rule.** `git commit` never includes changes the hook left unstaged, so the rule is:
  - Exit 0: take the index as the hook left it, plus `add -u` limited to the paths the commit changes. Do not re-run.
  - Exit ≠ 0 with changes to those paths: stage them (same scope) and re-run, at most three runs in all.
  - Exit ≠ 0 with no changes: failure.
  - Changes outside the commit's paths (a whole-repository formatter) are not folded in, as with `git commit`.
- **S7, an escape short of skipping everything.**
  - A commit whose hook input equals the state it was originally committed from (same parent tree and tree, as after a message-only edit below it) is not re-run.
  - The hook view offers "Apply, skipping the hook for this commit". `apply` takes `{ kind: "run"; skip: Oid[] } | { kind: "skip" }`.
- **S8.** The tests gain:
  - config and untracked-`hooksPath` detection;
  - a lint-staged-style hook that exits 0 after staging;
  - earlier formatting kept when a later commit does not touch the file, and when it deletes the file;
  - no new entries in `git log --all` after a pass;
  - cancel then apply again;
  - a CAS miss after the pass, then a cache hit;
  - `busy` for a second lock holder;
  - a whole-repository formatter leaving unrelated files out.

Minor items:

- **M1.** `read-tree`, `add`, `update-ref`, and `worktree add` fire `post-index-change` and `reference-transaction`. Materialisation commands run with `-c core.hooksPath=/dev/null`.
- **M2.** Building the input tree can silently drop hook-created files at a directory/file collision. Building it now fails when the result drops a path outside the commit's own change.
- **M3.** The staged diff is the commit's paths, not exactly its change, when an earlier hook reformatted a file the commit also touches. The test checks names only.
- **M4.** `rewrite` is recomputed after the pass, so a formatter that reverts a whitespace-only edit can make the apply `nothing`.
- **M5, taken in part.** The report is what each hook run changed while checking that commit, worded that way. It is not a claim about the published diff.
- **M7, M8, and M12 are documented in `recovery.md`:**
  - lint-staged backups in `refs/stash`;
  - hooks see a detached HEAD;
  - Docker hooks outlive a cancel;
  - LFS files are pointers;
  - a partial clone's first checkout fetches blobs.
  - A "preparing the worktree" progress step is shown.
- **M9.** Cancel bypasses both `busySet` and the op queue. Closing the window during an apply is still refused by the renderer (press Cancel first). The main process's force-close path cancels before `closeWhenIdle`. The UI is modal for the whole pass.
- **M10.** The progress channel is dedicated, `suonetar:apply-progress`, with `suonetarShell.onApplyProgress`, rather than a one-member event union.
- **M11.** The cache key includes the resolved hook identity: the `git hook list` output, the hooks path, and a hash of the hook file when one exists.

The architecture follows the review:

- `worktree-private.ts` is the class owning the private worktree.
- `hooks.ts` is the pass: input-tree construction, settle, cache, and a discriminated result.
- `Repo.runHook` is the process-group spawner.
- `Session.apply` orchestrates: pre-flight, replay, hooks, commit, publish.

## Revisions after code review

A hostile code review (Opus, reproducing each finding against the engine) found three blocking problems. All are fixed, with tests.

- **A cancel pressed before the hook pass started was ignored, and the apply published.** The abort controller now exists from the moment `apply` is called. The apply checks it before the pass and before writing commits. The UI hides Cancel once writing starts.
- **Creating the private worktree ran `git worktree prune`.** That removes every registration whose directory is missing, including the user's worktrees on an unmounted drive. The prune is gone: `worktree add -f -f` already reclaims our own registration.
- **A failure of the hook machinery itself was a dead end.** Examples are a `core.hooksPath` outside the repository, which made `ls-tree` fatal, and a commit of 30,000 files, which overflowed the argument list. Such failures surfaced as a plain error, with no way to apply without hooks.
  - These failures now return `hook-error`, which opens the hook view with "Apply again" and "Apply without hooks".
  - Hooks paths outside the repository are pinned to their absolute path.
  - `add -u` takes its pathspecs on stdin.

Should-fix items adopted:

- **A skipped or hookless commit kept earlier formatting.** Its tree is now a three-way merge of its own change onto the hooked parent. Before, it was the path-level overlay, which reverted earlier formatting at the tip. The overlay remains the fallback when the merge conflicts.
- **An edit the formatter undoes completely** returns `hook-reverted` and clears the drafts, instead of leaving a draft that every apply reports as nothing to do.
- **npx.** Hooks run with `npm_config_yes=false`, so npx fails instead of silently downloading unpinned tools.
- **The worktree lock.**
  - The lock file is written and then linked into place, so it is never seen empty.
  - A stale lock is moved aside and checked before it is replaced.
  - Release removes the file only while it is still ours (same inode).
- **Skipped commits** are listed in the hook view. Skips are dropped when the hook view is left or Apply is pressed afresh. Any apply outcome other than a hook stop leaves a stale hook view.
- **Cancel's grace period.** A cancelled hook gets its full two seconds after SIGTERM before SIGKILL. Before, it got 200 ms.
- **Tests added:**
  - early cancel;
  - a hooks path outside the repository;
  - a foreign worktree registration surviving;
  - formatting kept across a skipped commit;
  - a formatter undoing the only edit;
  - a 30,000-file commit;
  - a collision;
  - a hookless commit;
  - the cache reused after a CAS miss;
  - worktree repair;
  - `hook-error`.

Minor items:

- **Plumbing in the private worktree** also disables config-based hooks by name (`hook.<name>.enabled=false`) and runs with `core.fsmonitor=false`.
- **Parking HEAD** happens in a `finally`.
- **Shared flag computation.** `replayTrees` and the pass share `stepsReflag`.
- **Types.** `ApplyProgress` and `HookChoice` live in `session.ts`, beside `ApplyResult`. The hook stage is `Session.#hooksRun`.
- **`core.hooksPath` is read once per pass.** Before, it was read once per commit.
- **Cached trees are checked to exist before reuse.** `git gc --prune=now` can remove them.
- **The runner:**
  - It does not spawn when already cancelled.
  - It reports a failure to signal the process group in the transcript, instead of throwing from a timer.
  - It keeps a bounded tail of the output, cut at a character boundary.
- **The status line** gives counts; the per-commit file list is its tooltip.
- **`recovery.md` notes:**
  - partial clones;
  - PATH under a desktop launcher;
  - husky's dispatch to the main worktree's hook;
  - npx;
  - hooks orphaned by a killed Suonetar.
