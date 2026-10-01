# Suonetar

[![Language: TypeScript](https://img.shields.io/badge/language-TypeScript-blue)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

[![Build status](https://img.shields.io/github/actions/workflow/status/zorbathut/suonetar/test.yml?branch=dev)](https://github.com/zorbathut/suonetar/actions?query=workflow%3ATest+branch%3Adev) [![Support](https://img.shields.io/discord/703688553707601962?label=support&logo=discord)](https://discord.gg/vQv9DMA)

Suonetar is a commit-stack editor for Git. It's designed for weirdos who use LLMs a lot, tell their LLMs to split up work into a lot of small independent commits, and then have to deal with reviewing like twelve commits at once. Who would do something like that? Bizarre.

It lets you scrub through the commits on a branch, open any one of them in a real editor, change its files or message, and Apply; every commit above it is restacked automatically, with nothing left half-done in the repository.

It's built to sit beside an agent (Claude Code, for those with taste, smug emoji here) that commits in the same repository's main worktree. Reading an agent's stack of commits and fixing the one that went wrong happens in one view, and Suonetar never stashes, checks out, or rebases in your working tree.

Named after the Finnish Kalevala's Lady of Veins, who spins new veins to mend broken ones.

## Status

Experimental and personal. It works on the author's repositories and is tested against real git, but it has not been used widely. Expect rough edges. Feedback appreciated.

## Running it

Needs Node 24 or later and git 2.55 (what it is developed and tested against; older versions may lack commands it uses). Linux is the only platform it has been run on but like it *should* work anywhere, y'know?

```sh
npm install
npm run app -- path/to/repo
```

A relative path resolves against the directory npm was run from. A second argument sets the stack's base for that run, as in `npm run app -- path/to/repo origin/core`. `npm run dev -- path/to/repo` runs it with the UI hot-reloading.

## Using it

**The stack.** The left pane lists the commits on the checked-out branch above its base, newest first as `git log` lists them, opening on the newest. When the branch is on the server (where `git push` sends it, or a branch of the same name on `origin` or `upstream`) and has commits that aren't there yet, the base is that copy, so the stack is your unpushed work. Otherwise, when everything is pushed or nothing is, the base is where the branch left the default branch of `origin` or `upstream` (or its local copy, `init.defaultBranch`, `main`, `master`); on the default branch itself that leaves nothing to edit. Commits already on a remote are marked *pushed*, since rewriting them means a force-push. The base moves as commits are made and pushed: an edit to a commit that drops below it is kept and listed, and comes back once the branch is pushed. To edit further back, give the base after the repository on the command line, or set it for the repository:

```sh
git config suonetar.base origin/main
```

**Editing.** Each commit shows as one scrolling document: its message, then every changed file as an inline diff against the parent, editable in place. Edits autosave as a *draft* for that commit; clicking between commits loses nothing, and drafts survive closing the window. A draft can be reverted per file, and "Show my edits" diffs it against the commit instead of the parent. Symlinks, submodules, binary files, and files with a `filter=` attribute (LFS, git-crypt) are read-only; images (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO) are shown before and after, side by side.

**Apply** publishes every draft at once:

1. The whole stack is replayed in memory. If a commit above an edit conflicts with it, nothing is published; the conflict opens in a resolve view (with per-block "keep below / keep this commit / keep both", or **Open in `<merge.tool>`** for your own merge tool), and Apply continues once every conflict is resolved.
2. The repository's `pre-commit` hook runs on each rewritten commit in a private worktree, as `git commit` would have run it. Formatting a hook does is folded into that commit. A failing hook stops the apply with its output shown; you can fix the commit, skip the hook for it, or apply without hooks.
3. The branch, index, and files are updated together under git's own index lock. Commits are signed if `commit.gpgSign` is set.

**Undo** sits next to Apply. If nothing has moved the branch since the last apply, it puts back exactly the commits it had (same SHAs and signatures), and pressing it again redoes. If commits were made on top since, it prepares edits that restore the old commits for you to review and Apply. It is one level deep; [docs/recovery.md](docs/recovery.md) shows how to go further back by hand. (note: a human has not reviewed this yet)

**Keys.** Alt+PageUp / Alt+PageDown move up and down the stack, uncommitted changes included, Ctrl+Alt+PageUp / Ctrl+Alt+PageDown between files, F7 / Shift+F7 between changes. Ctrl+S saves now; Ctrl+R reloads.

## Alongside an agent

The repository is re-read every second, and before every operation. When the agent commits, amends, or rebases while you have drafts, each draft is carried onto the matching rewritten commit and shown as needing confirmation; a draft whose commit disappeared is kept and listed, never dropped. Apply refuses rather than overwrites when a file it would change has uncommitted changes in the worktree, when a rebase or merge is in progress, or when the branch moved while it was working.

## What it writes

- Drafts and conflict resolutions in `refs/suonetar/drafts`, which has its own reflog.
- Every commit it replaces stays in the branch reflog, as after a rebase, until git prunes it (`gc.reflogExpireUnreachable`, 30 days by default). Its reflog entries read `suonetar: apply 3 commits from <old tip>`.
- `.git/suonetar/`: an intent file while an apply runs (left behind if one is interrupted), the private worktree pre-commit hooks run in (also listed by `git worktree list`), and throwaway directories while a merge tool is open.

[docs/recovery.md](docs/recovery.md) covers recovering from an interrupted apply, undoing by hand, and the private worktree and merge tool in detail. (note: a human has not reviewed this yet)

## Development

```sh
npm run check   # type-check (engine and renderer separately) and lint
npm test        # Vitest; the engine tests drive real git
```

- `src/engine`: git operations, Node only.
- `src/main`: the Electron main process, which hosts the engine.
- `src/preload`: the IPC bridge.
- `src/shared`: types both sides of IPC use.
- `src/renderer`: the UI, CodeMirror 6, no Node access.

Planned work is in [docs/todo.md](docs/todo.md). Coding standards are in `CLAUDE.md` and the files it includes.
