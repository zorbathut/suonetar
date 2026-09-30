# Recovering from an interrupted apply

Suonetar publishes a rewritten stack under git's own index lock (see `research-2026-09-30.md` §3.2). Throughout, it keeps a record at `.git/suonetar/intent.json`, updated at every step:

```json
{ "branch": "refs/heads/feature", "oldTip": "<sha>", "newTip": "<sha>", "pid": 12345, "time": "...", "phase": "worktree-updated" }
```

When Suonetar finds that file:

- if the process named by `pid` is still running, an apply is in progress and Suonetar waits;
- if `phase` is `locking` and `.git/index.lock` does not exist, the apply never got the lock, nothing changed, and Suonetar deletes the record by itself;
- otherwise the apply stopped partway, and Suonetar refuses to do anything until it is sorted out, showing the record. Nothing has been lost. Your drafts are only cleared after a successful apply, and they live in `refs/suonetar/drafts`.

What to do depends on `phase`. Make sure the process named by `pid` is not running first (`ps -p <pid>`).

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
- Every commit Suonetar replaces stays in the branch reflog; Suonetar sets `gc.reflogExpireUnreachable=1.year` in the repository's config so they are kept that long. `git reflog expire --expire-unreachable=now` followed by `git gc --prune=now` removes them.
