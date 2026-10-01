import { defineConfig } from "vitest/config";
import { TIMEOUT_SCALE } from "./src/engine/test-support/timeout.ts";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		testTimeout: 20000 * TIMEOUT_SCALE,
		hookTimeout: 10000 * TIMEOUT_SCALE,
	},
});
