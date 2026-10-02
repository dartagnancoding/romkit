/**
 * Turns any error that reaches the top of the program into a clear message and
 * an exit code. Known errors (RomkitError) print without a stack trace; anything
 * else is a bug, so the stack goes to the log file (and to the console with --verbose).
 */

import { RomkitError, UsageError, UserCancelledError } from "../errors";
import { logger } from "../logging/logger";
import { style } from "./terminalStyle";

export const EXIT_CODES = {
  failure: 1,
  usage: 2,
  /** Conventional code for "interrupted by Ctrl+C". */
  cancelled: 130,
};

export function reportFatalError(error: unknown): number {
  if (error instanceof UserCancelledError) {
    console.log("");
    logger.info("Cancelled.");
    return EXIT_CODES.cancelled;
  }

  if (error instanceof RomkitError) {
    logger.error(`Error: ${error.message}`);
    if (error.hint) logger.info(style.dim(error.hint));
    return error instanceof UsageError ? EXIT_CODES.usage : EXIT_CODES.failure;
  }

  const unexpectedError = error instanceof Error ? error : new Error(String(error));
  logger.error(`Unexpected error: ${unexpectedError.message}`);
  logger.fileOnly(unexpectedError.stack ?? unexpectedError.message, "error");
  if (logger.isVerbose && unexpectedError.stack) {
    console.error(style.dim(unexpectedError.stack));
  } else {
    logger.info(style.dim("Run again with --verbose for details, or check the log file."));
  }
  return EXIT_CODES.failure;
}
