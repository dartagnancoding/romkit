/**
 * Builds and prints the "before → after" plan used by `romkit organize`.
 * Pure logic: no files are touched here.
 */

import { style } from "../cli/terminalStyle";
import type { RomUnit } from "../extraction/romUnits";
import type { IdentificationResult } from "../identification/romIdentifier";
import { fileStem, lowercaseExtension } from "../util/fileSystem";
import { formatPercent, renderTable } from "../util/format";

export interface RenamePlanEntry {
  unit: RomUnit;
  currentBaseName: string;
  suggestedBaseName: string;
  identification: IdentificationResult;
  /** Confidence below the threshold: the user will be asked during apply. */
  needsConfirmation: boolean;
  /** The final name is wanted by another entry or already used by a file that stays. */
  hasDuplicateTarget: boolean;
}

export interface RenamePlan {
  changes: RenamePlanEntry[];
  unchangedCount: number;
}

export function buildRenamePlan(
  items: { unit: RomUnit; suggestedBaseName: string; identification: IdentificationResult }[],
  autoAcceptThreshold: number,
): RenamePlan {
  const changes: RenamePlanEntry[] = [];
  let unchangedCount = 0;
  /** Names of files that stay as they are; a change targeting one of them will conflict. */
  const unchangedTargetKeys = new Set<string>();
  const targetKeyOf = (unit: RomUnit, baseName: string) => `${baseName}${lowercaseExtension(unit.primaryFilePath)}`.toLowerCase();

  for (const item of items) {
    const currentBaseName = fileStem(item.unit.primaryFilePath);
    // Case-sensitive on purpose: "mega man" → "Mega Man" is a change worth making.
    if (currentBaseName === item.suggestedBaseName) {
      unchangedCount++;
      unchangedTargetKeys.add(targetKeyOf(item.unit, currentBaseName));
      continue;
    }
    changes.push({
      unit: item.unit,
      currentBaseName,
      suggestedBaseName: item.suggestedBaseName,
      identification: item.identification,
      needsConfirmation: item.identification.confidence < autoAcceptThreshold,
      hasDuplicateTarget: false,
    });
  }

  // Flag entries whose new names collide with each other (e.g. the USA and the
  // Europe versions both becoming "Game") or with a file that is not changing.
  // Windows names are case-insensitive, hence the lowercase keys.
  const entriesByTarget = new Map<string, RenamePlanEntry[]>();
  for (const change of changes) {
    const targetKey = targetKeyOf(change.unit, change.suggestedBaseName);
    entriesByTarget.set(targetKey, [...(entriesByTarget.get(targetKey) ?? []), change]);
  }
  for (const [targetKey, entriesWithSameTarget] of entriesByTarget) {
    if (entriesWithSameTarget.length > 1 || unchangedTargetKeys.has(targetKey)) {
      for (const entry of entriesWithSameTarget) entry.hasDuplicateTarget = true;
    }
  }

  return { changes, unchangedCount };
}

export function renderRenamePlan(plan: RenamePlan): string {
  const rows = plan.changes.map((change) => {
    const extension = lowercaseExtension(change.unit.primaryFilePath);
    const notes: string[] = [];
    if (change.needsConfirmation) {
      notes.push(style.yellow(`? ${formatPercent(change.identification.confidence)} ${change.identification.method}`));
    }
    if (change.hasDuplicateTarget) notes.push(style.yellow("name already taken: you will be asked"));
    if (change.unit.kind === "cue-sheet") notes.push(style.dim(`+${change.unit.cueReferences.length} track file(s)`));
    return [
      `${change.currentBaseName}${extension}`,
      style.dim("→"),
      style.cyan(`${change.suggestedBaseName}${extension}`),
      notes.join("  "),
    ];
  });
  return renderTable(rows);
}
