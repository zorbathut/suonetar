# Hostile review of `research-2026-09-30.md` — 2026-09-30

Review by a separate agent (Opus), briefed as a design reviewer with the brief, the research notes, the project standards, and git 2.55 in scratch repositories, without the author's justifications. Reproductions t1–t12 were run under the session scratchpad and are not preserved; the recipes are described inline. Adjudication is recorded in `research-2026-09-30.md` section 3.0. The report follows verbatim.

---

I ran the reproductions below against git 2.55.0 in scratch repos (t1–t12 and `big`). I read nothing in `/home/zorba/werk` except the suonetar docs and standards, and I changed and committed nothing in suonetar. I did not re-run the godot timings, since the review scope kept me out of that checkout. Items marked "argument" are reasoning, not reproductions.

## 1. Objections, by severity

### O1 [BLOCKING] The coexistence "transaction" is not a transaction, and its failure path damages history twice

**What's wrong.** Section 3.1 calls `read-tree -m -u old new` followed by `update-ref --stdin` "one transaction". They are two processes with a gap between them, and nothing stops the other process from acting in that gap. The prescribed recovery ("revert the worktree with the same command in reverse") is wrong when the other process committed during the gap.

**Evidence (t4, reproduced exactly):**
```
read-tree -m -u T T'                   # exit 0: index+files = T', dev still at T
git commit -am "claude: update claude.txt"   # Claude, inside the gap
   -> Claude's commit X changes claude.txt AND edited.txt (the user's suonetar edit)
update-ref refs/heads/dev T' T         # fatal: ... is at X but expected T
read-tree -m -u T' T                   # the doc's revert: exit 0
final: HEAD = X (user's edit now inside Claude's commit)
       git status: "M  edited.txt"     # staged phantom revert: v1 on disk, v2 in HEAD
```
One race causes two silent corruptions. The user's edit is attributed to Claude's commit at the wrong position in the stack, and Claude's next `git commit -a` commits a revert of it. Reversing the order (CAS first) just moves the problem to the phantom-revert window the document itself describes in 1.6. Neither order is safe without a lock. The document also has no path for when the revert itself refuses.

**Related failures the protocol doesn't handle:**
- **Claude's rebase gets stranded (t10).** During Claude's `rebase -i` (HEAD detached, `.git/rebase-merge/` present), the branch still points at the old tip, so the tool's CAS succeeds. Claude's `git rebase --continue` then fails with `cannot lock ref 'refs/heads/dev': is at <tool's tip> but expected <old>` and is left in "interactive rebase in progress". Stack discovery via `merge-base(base, HEAD)..HEAD` would also have used the detached, half-rebased HEAD.
- **Spurious refusals (t6).** After `touch a.txt` with unchanged content, `read-tree -m -u` fails with `Entry 'a.txt' not uptodate. Cannot merge.` Agents, formatters and builds touch files constantly, so this will fire often unless the index is refreshed first.
- **Linked worktrees.** The protocol names "the main worktree", but the branches it moves can be checked out in linked worktrees (Claude Code has built-in worktree support). `git rebase --update-refs` skips such branches (verified, t9). The tool must skip them too, or update each of those worktrees.
- **Crash between steps.** There is no intent record, so a crash after `read-tree` and before the CAS leaves exactly the phantom-staged state from 1.6.

**What I'd do instead:**
1. **Pre-flight checks.** Refuse unless HEAD is a symbolic ref to the stack branch and none of `rebase-merge/`, `rebase-apply/`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG` or `sequencer/` exists for that worktree. Use `git worktree list --porcelain` to skip, and report, every branch to be moved that is checked out elsewhere.
2. **Apply under git's own lock (verified, t5).**
   - Create `.git/index.lock` with O_EXCL and copy the index to a private file.
   - Run `GIT_INDEX_FILE=<private> git update-index -q --refresh`, then `read-tree -m -u T T'`, re-check HEAD, then CAS.
   - Install the private index by writing it into `index.lock` and renaming that to `index` (git's lockfile protocol).
   - On CAS failure, revert using the private index, which nobody else can have touched.
   - In t5, Claude's `git commit -am` during the window failed with "File exists" instead of swallowing the edit.
   - Write an intent record (T, T′, pid) before, remove it after, and recover from it on startup.
3. **Be honest about what the lock doesn't cover.** It blocks only git commands that write the index. It does nothing about Claude's direct file writes (Edit/Write tools, `sed -i`, `cat >`, formatters, codegen). Git's own lock-error text also tells the reader to "remove the file manually", which an agent may do.
4. **The real fix is cooperative.** The user owns Claude Code's configuration: a PreToolUse/PostToolUse hook pair sharing an atomic mutex with the tool (e.g. `mkdir .git/suonetar/lock`) makes the tool apply only between Claude's tool calls. The document treats the other process as an uncontrollable adversary when it can be programmed.

### O2 [BLOCKING] The auto-resolve recipe loses data, and "ours" is the wrong default

**What's wrong (three separate defects):**
- **Whole-file replacement drops non-conflicting hunks (t1).** Step 3 replaces every conflicted path with its stage-2 blob, which discards all of C's changes to that file, not just the conflicting hunk. C changed line 5 (conflicting) and line 35 (not conflicting). The recipe's result has no `line 35 C-change`, while `git merge-tree --write-tree -X ours` keeps it.
- **The document missed `-X` (t1).** `merge-tree -X` exists in 2.55 (`-X, --strategy-option` in `git merge-tree -h`) and gives hunk-level resolution.
- **Directory/file conflicts leave junk in the "clean" tree (t3).** The stage list names `a~98dc20a5…`, not `a`. The written tree contains both `a/x` and `a~98dc20a5…`, and the recipe commits `a~98dc20a5…` as a real file, which the next `read-tree -u` puts into Claude's checkout. `-X` doesn't help with non-content conflicts. The claim that "the visible tree never contains conflict markers" is true, but the tree can still contain garbage.

**Favoring "ours" cascades and removes later work from the tip Claude is working in (t2).**

Setup: N adds `fn() { return 1; }`, C changes it to `compute(1)`, D to `compute(1) + cache()`, and E is unrelated. The user edits N to `return 2`.

| Favor | C | D | Tip line | Tip tree vs original |
|---|---|---|---|---|
| ours (document, GitButler) | flagged | **flagged (cascade)** | `fn() { return 2; }` | changed: `compute` and `cache` gone from Claude's worktree |
| theirs (replayed commit) | flagged | clean | `fn() { return compute(1) + cache(); }` | **identical to the original tip** |

Argument: agent stacks are built this way, with later commits refining lines earlier ones added. Favoring the replayed commit ("later commit wins") keeps the tip stable, and the tip is the tree Claude is editing. It also stops the cascade and confines the flag to the one commit where the two intents collide. GitButler's choice fits a product that owns the workspace, not a tip a live agent is editing.

**What I'd do instead.** Detect conflicts with plain `merge-tree` (exit code and stage list). Build any resolved tree with `merge-tree -X theirs` for hunk-level resolution. Handle non-content conflicts (modify/delete, directory/file, rename/rename, mode) with explicit per-type rules, or refuse them. Under O3, the MVP needs no auto-resolution at all.

### O3 [BLOCKING] Record-and-continue should not be the v1 engine; resolve before publishing

**What's wrong.** The document calls record-and-continue "the natural one" because the engine cost is small. The real cost is elsewhere: publishing a lossy commit onto a branch that another process rewrites, builds on and pushes.

**Evidence:**
- **The flag is fragile (t7).** The claim that "trailers propagate through every rewrite unconditionally" is false for the most common rewrites an agent does:
  - **Squash** via `rebase -i` puts the trailers mid-message, and `%(trailers:key=Suonetar-Conflict)` returns empty.
  - **Claude-style amend** that appends a `Co-Authored-By:` paragraph: same result.
  - **`commit --amend -m`** removes the flag entirely.

  When the flag is lost, the lossy tree remains with nothing marking it. At minimum, detection must grep the whole message.
- **Two sources of truth (argument).** Conflicted paths come from C (via the keep ref and `Suonetar-Conflict-Source`), everything else from C′. Step 4 ("on save writes the resolved tree") doesn't say which tree the resolution is applied to:
  - applied to the `merge-tree` output, it loses anything Claude amended into C′;
  - applied to C′'s tree with the paths replaced, it loses Claude's edits to those paths.
- **Replaying a flagged commit is undefined (argument).** When the user edits below C′ again, does the tool replay C′ (making the lossy resolution permanent) or re-derive from C (discarding everything done to C′ since)?
- **The flag depends on position (argument).** It records a conflict against a specific parent, but trailers travel with the commit when Claude reorders the stack or rebases it onto a new `main`. After that the flag is stale: the conflict may be gone or may be different.
- **The leak argument is backwards (argument).** An auto-resolved tree is the silent kind of leak: it compiles, and CI may pass without C's change. Committed markers are the loud kind. The document rejects markers as "what would leak" and chooses the quiet failure.
- **The only leak guard contradicts the document.** The pre-push hook is "optional" and conflicts with 3.2's "no hooks".
- **In this setting the lossy tip lands in Claude's worktree mid-task** (and with favor-ours it removes later work, O2).

**What I'd do instead: resolve-before-publish.**
- The engine already computes the whole replay in memory before touching a ref. If any commit conflicts, publish nothing.
- Present the conflicts in order in the editor as part of the save, feed each resolution back into the replay, and publish once, atomically, when everything is clean.
- This is the brief's halt-and-prompt without its objection. Nothing halts in the repo (no rebase in progress, no detached HEAD, Claude keeps working); only the user's pending save waits.
- It removes trailers, keep refs, Source SHAs, the pre-push hook, auto-resolve code and flag re-derivation from the MVP.
- If the user wants to walk away mid-resolution, persist the pending save as `refs/suonetar/pending/<branch>`.
- Revisit record-and-continue only if conflicts that must outlive a session actually occur.

### O4 [SHOULD-FIX] No commit identity survives the other process's rewrites

**What's wrong.** On CAS failure the document says the tool "re-reads and re-replays (tens of ms)". But the user's edit targets N by SHA. After Claude amends, rebases onto `main`, reorders or squashes, N has a new SHA or no longer exists, and the tool cannot find it.

**Why it matters.** Pending edits, open editor buffers and flags (if O3 is rejected) are all keyed by SHA, and all of them break on the other process's routine rewrites.

**What I'd do instead:**
- Treat an edit as a patch (N's tree → edited tree) and three-way it onto the matched commit N* with `merge-tree` (base N, ours N*, theirs edited). This can itself conflict, which O3's flow handles.
- For matching without hooks, key on author ident plus author date, which amend, rebase and cherry-pick preserve. Use patch-id as a secondary key, and have the UI confirm the match.
- An editor buffer bound to (commit, path) must detect that its commit vanished and say so. git-branchless solves this with a post-rewrite hook, and jj and GitButler with change-id headers. The document needs to pick an approach.

### O5 [SHOULD-FIX] The undo design fails in the common case and pollutes Claude's view

**What's wrong:**
- **Undo is unavailable whenever Claude has committed since.** Undo is a CAS back to the old values, and the document concedes it fails if anything moved the ref. Claude commits constantly.
- **The oplog isn't atomic.** It is appended "before each operation", so a failed CAS or a crash leaves phantom entries.
- **Undo refs pollute `git log --all` (t11).** `refs/suonetar/undo/<n>` grows without bound. `git log --all --graph` shows each saved version as undecorated duplicate history (`* e157ea2 c2 (pre-suonetar-edit version)` beside `* dba1081 c2`), because default decoration hides `refs/suonetar`. Claude sees duplicate commits with identical subjects and no explanation, and `push --mirror` would push them.

**What I'd do instead:**
- Make undo of "edit N" just another edit: restore the previous tree of the touched paths at the matched commit and restack through the normal path. This works on top of Claude's later commits and reuses the core code.
- Keep history in the branch reflog: write every move with `update-ref -m "suonetar: <op-id> …"`. Reflog entries are not traversed by `--all`, and they keep old commits alive for `gc.reflogExpireUnreachable` (30 days).
- Drop the undo refs and the JSON file. Keep refs are only needed for state that must outlive 30 days, and with O3 there is none.

### O6 [SHOULD-FIX] Stack identity and "every branch pointing into the range"

- **The upstream default shrinks the stack (argument).** With base = `@{upstream}` on a pushed feature branch, base is `origin/<branch>`, so the stack is only unpushed commits and is empty after every `git push`. Decide explicitly whether pushed PR stacks are editable, and show published commits as published rather than hiding them.
- **Working on `main` with base = `main` gives an empty stack.**
- **Merges freeze history.** Claude's `git merge main` or `git pull` ends the stack at the merge, so everything below it silently becomes uneditable. The UI must say so.
- **Rewriting every branch in the range is wrong in three ways:**
  - it rewrites backup branches made before a risky operation, defeating their purpose;
  - it moves branches checked out in linked worktrees, which must be skipped as `rebase --update-refs` does (verified, t9);
  - it leaves branches forked from a stack commit, with their own commits, on the pre-edit commits. They should at least be reported as left behind.

### O7 [SHOULD-FIX] Formatting is a hard requirement but is deferred, and "no worktree" was measured against the wrong baseline

**What's wrong:**
- **The MVP defers a named need.** The brief says "good syntax highlighting, formatting, and editing"; section 3.4 defers formatting to "Later".
- **Commit N isn't on disk (argument).** LSP servers read the project from the filesystem, so without a checkout of N they analyze the tip in the main worktree, giving wrong diagnostics and go-to-definition. Formatters also resolve their config relative to the file's path on disk.
- **Wrong baseline for the worktree cost.** The document dismissed worktrees using fresh `worktree add` (1.7 s on godot). A persistent edit worktree switched with `checkout --detach` only touches the files that differ.

**Measured (synthetic repo, 15,000 files, 20-commit stack):**

| Operation | Time |
|---|---|
| fresh `worktree add` | 260 ms |
| switch between stack commits in a persistent worktree (5 runs) | 11–16 ms |
| `status` in that worktree | 12 ms |
| `read-tree -m -u` in the main worktree | 15 ms |

Latency does not require keeping worktrees out of the hot path.

**What I'd do instead.**
- A persistent edit worktree gives correct LSP and formatter context at N, plus "run tests at N" for free.
- It also opens an architecture the document never evaluated: stack panel, plus persistent edit worktree, plus the user's existing editor (Kate has LSP and formatting), with saves detected by inotify on that worktree. There would be no embedded editor at all.
- Whether that meets "real editor" is the author's call, but "simple over elegant" requires it to be on the table.
- If CodeMirror stays, the MVP needs "format buffer via external command" (`rustfmt --emit stdout`, `ruff format -`, `prettier --stdin-filepath`), which is about 20 lines.

### O8 [SHOULD-FIX] The case for Rust rests on deferred features (YAGNI)

**What's wrong.** Each stated reason fails:
- **"Tauri needs Rust"** — Tauri is deferred, and a Tauri shell can point a webview at the existing localhost server or run the engine as a sidecar.
- **"One binary"** — it's a personal tool on one machine.
- **"gix escape hatch"** — the document itself says it isn't needed.
- **"Authoring speed doesn't decide it"** — for a small engine, authoring and iteration are nearly the whole cost.

**What I'd do instead.** The engine is subprocess orchestration, JSON, a lock file and a localhost HTTP server.
- **Python:** its standard library covers all of that, and `CLAUDE-python.md` already prescribes the injected subprocess-runner seam.
- **Rust:** the same engine needs tokio, axum, serde and tokio::process.
- **TypeScript end to end** is the other simple option: one language and one toolchain (the frontend already needs npm and a bundler), with shared API types.

Honest verdict: Python or TypeScript is simpler. Rust is fine if the author prefers it, but the document should say that rather than cite deferred features.

### O9 [SHOULD-FIX] Browser tab: keyboard shortcuts and localhost security

- **Reserved shortcuts (argument, well-known browser behavior).** Chrome and Firefox reserve Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Shift+T and Ctrl+Tab; a page in a normal tab cannot `preventDefault` them. Ctrl+W on a page with an unsaved buffer closes it. Cheap fixes for the MVP:
  - launch as `chromium --app=http://127.0.0.1:PORT/#<token>`, giving its own KDE window and taskbar entry, with window rules by class;
  - add a `beforeunload` guard;
  - Firefox also has a per-site "Override Keyboard Shortcuts" permission.
- **No authentication (omitted entirely).** An unauthenticated localhost server that reads repo contents and rewrites history is reachable by any page the user visits, via cross-origin "simple" POSTs and DNS rebinding. Bind 127.0.0.1, check `Host` and `Origin`, and require a random per-launch token.

### O10 [SHOULD-FIX] Correctness gaps in the MVP's commit-writing path

- **File modes.** The document's own recipe hardcodes `--cacheinfo 100644`: editing an executable script drops +x, and editing a symlink turns it into a regular file. Take the mode from `ls-tree`, and don't open symlinks or gitlinks in the text editor.
- **Signing.** `commit-tree` ignores `commit.gpgSign` (verified: with `commit.gpgSign=true` and `gpg.program=/bin/false`, `commit-tree` succeeded and wrote an unsigned commit, while `git commit` failed). The tool must read the config and pass `-S`, and should expect one pinentry prompt per replayed commit.
- **Empty commits.** The document says the tool "has to decide" and never decides. My recommendation: keep them, shown as empty.
- **Author, committer and encoding.** Preserve author name, email and date through `GIT_AUTHOR_*`, set the committer to now, keep the `encoding` header, and pass the raw message bytes through (no stripspace).
- **Message editing.** It's deferred, but it's about 20 lines on the same write path, and conflict resolution already rewrites messages. Include it.
- **Hooks.** pre-commit, commit-msg and post-rewrite are bypassed. That's acceptable (it matches `replay` and `history`), but say so: users who rely on pre-commit formatting get unformatted amends, which ties back to O7.
- **Binary files.** Detect them (a `-` in `diff-tree --numstat`) and don't open them in CodeMirror.

### O11 [MINOR] The inotify watcher and reftable detection are YAGNI

Re-reading before each operation is already the correctness mechanism. A one-second `rev-parse` poll or refresh-on-focus is enough for live following. Linked worktrees keep their HEADs elsewhere anyway.

### O12 [MINOR] Edge cases in the edit and apply paths

- **Filters are bypassed.** `hash-object --stdin` without `--path` implies `--no-filters` (man page), and `cat-file` returns the repository form of a blob. That's fine for eol normalization, but under LFS the user edits the pointer, and under git-crypt ciphertext comes in and plaintext is stored, which leaks secrets into history. Refuse to edit paths that have a `filter=` attribute. "Exactly the user's git" is true for merges, not for the edit path.
- **Ignored files get overwritten (t6).** `read-tree -m -u` silently overwrote an ignored file (`build.log`) that the new tip starts tracking. That matches `checkout`, but in Claude's worktree it can eat build output or a local `.env`.
- **A stale `index.lock` loops forever.** A git process killed when an agent's command timed out leaves the lock behind, and "retry shortly" never ends. Report the lock's age.
- **Submodules.** `read-tree -u` doesn't update submodule checkouts, so a moved gitlink shows as modified and invites a commit of the old pointer. Pass `--recurse-submodules`, or refuse gitlink changes.
- **Conflict labels are raw OIDs (t3 messages).** Supply readable labels for the resolve view.

### O13 [MINOR] Internal inconsistencies and overstatements

- Section 1.4 says "the notes ref should all be moved together", but notes are rejected in 3.1.
- Section 3.2 says "no hooks", but 3.1 proposes a pre-push hook.
- Section 1.6's "the same two-tree update a git rebase performs at its end" is inaccurate (argument): rebase switches the worktree at the start and at each pick, and its final step only moves refs. The analogy hides that rebase holds the worktree for the whole operation, which this tool does not.
- "Markers cascade into every descendant that touches the file" is wrong: merges work at hunk level, and the auto-resolved tree cascades too (t2).
- "Trailers propagate through every rewrite unconditionally" is false (t7).
- The "40–400×" speedup compares against a fresh checkout, which is the wrong baseline (O7).

## 2. Decisions I agree with

- Scrubbing is pure object-database reads (`cat-file --batch`, `diff-tree`), with no checkout per scrub.
- Per-commit `merge-tree --write-tree --merge-base` via the system git is the right replay primitive; clean, content, modify/delete and empty-result behavior verified as described.
- `--attr-source=<tree>` is required. Verified: a `merge=union` attribute in C's tree is ignored without it (exit 1) and honored with it (exit 0).
- `git replay` is not a building block. Verified: it moved the checked-out branch by default (leaving `D  x` staged), and on conflict it exits 1 with empty output.
- All ref moves go in one `update-ref --stdin` transaction with CAS.
- Section 1.6 is correct and important: moving the checked-out branch requires a two-tree worktree update.
- Refusing rather than stashing is right.
- Dropping git-branchless and scm-record as dependencies is right.
- Not adopting GitButler is right (it fails coexistence, and the FSL license applies).
- Never committing marker trees is right.
- Merge commits ending the stack is fine for v1.
- No 3-way merge view in v1 is fine.
- CodeMirror 6 is the right embedded editor, if an embedded editor is chosen.
- Browser first, Tauri later, is right.
- Deferring hunk-moving and LSP is right.

## 3. Material omissions

1. **Claude Code is programmable.** Hooks and CLAUDE.md instructions are the only real coordination channel, since file writes by an agent are invisible to git locks (O1).
2. **Commit identity across external rewrites**, and what happens to an editor buffer when its commit is rewritten or removed (O4).
3. **Crash recovery for the apply step**, plus stale-lock handling.
4. **Detection of in-progress git operations** (rebase, merge, cherry-pick, bisect, sequencer) (O1, t10).
5. **Localhost server security** (O9).
6. **Where Claude actually works**: linked worktrees, and branches forked from the stack (O6).
7. **Published-commit awareness**: which stack commits are already on a remote, and what force-pushing implies.
8. **Testing the concurrency protocol.** Under the standards (real-git integration tests over mocks), the `GitRunner` seam earns its place by letting tests inject "the other process" between the tool's git calls, not by faking git. The document doesn't say so.
9. **UX while Claude is committing**: the stack list shifting under the cursor, and saving to a commit that was just rewritten.
10. **Lifecycle of the tool's refs**: pruning, and `push --mirror` exposure.
11. **Claude's stale view of files.** The Edit tool detects modification since its last read; Bash-driven writes don't, and can silently revert the tool's worktree update.
12. **Formatting and LSP need commit N on disk**, which the worktree-free design doesn't provide (O7).

## 4. Questions only the author can answer

1. Do you edit the stack while Claude is actively working on the tip, or between its turns? This decides whether O1's race is a daily event or a rare one.
2. Will you accept Claude Code hooks or CLAUDE.md rules as part of the coexistence protocol?
3. Does Claude only work in the main worktree on the stack branch, or also in linked worktrees and branches forked from the stack?
4. Which commits should be editable: unpushed only, or pushed PR stacks with force-push? Do you ever work directly on `main`?
5. How long do conflicts need to stay unresolved: minutes (resolve-before-publish is enough) or days?
6. When your edit to N collides with a later commit, which side should win at the tip by default?
7. Would your existing editor (Kate?) on a persistent edit worktree satisfy "real editor", or must editing sit inside the stack UI?
8. Is Rust a personal preference? If not, would Python or TypeScript end to end be acceptable?
9. Do the target repos use commit signing, LFS or git-crypt, submodules, or pre-commit hooks?
10. Which languages must formatting cover on day one?
11. Chromium or Firefox? Is an `--app` window acceptable?
12. Is it one repo per tool instance, or several?
