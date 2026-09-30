# Suonetar

A commit-stack editor for plain git: scrub through a series of commits, open any one in a real editor, edit its files, and have every descendant restack automatically. Named after the Kalevala's Lady of Veins, who spins new veins to mend broken ones. Complements `git absorb`; coexists with Claude Code running git commands in the same repo's main working tree.

The founding design brief is `docs/design-brief.md`; research notes and decisions live alongside it in `docs/`.

## Standards

Language-agnostic standards, always in force:

@CLAUDE-general.md

Language-specific standards. Both are imported until the implementation stack is settled; delete the one that doesn't apply once it is.

@CLAUDE-rust.md
@CLAUDE-python.md
