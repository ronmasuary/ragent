import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Several suites spawn real child processes (MCP servers, skills, telegram).
    // Running test files sequentially avoids cross-file CPU thrash that made the
    // first cold MCP child-spawn exceed the connect timeout under parallel load.
    fileParallelism: false,
    // Headroom for the MCP integration tests' child-process handshakes.
    testTimeout: 15_000,
  },
});
