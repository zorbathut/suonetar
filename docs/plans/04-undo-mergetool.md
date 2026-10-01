# Plan 04 — Undo, the mergetool break-out, and opening on the newest commit

This is the rest of slice 4 in `docs/research-2026-09-30.md` §3.10, after plan 03 (pre-commit at apply). Undo follows §3.4 as revised by hostile review O5. The mergetool break-out follows §3.1. Opening on the newest commit is a small UX fix that was promised earlier.

User decisions (2026-09-30):
- **Formatting** goes on the longer-term list.
- **Undo** restores the exact old commits when the branch has not moved since. The edits that were applied do not come back as drafts.

Dropped after measuring: **list-then-fetch `commitDocument`**. Planefarer's largest recent commit is 59 files and under 800 KiB in total. It moves to "Later" with that measurement.

A hostile review (Opus) ran git experiments on the first draft. Its findings are folded in below and listed at the end.

## 1. Open on the newest commit

- `src/renderer/view-decide.ts`: with nothing selected yet, `followed()` picks the newest (last) commit. Stacks are oldest-first.
- `reselect` is unchanged: once something is selected, it keeps its position.
- `view-decide.test.ts` is updated.

## 2. Self-describing reflog messages (behaviour change, before undo)

**Messages.**
- Apply writes `suonetar: apply <n> commits from <old-oid>`.
- Undo and redo (§3) write `suonetar: undo <n> commits from <old-oid>` and `suonetar: redo …`.
- The rollback entry keeps the ` (rolled back)` suffix.

**Why.**
- No pretty format exposes a reflog entry's old value.
- `git log -g` silently drops entries whose objects are missing, so inferring the old value from the next entry can pick the wrong one.
- Reading `.git/logs` breaks under reftable.
- It also makes undoing by hand a one-liner.

**Code.**
- `publish` keeps taking the message.
- A small `reflogMessage(verb, count, old)` helper and its parser live in the new `src/engine/undo.ts`, and `session.ts` uses the helper.
- The apply tests that check the subject are updated.

## 3. Undo

### Engine (`src/engine/undo.ts`)

**Finding the target: `undoFind(repo, branch, tip)`.**
- Reads `git log -g -n 200 --format=%H%x00%gs <branch>`, newest first.
- An entry whose subject ends in `(rolled back)` is skipped together with the entry it rolled back.
- The first entry that parses as a Suonetar message is the target `{ verb, old (from the message), new (%H) }`.
- Undo is single-level: once an undo is the newest Suonetar entry, older applies are reachable only by hand. The docs say so.

**Pairing (a cross-check).**
- Let B = `merge-base(old, new)`. The commits in `B..old` and `B..new` (oldest first) must be equal in number, contain no merges, have pairwise equal author lines, and their objects must exist.
- Otherwise the entry is unavailable, with a reason.

**Info for the UI: `UndoInfo`.**
- `{ kind: "exact" | "edits"; verb: "undo" | "redo"; old; new; commits; pushed }`, or `{ kind: "unavailable"; reason }`, or undefined when there is no entry at all.
- `verb` comes from the target. Undoing an `apply` or a `redo` is an undo; undoing an `undo` is a redo. The label stays right on the third press.
- `pushed` counts the commits an exact undo drops that are on any remote: `rev-list --count B..new --not --remotes`. It is computed in the engine because those commits may be below the base and missing from `stack.commits`. After a push on `dev`, the stack is empty.
- Unavailable cases, shown as a disabled button with the reason as its tooltip:
  - this branch has stored drafts (status other than `elsewhere`): "apply or discard the edits first";
  - a pairing failure;
  - `old` is already an ancestor of the tip (a manual reset already undid it);
  - for `edits`, some Xᵢ that would get a draft matches no stack commit by oid or author line (it would only make an orphan).

**Exact (tip == new).**
- `publish(repo, branch, new, old, "suonetar: <verb> <n> commits from <new>")`: the same locked path as apply, with pre-flight, intent record, CAS and the `read-tree -m -u` refusal.
- No hooks run, and SHAs and signatures come back as they were.

**Edits (the tip moved since).**
- For each pair (Xᵢ in `new`, Yᵢ in `old`, with X₀ = Y₀ = B), compute Dᵢ = `merge-tree(base=tree(Yᵢ₋₁), ours=tree(Xᵢ₋₁), theirs=tree(Yᵢ))`: Yᵢ's own change on Xᵢ's actual parent. The reviewer checked this with real merges.
- A purely restacked commit gives Dᵢ = tree(Xᵢ) and gets no draft.
  - The exception is when the forward apply's pre-commit changed trees: then restacked commits get formatting-revert drafts, and the undo's own Apply re-runs the hook. This is stated in the docs, not claimed away.
- If the merge conflicts, Dᵢ = tree(Yᵢ), and the later Apply goes through the resolve view.
- Drafts are built with `draftFor(basics(Xᵢ), branch, Dᵢ, message(Yᵢ))` from `drafts.ts`, which gets `baseMessage` right, and are written in one CAS `storeWrite`. They then show as current, or as rebased if Claude rewrote Xᵢ.

**Session.**
- `SessionState.ready.undo: UndoInfo | undefined` is read on each `state()`. That is one `log -g`, one `merge-base` and two `rev-list` calls, plus `--not --remotes`.
- `Session.undo(old, new, kind)` runs under the mutex. It recomputes and returns `{ kind: "stale" }` unless the same (old, new) pair and kind are still the target.
- Results:
  - exact: the `PublishResult` kinds;
  - edits: `{ kind: "drafted"; drafts: n }`;
  - `{ kind: "unavailable"; reason }` or `stale` otherwise.

### UI (`src/renderer/main.ts`, `index.html`)

**The button.** An Undo button sits left of Apply.
- It is labelled "Undo apply" or "Redo", and hidden when `ready.undo` is undefined.
- It is disabled while unavailable, with the reason in its tooltip, and disabled while `busy`.

**Clicking it** runs an op that:
1. leaves the view (`viewLeave`, which flushes saves and asks about an unsaved resolution);
2. re-reads state;
3. confirms with the fresh info:
   - **exact:** the branch goes back to the commits it had before, and pressing again redoes it. Plus a warning when `pushed > 0` (a force-push is needed).
   - **edits:** commits were made since, so undo prepares edits on the affected commits for review and Apply, and later commits that build on the undone change will likely need resolving.
4. calls `api.undo`, then `refresh()`.

**Reporting.** Apply's outcome switch is factored into a shared `publishOutcomeShow` (its own refactor commit), and undo's publish outcomes use it. The status line reads "Undone.", "Redone." or "Prepared the undo as edits on n commits; review them and Apply."

### Tests (`src/engine/undo.test.ts`, real git, no hook configured)

**Finding and info.**
- No Suonetar entry gives undefined.
- An apply alone gives `exact`.
- An apply then a commit on top gives `edits`.
- A rolled-back pair is skipped.
- A missing old object or an unpaired entry gives `unavailable`.
- Drafts present give `unavailable`.
- Reset to old gives `unavailable`.

**Exact.**
- The stack is three commits: an edit on the first, one restacked commit, and the top.
- After undo the tip is `old`, the worktree matches, and the subject is right.
- Three presses: undo, redo, undo, with the verbs and labels right each time.
- `pushed` is counted when the replaced commits are on a remote even though the stack is empty.
- With an uncommitted change to an affected file in the main worktree, publish refuses (at `read-tree`) and the file is intact.

**Edits.**
- After a commit on top, the only draft is on the edited commit. Applying it gives the old trees and keeps the top commit's change.
- A message-only apply gives a message-only draft.
- After Claude rebases (amends the top), the drafts show as rebased.
- The conflict fallback's draft is tree(Yᵢ).
- `stale` when the target changed between info and undo.

## 4. Mergetool break-out

### Engine (`src/engine/mergetool.ts`)

**A throwaway index and work tree, not the hook worktree.** The reviewer showed three problems with the hook worktree:
- `lockTake` lets the same pid take the lock over, so an Apply after a renderer reload would run in the same directory and index;
- a cancelled mergetool leaves `_BASE_`/`_LOCAL_`/`_REMOTE_` files that later hook runs would see;
- an orphaned Rider dialog can write late.

So:
- `mergetoolName(repo)` returns `git config merge.tool`, or undefined. With none configured, the button is not offered: mergetool would otherwise guess a tool and prompt.
- `mergetoolRun(repo, { stages, markerTree, path, content }, signal)`:
  1. Make a temporary directory `<commonDir>/suonetar/mergetool/<unique>/` with `index` and `wt/`.
  2. Build the conflicted index entries for `path` with `update-index -z --index-info`, from the stages of the conflict record that `mergeTrees` recomputes. Write `content`, the editor's current text, to `wt/<path>`.
  3. Run `git -c mergetool.writeToTemp=true -c mergetool.keepBackup=false -c core.hooksPath=/dev/null mergetool --no-prompt -- <path>`.
     - It runs with `GIT_DIR`, `GIT_WORK_TREE=…/wt`, `GIT_INDEX_FILE=…/index` and `GIT_ATTR_SOURCE=<markerTree>`, so the repo's eol and filter attributes apply as they do for the commit.
     - The reviewer verified this works with no `MERGE_HEAD`, including add/add with no base.
  4. It merged if git exited 0 and `ls-files -u -- <path>` against the temporary index is empty. The result is `cat-file blob :0:<path>` from that index: the repository form, not the work-tree file (CRLF, smudge).
  5. In `finally`, remove the temporary directory.
- Results:
  - `{ kind: "merged"; content: Buffer }`
  - `{ kind: "unresolved"; output }`
  - `{ kind: "cancelled" }`
  - `{ kind: "unconfigured" }`

**The runner.** `runHook` gains a required option, `group: "kill" | "leave"`.
- Hooks pass `"kill"`, which keeps today's behaviour.
- The tool passes `"leave"`. Cancel then sends SIGTERM to the git process only, and nothing kills the group after exit, so a Rider IDE started by `rider merge` is never killed.
- Cancel means "stop waiting and ignore the result". The tool's dialog may stay open, and its late write lands in a directory that is already gone.

**Session.**
- `mergetool(inputs, key, path, content)` sets up under the mutex: recompute `mergeTrees`, find the record, check that `path` is one of its paths with text stages.
- The tool then runs outside the mutex. The only shared state is object-database writes, and the renderer is busy, so no other call arrives anyway.
- The `applyCancel` → `cancel` rename lands in a refactor commit just before this one, and `cancel()` reaches the tool.
- The window-close text becomes "An operation is running…".

### UI (`resolve-view.ts`, `main.ts`)

- On content records only, each path's header gets "Open in `<tool>`". The name comes from a new API, `mergetoolName()`, fetched in `ResolveView.create`.
- Clicking it runs inside the op queue. The host's new `busy(on)` sets the app busy with Cancel visible, and the status line reads "Waiting for `<tool>`… (Cancel stops waiting; close the tool's window yourself.)".
- On `merged`, the text is decoded with the row's codec and replaces the whole document in one transaction, which Ctrl+Z undoes. The user still presses Save resolution.
- On `unresolved`, the tool's output goes in the record status.

### Tests (`src/engine/mergetool.test.ts`, fake tools via `mergetool.fake.cmd`)

- `cat "$BASE" "$LOCAL" "$REMOTE" "$MERGED" > "$MERGED.new" && mv …`: the stages are base, below and this commit, and `$MERGED` held `content`.
- A tool copying `$REMOTE` with `trustExitCode=true` gives `merged`. One exiting 1 gives `unresolved`, with its output.
- `trustExitCode=false` with the file unchanged and stdin closed gives `unresolved` without hanging.
- No `merge.tool` gives `unconfigured`. A tool command not on PATH gives `unresolved`.
- `*.txt text eol=crlf`: the result blob is LF.
- A sleeping tool plus abort gives `cancelled`.
- Afterwards, the temporary directory is gone and the main worktree's status and index are untouched, both after success and after cancel.
- `git.test.ts`: `group: "leave"` does not kill a background child after exit.

Manual checks (Rider can't be driven headless) go in the docs for the user: Rider already running, Rider not running, and Cancel with the dialog open.

**Unsupported setups, documented.**
- A terminal tool (`vimdiff`) has no terminal and hangs until Cancel.
- `mergetool.guiDefault` can make git run `merge.guitool` instead of the tool named on the button.

## 5. Docs

- **Plan doc** `docs/plans/04-undo-mergetool.md`: this plan and its review adjudication. Research §3.10 "Later" gets formatting and list-then-fetch (with the measurement). These land in the first commit.
- **With undo:**
  - a note in §3.4 on the exact and edits kinds and single-level undo;
  - in `docs/recovery.md`, undoing by hand: `git log -g --format='%gs' <branch>`, then `git reset --keep <old>` from the message.
- **With the mergetool:** `docs/recovery.md` notes the temporary directory, what Cancel does, and the unsupported setups.

## Commits

1. Add the plan 04 doc and its review adjudication (plus the "Later" list).
2. Open on the newest commit.
3. Self-describing reflog messages for apply.
4. Factor apply's outcome display into `publishOutcomeShow` (refactor).
5. Undo and redo the last Suonetar operation.
6. Rename `applyCancel` to `cancel` (refactor), plus a runner `group` option (refactor; hooks keep `"kill"`).
7. Mergetool break-out.

Each commit passes `npm run check` and the full `npm test`.

## Verification

- `npm run check` and `npm test` (full) for each commit.
- Manual smoke under Xvfb with the CDP driver (`launch.sh` and helpers in the scratchpad):
  - apply an edit, undo, redo, undo;
  - commit on top with git, undo: drafts appear, then Apply;
  - a content conflict with `merge.tool=fake` (a script that writes a resolution): Open in fake, buffer replaced, Save resolution, Apply;
  - a hanging fake tool, then Cancel.
- The user tries Rider by hand.

## Review adjudication

All accepted:
- **B1:** throwaway index and work tree, no hook worktree.
- **S1–S6:**
  - self-describing messages;
  - a distinct redo verb;
  - `pushed` computed in the engine;
  - the result read from the index;
  - runner `group: "leave"`;
  - an `unavailable` kind.
- **Minors 1–12**, adopted as written above. Specifically:
  - hook caveat stated;
  - fallback test;
  - reset-to-old gives unavailable;
  - `draftFor`;
  - (old, new) identity;
  - UI leaves and re-reads first;
  - generic close text;
  - unsupported tools documented;
  - the reselect bullet dropped;
  - the wording fixed;
  - single-level stated.

## Revisions after code review

A hostile code review (Opus) checked every commit for bisectability and ran real-git experiments. It found nothing blocking. Adopted:

- **A cancel could crash the main process.** The `"leave"` runner signalled git's pid directly, which throws ESRCH once git has exited but the tool still holds the pipes. It now uses `child.kill`, which does nothing after exit.
- **A tool result the editor cannot show was dropped**, losing the merge: mixed line endings, invalid UTF-8, or NUL bytes. It can now be saved exactly as the tool wrote it.
- **Tests now pin:**
  - the tool surviving Cancel;
  - the conflict fallback conflicting again at Apply;
  - an edit from another branch on the same commit refusing undo rather than being overwritten;
  - a dropped replacement commit making undo unavailable;
  - an add/add conflict in a subdirectory.
  
  Tests no longer leave `sleep` processes or `/tmp/git-mergetool-*` directories behind.
- **Undo.**
  - An unreadable `suonetar:` reflog entry stops the search (unavailable) instead of being skipped.
  - The entry's commit count is checked against the pairing.
  - `exact` and `edits` are separate variants of `UndoInfo`.
  - The pairing is computed once per undo.
  - A failure to read the history shows on the button instead of failing the whole state read.
- **UI.**
  - The undo button hides when the state is not ready.
  - The status line is updated after the merge tool returns.
  - The interrupted banner no longer says "apply", since undo can be what was interrupted.
  - The exact-undo confirmation says redo lasts until the next apply.
- **Closing the window during a merge tool** waits for its throwaway directory to be removed.
- The `applyCancel` rename and the runner option are separate commits.

Deviation from the plan, kept deliberately: undo as edits requires *every* replacement commit to still be in the stack, not just those that will get a draft. Which ones get a draft is only known after merging.

Not adopted: renaming `HookRunner`/`runHook` now that they also run the merge tool. The rename would ripple through every commit of the series for a naming nit; it can come with the next change to the runner.
