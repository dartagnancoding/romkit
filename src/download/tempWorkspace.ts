/**
 * A temporary working folder for one download/import job:
 *
 *   <tempDirectory>\job-<timestamp>-<random>\
 *     download\     the downloaded file
 *     extracted\    archive contents
 *     staging\      files being zipped (compressToZip systems)
 *
 * Removed at the end unless --keep-temp is used.
 */

import { join } from "node:path";
import { logger } from "../logging/logger";
import { ensureDirectory, removeDirectory } from "../util/fileSystem";

export interface Workspace {
  rootDirectory: string;
  downloadDirectory: string;
  extractionDirectory: string;
  stagingDirectory: string;
  dispose(keepFiles: boolean): Promise<void>;
}

export async function createWorkspace(tempDirectory: string): Promise<Workspace> {
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rootDirectory = join(tempDirectory, `job-${uniqueSuffix}`);
  const workspace: Workspace = {
    rootDirectory,
    downloadDirectory: join(rootDirectory, "download"),
    extractionDirectory: join(rootDirectory, "extracted"),
    stagingDirectory: join(rootDirectory, "staging"),
    async dispose(keepFiles: boolean) {
      if (keepFiles) {
        logger.info(`Temporary files kept at ${rootDirectory}`);
        return;
      }
      try {
        await removeDirectory(rootDirectory);
      } catch (error) {
        logger.warn(`Could not remove temporary folder ${rootDirectory}: ${(error as Error).message}`);
      }
    },
  };
  await ensureDirectory(workspace.downloadDirectory);
  await ensureDirectory(workspace.extractionDirectory);
  await ensureDirectory(workspace.stagingDirectory);
  logger.debug(`Temporary folder: ${rootDirectory}`);
  return workspace;
}
