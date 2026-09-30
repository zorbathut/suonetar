# Commit-Stack Editor — Design Brief

## Problem

My Claude Code workflow produces sequences of commits that I then go back and revise. Editing commit N in a stack of M currently means manual interactive rebases, fixup commits, and conflict-halting restacks. I want an IDE-like tool: scrub through a series of commits, open any one, edit its files in a real editor, and have everything above it restack automatically.

This is a research/design brief, not an implementation request. The main open problem is noted at the end.

## Hard constraints

- **Git only.** Not switching to jj, Sapling, or any other VCS. Plain git repos, plain git storage.
- **Genuinely open-source base.** VS Code doesn't count.
- **Editor needs are modest:** good syntax highlighting, formatting, and editing. Not a full IDE.
- **Must coexist with Claude Code** running git commands in the same repo. Don't take over the main working tree.
- Bias toward simple and actually-usable over elegant and complex.

## Already in use

- `git absorb` — routes staged fixes into the correct earlier commits automatically. Works well; the tool should complement it, not replace it.

## Core git primitive

Scrub-and-edit reduces to:

1. `git worktree add --detach <tmpdir> <commit-N>` — edit N without touching the main checkout.
2. User edits files; `git commit --amend` in that worktree.
3. `git rebase --onto <new-N> <old-N> <tip>` — reflow descendants onto the amended commit.
4. Update the branch ref; remove the worktree.

Everything else is UI and error handling around this loop.

## Engine building blocks (don't write the restack logic from scratch)

- **git-branchless** (arxanas; MIT/Apache; Rust). Auto-restacking, `git move`, whole-repo `git undo`, smartlog. Implements Mercurial-style changeset evolution on top of git via the post-rewrite hook and an event log. Exposed as crates (`git-branchless-lib` etc.). Caveats: self-described alpha, on-disk format may change, development pace appears to have slowed. Use as a pinned dependency or as reference implementation.
- **scm-record** (same author; MIT/Apache; Rust). Reusable hunk/line-selection editor component. jj uses it as its default interactive diff editor.
- **git-revise** (Python; MIT). Performs mid-stack amends and autosquash in memory without touching the working tree. Study this if worktree checkouts make scrubbing feel slow.
- **git2-rs / libgit2** or **gitoxide** if building the engine layer in Rust directly.

## Editor base candidates

Ranked roughly by ease of splicing in a custom stack panel:

- **CodeMirror 6** (MIT). Designed for embedding; own 100% of the surrounding UI. Pair with a small local daemon (Rust or Python) serving a web UI, or Tauri for a packaged binary. Likely the lowest-effort path to a bespoke tool.
- **Eclipse Theia** (EPL-2.0). Framework for building custom IDEs, uses Monaco, no restrictions on custom views/widgets. Heavy TypeScript/DI build, but purpose-built for this.
- **KTextEditor / Kate** (LGPL, Qt/KDE). Reusable editor component (embedded by Kate, KDevelop, Kile). Kate has a C++ plugin system and an existing git plugin to crib from. Native fit for a KDE desktop; C++ plugin dev is the cost.
- **Monaco standalone** (MIT). VS Code's editor, separable from VS Code with a clean license. Heavier than CodeMirror.
- **Neovim + Neovide** (Apache/MPL). Fastest to prototype via Lua; `diffview.nvim` already implements much of the scrubbing UI. Least polish.

Rejected: **Lapce**, **Zed** — WASM/WASI-sandboxed extensions can't render custom UI, so it would mean forking a large codebase.

## Prior art (reference, not a base)

- **GitButler** — the closest existing product to this concept: drag hunks/files between commits in a stack, auto-restack, undo timeline, and an edit mode that checks out a commit's tree for editing. Tauri/Rust/Svelte over plain git. **License is FSL-1.1-MIT (source-available, non-compete; each version converts to MIT after two years).** Fine to read and to fork for personal use; don't build a distributable competing git client on its recent code.
- **gg** (jj GUI, Apache-2.0, Tauri + Rust + Svelte). Good reference for stack-visualization UI, though its engine is jj-lib and so not directly usable here.

## Key open design decision: conflicts

Git has no first-class conflicts, so a restack after editing commit N will sometimes halt partway. This choice shapes the whole architecture — decide it first:

- **Halt-and-prompt:** surface the conflicted commit as a resolution mode in the UI, like interactive rebase does. Simpler; blocks further edits until resolved.
- **Record-and-continue (jj-style emulation):** commit the conflict-marked tree, flag that commit as conflicted in tool-owned metadata (e.g. a ref namespace or a note), keep restacking, and let the user fix it whenever. Better UX; you own the bookkeeping, and conflict markers can leak into history if flagging is buggy.

## Other things to settle early

- **Undo:** the reflog tracks individual refs, which is painful for multi-commit rewrites. Either adopt git-branchless's event log or record your own snapshot of all relevant refs before each operation.
- **Stack identity:** how the tool decides which commits form "the stack" (e.g. `main..HEAD`, or an explicit base ref).
- **Scrub latency:** worktree checkout per scrub vs. read-only blob viewing with checkout only on edit.
