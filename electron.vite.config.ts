import { defineConfig } from "electron-vite";

export default defineConfig({
	main: {},
	// A sandboxed preload cannot load ES modules, so it is built as one CommonJS file.
	preload: { build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs", inlineDynamicImports: true } } } },
	renderer: {},
});
