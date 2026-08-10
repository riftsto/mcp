import { defineConfig } from "vitest/config";

/**
 * This package has to be runnable on its own, because it is extracted to its
 * own repository. Without a config here vitest walks up and finds the parent
 * application's, which works today by accident and stops working the moment
 * this directory is a repository root.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
