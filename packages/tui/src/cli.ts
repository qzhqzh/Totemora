#!/usr/bin/env bun
import { runCli } from "./commands";

const exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});

process.exit(exitCode);
