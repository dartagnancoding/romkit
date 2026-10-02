/**
 * Error types shared by every module.
 *
 * Anything the user can act on should be thrown as a RomkitError: the CLI prints
 * its message (and optional hint) without a stack trace. Any other error is
 * treated as a bug and reported as "unexpected".
 */

export class RomkitError extends Error {
  constructor(
    message: string,
    /** Optional suggestion printed under the message, e.g. which command to run next. */
    readonly hint?: string,
  ) {
    super(message);
    this.name = "RomkitError";
  }
}

/** Invalid command line (unknown flag, missing argument...). Exits with code 2. */
export class UsageError extends RomkitError {
  constructor(message: string, hint?: string) {
    super(message, hint);
    this.name = "UsageError";
  }
}

/** The user cancelled an interactive prompt (Ctrl+C or closed input). */
export class UserCancelledError extends Error {
  constructor(message = "Cancelled.") {
    super(message);
    this.name = "UserCancelledError";
  }
}
