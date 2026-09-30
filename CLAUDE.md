# Suonetar

A commit-stack editor for plain git: scrub through a series of commits, open any one in a real editor, edit its files, and have every descendant restack automatically. Named after the Kalevala's Lady of Veins, who spins new veins to mend broken ones. Complements `git absorb`; coexists with Claude Code running git commands in the same repo's main working tree.

The founding design brief is `docs/design-brief.md`; research notes and decisions live alongside it in `docs/`.

## Build and run

- `npm run app -- <repo>` builds and opens the editor on a repository (relative paths resolve against where npm was run); `npm run dev -- <repo>` runs it with renderer hot reload.
- `npm run check` type-checks (two programs: `tsconfig.json` for engine, main, and preload; `tsconfig.renderer.json` for the DOM side) and lints; `npm test` runs the Vitest suite, which drives real git.
- Layout: `src/engine` (git operations, Node only), `src/main` (Electron main process, hosts the engine), `src/preload` (the IPC bridge), `src/shared` (types both sides of IPC use), `src/renderer` (the UI; no Node access).

## Standards

Language-agnostic standards, always in force:

@CLAUDE-general.md

The implementation stack is TypeScript end to end (Electron, CodeMirror 6); see `docs/research-2026-09-30.md` section 3.8.

@CLAUDE-typescript.md
