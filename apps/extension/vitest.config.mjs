import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __ELEVATE_API_BASE__: JSON.stringify("http://127.0.0.1:8000"),
    __ELEVATE_WEB_BASE__: JSON.stringify("http://localhost:3000"),
    __ELEVATE_CONNECT_ORIGINS__: JSON.stringify(["http://localhost:3000"]),
    __ELEVATE_BUILD_MODE__: JSON.stringify("test"),
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    environmentOptions: { happyDOM: { url: "https://careers.example.test/jobs/123?utm_source=x#apply" } },
  },
});
