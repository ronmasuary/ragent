#!/usr/bin/env node
// Fixture that spawns but never responds to `initialize` — exercises the
// MCPManager connect timeout. It just sleeps forever, draining stdin.
process.stdin.resume();
setInterval(() => {}, 1 << 30);
