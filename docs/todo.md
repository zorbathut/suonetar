# To do

- LSP against the worktree, through `@codemirror/lsp-client`.
- An embedded three-pane merge view, beside the resolve view and the `merge.tool` break-out.
- Optional coordination with Claude Code: a PreToolUse/PostToolUse hook pair sharing a lock with Suonetar (`mkdir .git/suonetar/lock`), so an apply lands only between Claude's tool calls. Git's index lock does not cover its direct file writes.
- Formatting in the editor: an external command run on the file in the private worktree at that commit, which covers stdin and in-place formatters alike. Waiting on a formatter being chosen for the target repository, whose hook lints but does not format.
- A list-then-fetch `commitDocument`, if commits grow big enough to need it; the target repository's largest recent commit is 59 files and under 800 KiB.
- A desktop launcher: a `.desktop` file installed under `~/.local/share/applications`, carrying the icon in `resources/`. It must be named for the window's app ID (`suonetar.desktop`, package.json's `desktopName`) or carry a matching `StartupWMClass`, or the desktop treats the launcher and the running window as different apps. The window shows the icon without one.
