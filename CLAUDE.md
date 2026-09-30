# Suonetar

A commit-stack editor for plain git: scrub through a series of commits, open any one in a real editor, edit its files, and have every descendant restack automatically. Named after the Kalevala's Lady of Veins, who spins new veins to mend broken ones. Complements `git absorb`; coexists with Claude Code running git commands in the same repo's main working tree.

The founding design brief is `docs/design-brief.md`; research notes and decisions live alongside it in `docs/`.

## Standards

Language-agnostic standards, always in force:

@CLAUDE-general.md

The implementation stack is TypeScript end to end (Electron, CodeMirror 6); see `docs/research-2026-09-30.md` section 3.8.

@CLAUDE-typescript.md
