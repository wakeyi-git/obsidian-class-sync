import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			// 통합 테스트 하니스: 엔진이 import하는 obsidian/pouchdb-browser를 인메모리 대체물로.
			// 정규식으로 정확히 일치시켜 깊은 경로(pouchdb-browser/lib/...)는 건드리지 않는다.
			{ find: /^obsidian$/, replacement: path.resolve(root, "test/harness/obsidian.ts") },
			{ find: /^pouchdb-browser$/, replacement: path.resolve(root, "test/harness/pouchdb-memory.ts") },
		],
	},
	test: {
		setupFiles: [path.resolve(root, "test/harness/setup.ts")],
		// 기존 순수 테스트(src/**)와 신규 통합 테스트(test/**) 모두 수집.
		include: ["src/**/*.test.ts", "test/**/*.test.ts"],
	},
});
