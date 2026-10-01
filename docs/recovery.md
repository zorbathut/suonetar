# Recovering from an interrupted apply

Suonetar publishes a rewritten stack under git's own index lock. Throughout, it keeps a record at `.git/suonetar/intent.json`, updated at every step:

```json
{ "branch": "refs/heads/feature", "oldTip": "<sha>", "newTip": "<sha>", "pid": 12345, "time": "...", "phase": "worktree-updated" }
```

When Suonetar finds that file:

- if the process named by `pid` is still running, an apply is in progress and Suonetar waits;
- if `phase` is `locking` and `.git/index.lock` does not exist, the apply never got the lock, nothing changed, and Suonetar deletes the record by itself;
- otherwise the apply stopped partway, and Suonetar refuses to do anything until it is sorted out, showing the record. Nothing has been lost. Your drafts are only cleared after a successful apply, and they live in `refs/suonetar/drafts`.

What to do depends on `phase`. Make sure the process named by `pid` is not running first (`ps -p <pid>`; on Windows `tasklist /FI "PID eq <pid>"`, remembering that Windows soon reuses the pid of a process that has exited).

## `locking` or `locked`

Nothing in the worktree, index, or branch changed. If `.git/index.lock` exists and is empty, it is Suonetar's; remove it along with the record:

```sh
rm .git/index.lock .git/suonetar/intent.json
rm -f .git/suonetar/index.private
```

## `worktree-updated`

The branch is still at `oldTip`, but some worktree files may hold `newTip`'s versions. Put them back with the private index, which tracks exactly what Suonetar changed:

```sh
GIT_INDEX_FILE=.git/suonetar/index.private git read-tree -m -u <newTip> <oldTip>
rm .git/index.lock .git/suonetar/intent.json .git/suonetar/index.private
git status
```

If `read-tree` refuses because another process changed a file meanwhile, it names the file. Compare that file with both tips (`git diff <oldTip> -- <file>` and `git diff <newTip> -- <file>`) and keep what you want before removing the lock.

## `ref-moved`

The branch moved to `newTip` and the worktree matches it; only installing the new index was left. `.git/suonetar/index.private` holds the matching index.

```sh
git rev-parse <branch>        # should print newTip
cp .git/suonetar/index.private .git/index
rm -f .git/index.lock
rm .git/suonetar/intent.json .git/suonetar/index.private
git status
```

If the branch is somewhere else entirely, another process moved it. Suonetar's replaced commits are still in the branch's reflog (`git reflog <branch>`). Restore the worktree as for `worktree-updated`, then reopen Suonetar: its drafts will be matched onto the new stack.

## What survives what

- Drafts and conflict resolutions live under `refs/suonetar/drafts`, survive `git gc --prune=now`, and the ref has its own reflog, so discarded drafts stay recoverable (`.git/logs/refs/suonetar/drafts` lists every state; `git reflog` does not display them because they are trees, not commits).
- Every commit Suonetar replaces stays in the branch reflog until `git gc` prunes it, after `gc.reflogExpireUnreachable` (30 days by default), as with a rebase. So do the stored drafts' old states. `git reflog expire --expire-unreachable=now` followed by `git gc --prune=now` removes them.

## Undoing by hand

Every branch move Suonetar makes is in the branch reflog with a message naming the tip it moved from: `suonetar: apply 3 commits from <old>`, and likewise `undo` and `redo`. Suonetar's own Undo button reaches only the last of them. To go back further, or if Suonetar is not at hand:

```sh
git log -g --format='%h %gs' <branch>   # find the entry to go back past
git reset --keep <old>                   # the oid from that entry's message
```

`--keep` refuses rather than overwrite uncommitted changes to files the reset touches. Commits made on top since that entry are dropped from the branch by the reset (they stay in the reflog); cherry-pick them back if they are wanted.

## The private worktree and pre-commit hooks

Apply runs the repository's `pre-commit` hook on every commit it rewrites, before publishing anything. The hook runs in a private worktree at `.git/suonetar/wt`. It shows in `git worktree list` as detached and locked ("suonetar private worktree"). While a pass runs, `.git/suonetar/wt.lock` holds the pid of the Suonetar process using it.

- **Removing it.** `git worktree remove --force --force .git/suonetar/wt` removes it; the next apply with a hook recreates it. A stale `wt.lock` (left by a process that no longer runs) is taken over automatically, unless its pid has since been reused by a running process, which Windows does readily; then delete `wt.lock` by hand once no Suonetar is running.
- **What the hook sees.** The hook sees the commit's change staged on top of its parent, with HEAD detached at a stand-in for the parent. Hooks that check the branch name see no branch.
- **What the hook does not see.** The worktree holds only tracked files: no `node_modules`, `.venv`, or build output. A hook that needs those fails, and the commit can be applied with the hook skipped for it, or the whole apply without hooks.
- **Node module resolution.** Because the worktree sits inside the repository, Node's module resolution can still find the main worktree's `node_modules`, but `node_modules/.bin` is not on the hook's PATH.
- **husky.** With husky's ignored `.husky/_` as `core.hooksPath`, the main worktree's copy of the hooks directory is used. Its dispatcher then runs the main worktree's `.husky/pre-commit`, not the commit's.
- **npx.** `npx` is told not to download missing packages (`npm_config_yes=false`), so a hook that relies on `node_modules` fails rather than fetching tools from the registry.
- **PATH.** Suonetar started from a desktop launcher may lack PATH entries a shell profile adds (`~/.cargo/bin`, nvm). Hooks that call such tools then fail; start Suonetar from a shell.
- **LFS and partial clones.** LFS files are pointer files in the private worktree. In a partial clone, the first checkout of the private worktree fetches every blob it needs.
- **Cancelling.** Cancel sends the hook's process group SIGTERM, then SIGKILL two seconds later. Containers a Docker-based hook started are outside it and keep running. lint-staged keeps a backup in `refs/stash` while it runs, so a cancel in the middle can leave a "lint-staged automatic backup" entry in `git stash list`; it holds only the hook's view of the commit and can be dropped.
- **Cancelling on Windows.** Windows has no process groups or SIGTERM: cancel kills the hook and everything it started at once, with no time to clean up. A git command the hook was running can leave its lock file behind (`.git/refs/stash.lock` under lint-staged, `.git/packed-refs.lock`); delete it if git then reports it. Processes a hook leaves running after it exits (a daemon such as `eslint_d` or a Gradle daemon) are not stopped, since Windows no longer links them to the hook.
- **If Suonetar itself is killed mid-hook,** the hook's processes keep running in the private worktree until they finish. On Linux the next apply takes over the worktree regardless; on Windows a process still running there (or a daemon a hook left behind) can keep the next apply from resetting the worktree until it exits.

## The merge tool

"Open in `<tool>`" in the resolve view runs `git mergetool` for one conflicted file, with the tool named by `merge.tool` and configured as `git mergetool` would use it (`mergetool.<tool>.cmd`, `trustExitCode`). It runs against a throwaway index and work tree under `.git/suonetar/mergetool-*`, which are removed when the tool exits; one left behind by a killed Suonetar can be deleted. The tool's result replaces the editor's text, and nothing is stored until Save resolution.

- **Cancel** stops waiting for the tool; it does not close the tool. A merge dialog left open writes into a directory that is already gone, and its result is ignored. On Windows `git mergetool` itself keeps running too, and the directory stays until the tool is closed; a later merge tool run in the same Suonetar removes it, and one still there after Suonetar exits can be deleted. The three versions `git mergetool` handed the tool stay in `$TMPDIR/git-mergetool-*`, since the open dialog may still be reading them; they can be deleted once it is closed.
- **The tool's processes are left alone.** A tool that starts an IDE (Rider's `rider merge` when Rider is not running) keeps that IDE running after the merge and after Suonetar exits.
- **Terminal tools** (`vimdiff`, `nvimdiff`) have no terminal to run in and wait until cancelled. Use a graphical tool.
- **`mergetool.guiDefault`** can make `git mergetool` run `merge.guitool` instead of the tool the button names.
- **To check by hand with Rider:** open a conflict with Rider already running, again with Rider not running, and cancel once with the merge dialog open; in each case Suonetar should get the result (or stop waiting) and Rider should stay usable.
