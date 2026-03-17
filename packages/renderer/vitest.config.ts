import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
	test: {
		globals: true,
	},
	resolve: {
		alias: {
			"@napolab/texture-bridge-core": path.resolve(__dirname, "../core/src/index.ts"),
			"@napolab/texture-bridge": path.resolve(__dirname, "../native/index.js"),
		},
	},
});
