/**
 * What the user sees when a source shows a captcha, blocks us or returns an
 * unexpected page: romkit stops and explains how to continue manually.
 */

import type { ResolvedSystem } from "../config/configTypes";
import { logger } from "../logging/logger";
import type { BlockedOutcome } from "../sources/sourceAdapter";
import { style } from "./terminalStyle";

const REASON_TEXT: Record<BlockedOutcome["reason"], string> = {
  captcha: "asked for a captcha / anti-bot check",
  "http-status": "refused the request",
  "unexpected-page": "returned an unexpected page",
};

export function reportBlocked(sourceName: string, outcome: BlockedOutcome, system: ResolvedSystem): void {
  logger.error(`Stopped: ${sourceName} ${REASON_TEXT[outcome.reason]} (${outcome.detail}).`);
  logger.info("romkit does not try to get past these pages. Open this link in your browser and download manually:");
  logger.info(`  ${style.cyan(outcome.pageUrl)}`);
  logger.info("Then import the downloaded file with:");
  logger.info(`  ${style.bold(`romkit import "<downloaded file>" -sys ${system.id}`)}`);
  process.exitCode = 1;
}
