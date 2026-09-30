# Plan 01 — Engine core

Slice 1 of `docs/research-2026-09-30.md` §3.10. Design decisions are in that document's section 3; this plan turns them into modules, functions, and tests. No UI in this slice beyond a throwaway CLI.

## Scope

In: project scaffolding; git runner seam; object reads; stack discovery; commit writing; in-memory replay with drafts and conflict detection; locked apply; drafts persistence and edit-as-patch matching; integration tests including interleaved-other-process cases; a CLI smoke harness.

Out (later slices): Electron and UI; conflict *resolution* UI (the engine exposes resolutions as input, slice 4 builds the view); pre-commit hooks at publish; persistent worktree; undo; mergetool break-out.

## Scaffolding

- `package.json` (ESM, `"type": "module"`), TypeScript 7 with `strict`, Biome (line width 180), Vitest. Node 24 is installed; the engine only uses Node builtins, no runtime dependencies.
- Layout: `src/engine/*.ts` (Node-only, will run in Electron's main process), `src/cli/smoke.ts`, tests beside modules as `*.test.ts`, shared test support in `src/engine/test-support/`.
- Scripts: `npm test` (full suite, integration included), `npm run check` (tsc --noEmit + biome check).

## Modules

### `git.ts` — the runner seam

```ts
type GitResult = { stdout: Buffer; stderr: string; code: number };
type GitRunner = (args: readonly string[], opts: GitCallOptions) => Promise<GitResult>;
type GitCallOptions = { cwd: string; input?: string | Buffer; env?: Readonly<Record<string, string>> };
```

- `gitRunnerSpawn(): GitRunner` — the production implementation (`node:child_process` `spawn`, `LANG=C` / `LC_ALL=C` so stderr parsing is stable, `GIT_OPTIONAL_LOCKS=0` so the engine's reads never take the index lock behind Claude Code's back).
- A `Repo` value bundles `{ run: GitRunner; worktree: string; gitDir: string; commonDir: string }`, built by `repoOpen(run, path)` from `rev-parse --show-toplevel --absolute-git-dir --git-common-dir`.
- `gitOk(repo, args, opts?)` throws `ErrorGit` (args, code, stderr) on nonzero exit; callers that expect nonzero exits (merge-tree) call the runner directly.
- Tests inject "the other process" by wrapping the real runner: `runnerInterleaved(real, predicate, action)` runs `action` (arbitrary git commands against the same repo) just before the first call matching `predicate`.

### `objects.ts` — reads

- `class CatFile` owns one `git cat-file --batch` child per repo (the one class the TS standards allow: it owns a process). `read(oid): Promise<{ type; size; data: Buffer }>`; requests are queued and answered in order. Not routed through `GitRunner` (it is a long-lived stream, not a call); tests use the real one. `close()` on shutdown.
- `commitParse(data: Buffer): CommitInfo` — `{ tree, parents, authorLine, committerLine, encoding?, message: Buffer, otherHeaders }`. The author line is kept verbatim (name, email, timestamp, tz) because it is both what gets preserved on rewrite and the identity key for matching (research §3.3).
- `treeList(repo, treeish, path?)` via `ls-tree -z` → entries `{ mode, type, oid, path }`.
- `diffNameStatus(repo, a, b)` via `diff-tree -r -z --name-status --no-renames` plus `--numstat` for binary detection (`-` counts).

### `stack.ts` — discovery

`stackRead(repo): Promise<Stack>`:

1. `symbolic-ref -q HEAD` → branch; detached HEAD → `ErrorNotOnBranch`.
2. Base ref: `git config suonetar.base`, else the first of `main`, `master` that exists and is not the current branch; none → `ErrorNoBase`. Base commit = `merge-base <baseRef> HEAD`.
3. `rev-list --first-parent --reverse --parents <base>..HEAD` → commits. A merge commit truncates: the stack starts after the last merge, and `Stack.frozenBelow` records that merge so the UI can say why older commits are not shown.
4. Published: if `@{upstream}` exists, commits reachable from it (`rev-list <base>..@{upstream}` intersected) are marked `published: true`.
5. Returns `{ branch, tipOid, baseOid, baseRef, commits: StackCommit[], frozenBelow? }`, where `StackCommit = { oid, parent, tree, authorLine, subject, published }`.

The stack is re-read before every operation; nothing caches it across calls.

### `write.ts` — commit writing

`commitWrite(repo, spec: { tree; parent; authorLine; message: Buffer; encoding? }, sign: boolean): Promise<Oid>`:

- Unsigned (default): build the raw commit object — `tree`, `parent`, the original `author` line verbatim, a fresh `committer` line from `git var GIT_COMMITTER_IDENT`, `encoding` if the original had one — and write it with `hash-object -t commit -w --stdin`. The message bytes pass through untouched (verified: no stripspace, comment lines kept).
- Signed (`commit.gpgSign` true): `commit-tree -S -p <parent> -F - <tree>` with `GIT_AUTHOR_NAME/EMAIL/DATE` split from the author line and `-c i18n.commitEncoding=<enc>` when needed.
- Original `gpgsig` headers are dropped (the signature is invalid after rewrite); other extra headers are dropped too.
- `blobWrite(repo, content: Buffer)` via `hash-object -w --stdin` (no `--path`, so no filters — and paths with a `filter=` attribute are refused for editing in `drafts.ts`).
- `treeWithFiles(repo, baseTree, changes: { path; oid; mode }[])` via a temp index (`GIT_INDEX_FILE` in `.git/suonetar/tmp/`): `read-tree`, `update-index --cacheinfo` with the mode taken from the existing entry (research: never hardcode 100644), `write-tree`.

### `replay.ts` — the restack

`replayPlan(repo, stack, edits, resolutions): Promise<ReplayResult>` — pure computation in the object database; touches no ref, index, or worktree.

- `edits: Map<Oid, Edit>` where `Edit = { tree?: Oid; message?: Buffer }` is the desired new version of that stack commit (already rebased onto the current stack by `drafts.ts`).
- `resolutions: Map<string, Oid>` keyed by `${commitOid}:${newParentTree}` → resolved tree. A resolution is valid only for the exact parent tree it was made against; anything below changing again re-raises the conflict.
- Walk bottom-up with `newParent = stack.baseOid`:
  - Commit C unchanged (no edit, and `newParent === C.parent`): keep C as is. SHAs of untouched commits below the first edit are stable.
  - Otherwise target tree = `edit.tree ?? C.tree`. If `newParent === C.parent`, the result tree is the target tree. Else `git --attr-source=<target tree> merge-tree --write-tree -z --merge-base=<C.parent> <newParent> <target tree>`: exit 0 → result tree; exit 1 → conflict unless a matching resolution exists; other → `ErrorGit`.
  - Write the new commit with the edit's message or C's.
  - `empty: true` if the result tree equals the new parent's tree (kept, not dropped).
- Stops at the first unresolved conflict and returns `{ kind: 'conflict', commit, newParent, newParentTree, markerTree, conflicts: ConflictEntry[] }` where `ConflictEntry = { path; stages: { stage: 1|2|3; mode; oid }[]; messages: string[] }` parsed from the `-z` output (stage list + message records). Conflicted paths that are not plain content conflicts (no stage 1, or a `~` path, or differing modes) are marked `kind: 'structural'` so the UI can refuse or offer per-type choices.
- Otherwise returns `{ kind: 'clean', newTip, rewritten: { old: Oid; new: Oid; empty: boolean }[] }`.

### `apply.ts` — the locked publish

`applyPublish(repo, stack, newTip, reflogMessage): Promise<void>` implements research §3.2:

1. **Pre-flight** (re-reads everything): HEAD still symbolic to `stack.branch`; branch still at `stack.tipOid` (else `ErrorStackMoved`); none of `rebase-merge`, `rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`, `sequencer` exist under `rev-parse --git-path` (else `ErrorOperationInProgress` naming it); `index.lock` absent (else `ErrorGitLocked` with its age).
2. **Lock**: create `<gitDir>/index.lock` with `open(..., 'wx')` (`O_EXCL`). Copy `index` to `<gitDir>/suonetar/index.private`. Write `<gitDir>/suonetar/intent.json` `{ branch, oldTip, newTip, pid, time }`.
3. **Ignored-file check**: paths added between old and new tips (`diff-tree -r -z --diff-filter=A --name-only`) that currently exist on disk as ignored untracked files (`ls-files -z -o -i --exclude-standard -- <paths>`) → `ErrorApplyRefused` naming them.
4. **Worktree update** with `GIT_INDEX_FILE=index.private`: `update-index -q --refresh`, then `read-tree -m -u <old> <new>`. Nonzero → `ErrorApplyRefused` carrying git's stderr (it names the file).
5. **Ref move**: `update-ref -m <reflogMessage> --stdin` with `start / update HEAD <new> <old> / prepare / commit` (verified: `update HEAD` derefs to the branch and writes both reflogs, and the compare-and-swap covers the race window since step 1).
6. **On ref failure**: `read-tree -m -u <new> <old>` with the private index (restores the files; nothing else can have touched that index while we hold the lock), then release and throw `ErrorStackMoved`.
7. **Install**: copy `index.private` over `index.lock`, `rename(index.lock, index)` — git's own lockfile protocol. Delete `intent.json`.
8. **Every exit path** releases the lock (delete `index.lock` if we still own it) and deletes the private index; failure to release is itself reported, never swallowed.

Crash recovery in this slice is detection only: `stackRead` and `applyPublish` throw `ErrorInterruptedApply` if `intent.json` exists, carrying its contents, so the UI can show it; automatic recovery is deferred until a crash actually happens (and a test documents what state is left).

On first use, set `gc.reflogExpireUnreachable=1.year` in the repo's local config if it is unset (research §3.4), so reflog entries keep every replaced commit alive.

### `drafts.ts` — edits and identity

- A draft is `{ against: Oid; authorLine: string; tree?: Oid; message?: string (base64 of bytes) }`: "the new version of commit `against`". Stored in `<gitDir>/suonetar/drafts.json` keyed by branch; blobs and trees in the object database.
- `draftSetFile(repo, stack, commitOid, path, content: Buffer)` — refuses symlinks, gitlinks, and paths with a `filter` attribute (`check-attr filter -- <path>` at that commit via `--attr-source`); writes the blob, builds the tree with `treeWithFiles`, updates the draft. Setting content equal to the commit's original makes that path revert; a draft whose tree equals the commit's tree and has no message is deleted.
- `draftSetMessage(...)`, `draftDiscard(...)`.
- `draftsResolve(repo, stack): Promise<{ edits: Map<Oid, Edit>; orphans: Draft[]; conflicts: ... }>` — maps drafts onto the *current* stack:
  - `against` is in the stack → edit on that commit as is.
  - Otherwise match a stack commit with an identical `authorLine` (amend, rebase, and cherry-pick preserve it). Exactly one match → rebase the draft: `merge-tree --merge-base=<against tree> <matched tree> <draft tree>`; clean → edit on the match, and the draft is re-keyed in storage; conflict → reported as a draft conflict for that commit.
  - No match or several → orphan. Orphans are never deleted automatically; the UI lists them.

### `errors.ts`

`ErrorGit`, `ErrorNotOnBranch`, `ErrorNoBase`, `ErrorStackMoved`, `ErrorOperationInProgress`, `ErrorGitLocked`, `ErrorApplyRefused`, `ErrorInterruptedApply`, `ErrorEditRefused` — all `Error` subclasses carrying structured fields, per the TypeScript standards.

### `session.ts` — the façade the UI and CLI call

`sessionOpen(path)` → `{ stack(), commitFiles(oid), fileAt(oid, path), parentFileAt(...), draftSetFile(...), draftSetMessage(...), draftDiscard(...), preview(): ReplayResult, apply(resolutions) }`. `apply` = `stackRead` → `draftsResolve` → `replayPlan` → if clean `applyPublish` and clear the applied drafts; if a conflict, return it without touching anything. Keeps the IPC surface in slice 2 thin.

## Tests (Vitest, real git in temp repos)

`test-support/repo.ts`: `repoFixture()` creates a temp repo with fixed identity and dates (`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` set per commit so SHAs are deterministic), helpers `commitFiles(repo, msg, files)` and `stackOf(n)`.

- **stack**: base detection (`main`, `master`, `suonetar.base`), detached HEAD refused, merge truncation with `frozenBelow`, published marking with a fake upstream, empty stack on `main`.
- **write**: author line and encoding preserved byte-for-byte, message bytes untouched, executable bit and symlink mode preserved through `treeWithFiles`, signed path passes `-S` (test with `gpg.program` pointing at a stub script that emits a fake signature).
- **replay**: edit bottom commit, clean restack, untouched-below SHAs stable; content conflict reported at the right commit with stage entries; modify/delete and directory/file marked structural; resolution consumed only for the matching parent tree; empty result kept and flagged; `--attr-source` honours a `merge=union` attribute in the replayed commit's tree; message-only edit.
- **apply**: happy path moves branch, updates files and index, leaves `git status` clean, writes reflog messages on branch and HEAD; uncommitted edit to an affected file → refused, nothing moved, edit intact; uncommitted edit to an unrelated file survives; touched-but-unchanged file does not cause a refusal; ignored file in the way → refused; stale `index.lock` → `ErrorGitLocked`; rebase in progress → refused.
- **interleaved other process** (the review's reproductions, via `runnerInterleaved`): Claude commits between pre-flight and the worktree update → its `git commit` fails on the held lock (asserted), our apply succeeds; the branch moves (via `update-ref` from a raw process, which ignores the index lock) just before our ref transaction → CAS fails, worktree and index restored to the old tip, `git status` clean, the other process's commit intact.
- **drafts**: set/revert/discard; persistence across `sessionOpen`; external amend of the draft's commit (same author line) → draft rebased onto it; external rewrite that removes the commit → orphan, not deleted; filter-attribute and symlink paths refused.

## CLI smoke harness

`src/cli/smoke.ts` (run via `node --experimental-strip-types`, no build step): `stack`, `show <n>`, `edit <n> <path>` (opens `$EDITOR` on the blob, records a draft), `preview`, `apply`. Throwaway; kept only as long as it is useful.

## Revisions after hostile review

A hostile review (Opus, 2026-09-30) raised four blocking and ten should-fix objections, reproduced against git 2.55. All blocking ones are accepted; the sections above are superseded where they conflict with this list.

**Blocking, accepted**

1. *Replay above a merge dropped history.* Replay starts from `commits[0].parent`; `Stack.baseOid` is that commit (the merge when truncated). Test: edit above a merge, merge and everything below preserved.
2. *Drafts were unreachable objects that `git gc` deletes.* The draft store is a ref, `refs/suonetar/drafts`, pointing at a **tree** (a ref to a tree protects objects through `gc --prune=now`, passes fsck, and is not shown by `git log --all`):
   - `drafts/<against-oid>/meta` — JSON: `against`, `authorLine`, `branch`, `baseMessage` and `message` (base64) when the message is edited;
   - `drafts/<against-oid>/tree` — the draft's tree; `drafts/<against-oid>/base` — the `against` commit's tree, so rebasing works even if that commit is gone;
   - `resolutions/<sha1 of base:ours:theirs>/meta` and `/tree`.
   Every store update is a compare-and-swap on the ref; there is no `drafts.json`. `gc.reflogExpireUnreachable=1.year` is set at session open, not first apply.
3. *Resolutions keyed by commit OID reused stale results.* Keyed by the merge-input triple `(base tree, ours tree, theirs tree)`, persisted in the store. Changing the conflicted commit's draft changes "theirs" and re-raises the conflict.
4. *Clearing drafts after apply could delete a draft saved mid-apply.* All session operations go through one async mutex, and applied drafts are removed by compare-and-delete: only if the draft's store entry is unchanged since the apply read it.

**Should-fix, accepted**

5. The ref transaction updates `refs/heads/<branch>` explicitly (updating it still writes HEAD's reflog), with `--create-reflog`. `symbolic-ref HEAD` is re-checked under the lock before and after the transaction; `git checkout -b` succeeds while the index is locked, so if HEAD changed, the branch is compare-and-swapped back and the worktree reverted. The ref-moved test uses `git reset --soft`, the realistic vector.
6. Apply failure paths:
   - order is pre-flight, write intent (exclusive create), take the lock (exclusive create; `EEXIST` means locked), re-verify branch and HEAD under the lock;
   - the lock's fd is kept and its inode compared before install and before release, so another process's `index.lock` is never overwritten or deleted;
   - if the revert `read-tree` refuses, revert per file where the worktree still holds the new blob, and report the rest by name; drafts are only removed after success, so they survive;
   - a failure after the ref has moved keeps `intent.json` and the private index and returns `interrupted`;
   - an intent with no `index.lock` present is stale (the apply either finished or never locked) and is cleared automatically; an intent with a lock present returns `interrupted` with the manual recovery steps, documented in `docs/recovery.md`.
7. Replay is trees only: it returns per-commit result trees and `empty` flags and writes no commits, so a preview never runs the signer. Commits are written inside apply.
8. Drafts can add, delete, and edit files; new files are mode 100644; `resolutionBuild(markerTree, choices)` builds a resolved tree including deletions of structural-conflict leftovers. Temp indexes are unique per call.
9. `draftsResolve` does not mutate storage. Each draft gets a status: `current`, `rebased` (needs confirmation), `conflict`, or `orphan`; `draftConfirm` re-keys a rebased draft. A message draft whose `baseMessage` differs from the matched commit's message is a conflict. Apply refuses while any draft is `rebased` or `conflict`; orphans are reported, never applied or deleted. Patch-id matching from research §3.3 is dropped: author-line matching plus confirmation covers it.
10. Conflicts are classified from the `-z` message records (`CONFLICT (contents)` is content, everything else, including `CONFLICT (binary)`, is structural), grouped by the message's path list. Marker labels are raw tree OIDs, since `merge-tree` has no label option; the UI relabels them.
11. Published = reachable from any remote-tracking ref (`--remotes`). Base candidates are `main`, `master`, `origin/main`, `origin/master` (excluding the current branch); the candidate with the newest merge-base wins. On `main` with no remote the result is `ErrorNoBase`, not an empty stack.
12. `Stack.leftBehind` lists local branches other than the current one containing any stack commit. Pre-flight refuses if the branch is also checked out in another worktree.
13. `session.preview()` and `session.apply()` return discriminated unions (`clean`, `conflict`, `drafts-need-attention`, `refused`, `locked`, `moved`, `interrupted`, `nothing`); exceptions are for bugs. The stack carries a generation token (`tip:base`) so the UI can detect stale OIDs.
14. Fixtures isolate from the developer's config (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `HOME` set to the temp dir). The production runner strips inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR`, and `GIT_ALTERNATE_OBJECT_DIRECTORIES`. The interleaved "other process" runs git with a plain environment. Added tests: the review's missing-cases list.
15. Minor, accepted: no-op edits (tree equal to the commit's, no message) are not edits; the signed path uses `commit-tree` with an `@<ts> <tz>` date and accepts git's name normalisation; dropped signatures are listed in the preview; drafts are stored across branches in one ref and listed regardless of branch; the ignored-file check covers leading path prefixes.

**Pushed back**

- *Inject `spawn` into `CatFile` and the filesystem into apply.* `CatFile` is itself the resource that owns a process; a spawn factory adds indirection that no test would use, since tests run it against real git. Apply's filesystem steps are tested by constructing the on-disk states (stale intent, held lock, foreign lock) rather than by fault injection. Revisit if a crash window proves hard to test that way.

**Omissions, settled**

- The editor edits the raw commit plus its own draft; drafts on lower commits are not shown in it. Replay merges them, and a preview view can come later.
- Live-follow: the UI polls `session.generation()`, which is one `rev-parse`.
- Reflog messages are `suonetar: apply <n> commits`; old and new commits correspond one to one in order, since the tool never drops or reorders commits.
- Honest limit: `git reflog expire --expire-unreachable=now` followed by `git gc --prune=now` destroys replaced commits; drafts and resolutions survive it.

## Revisions after code review

A hostile review of the implementation (Opus, 2026-09-30) found three blocking and ten should-fix problems, each reproduced against real git; the UI plan review (plan 02) independently found several of the same. All were accepted except where noted.

- **Apply is a phase machine.** `intent.json` records `locking → locked → worktree-updated → ref-moved` at each transition. Failure handling is driven by the phase, never by whether `index.lock` exists (a third party controls that). Only `locking` without a lock is cleared automatically; an intent whose process is alive is `busy`. An error after the worktree update reverts it, and only if that revert fails is the state kept and reported as `interrupted`. A `read-tree` that fails partway (permissions, disk full) is reverted file by file. Lock ownership is checked (inode, with the fd still open) before the worktree update, before the ref move, and before install; release unlinks before closing. The heavy checks (in-progress markers, worktrees, ignored files) run before the lock is taken.
- **The per-file revert** compares mode and object id per path (symlinks by link text, files through their filters), handles file↔directory changes, removes added files and their emptied directories, and restores through `checkout-index` so filters apply.
- **Ignored directories and symlinks** in the way of the update are refused, not just ignored files.
- **Resolutions are per conflict record**, keyed like rerere by type, paths, and stage blobs, so an unrelated change lower in the stack no longer invalidates them. A resolution is a list of tree changes chosen per path (keep, a stage — optionally from another path for directory/file conflicts —, new content, delete a file, delete a directory), and `resolve` refuses unless every path of the conflict is accounted for and text is free of markers (unless explicitly allowed). Symlink and submodule "content" conflicts are structural.
- **Reads and saves go by commit OID** without reading the stack: `commitDocument(oid)` returns every changed file with parent/commit/draft contents (blobs over 4 MiB left out) and why a file is not editable; `draftDocument(against)` shows any draft, orphans included; `blob(oid)` serves conflict stages. Saves accept any commit object that exists, so an edit against a commit rewritten meanwhile becomes a `rebased` draft to confirm; while HEAD is detached, a commit that already has a draft can still be saved.
- **Drafts** are scoped to their branch (`elsewhere` otherwise, with `draftAdopt`), break author-line ties by subject, and are stored under a ref with a reflog.
- The mutex is per repository, `generation()` is fixed and tested, `apply` reports `published` with a warning if clearing drafts fails, commit headers round-trip byte for byte (decoded as Latin-1), null object ids follow the repository's hash length, and the `cat-file` reader buffers in linear time.

**Not adopted:** resolving drafts on other branches automatically when their commit is in this stack (a draft is for the branch it was made on; `draftAdopt` covers the rest).
