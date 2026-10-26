import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Never touch the developer's real OS keychain from tests.
    env: { GMAIL_MCP_KEYRING: "0", GMAIL_MCP_NO_BROWSER: "1" },
    testTimeout: 20000,
  },
});
