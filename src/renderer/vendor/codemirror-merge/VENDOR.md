# @codemirror/merge, vendored

[@codemirror/merge](https://code.haverbeke.berlin/codemirror/merge) 6.12.2 (commit `7bf4c68aac86cfe51da6ff97ecb4be133c91c763`, 2026-06-09), the TypeScript files of its `src/`, MIT-licensed (`LICENSE`).

Every local change is marked with a `// Suonetar:` comment saying why; `git diff` against the commit that added this folder lists them exactly. To update, copy the new tag's `src/*.ts` over upstream's files here, carry the local changes across, and update the version above.

`deletion-layout.ts` is Suonetar's own, not upstream's, and keeps Suonetar's style and lint, though it compiles with the rest of the folder, which imports it.

The code keeps upstream's style and is compiled under its own `tsconfig.json`, as a project `tsconfig.renderer.json` references, so the renderer is checked against its declarations; Biome skips upstream's files.
