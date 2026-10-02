#!/usr/bin/env bun
/**
 * romkit entry point. Everything happens in runCli; this file only turns the
 * result (or a fatal error) into the process exit code.
 */

import { runCli } from "./cli/commandRouter";
import { reportFatalError } from "./cli/errorReporter";

try {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
} catch (error) {
  process.exit(reportFatalError(error));
}
