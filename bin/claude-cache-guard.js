#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`claude-cache-guard: ${message}`);
  process.exitCode = 1;
});
