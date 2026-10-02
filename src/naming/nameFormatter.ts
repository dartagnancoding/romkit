/**
 * Builds the final file name (without extension) from a title + tags using the
 * system's naming template.
 *
 * Template tokens:
 *   {title}   the game title, e.g. "Mega Man Zero 4"
 *   {tags}    only the tags matched by keepTags, e.g. "(Rev 1) [T-Por]"
 *   {region}  region tags, e.g. "USA, Europe" (independent of keepTags)
 *   {system}  the system id, e.g. "GBA"
 */

import type { NamingSettings } from "../config/configTypes";
import { sanitizeFileName } from "./filenameSanitizer";
import { isRegionTag, renderTag, type RomTag } from "./tagParser";

export interface NameParts {
  title: string;
  tags: RomTag[];
}

/**
 * keepTags entries are case-insensitive wildcard patterns matched against the
 * text inside the brackets: "Rev *" keeps "(Rev 1)", "T-Por*" keeps "[T-Por by Someone]".
 * Surrounding brackets in the pattern are optional: "(Beta)" and "Beta" are equivalent.
 */
export function tagMatchesPattern(tag: RomTag, pattern: string): boolean {
  const bareTagPattern = pattern.trim().replace(/^[([]/, "").replace(/[)\]]$/, "");
  const regexSource = bareTagPattern
    .split("*")
    .map((literalPart) => literalPart.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${regexSource}$`, "i").test(tag.text);
}

export function selectKeptTags(tags: RomTag[], keepPatterns: string[]): RomTag[] {
  return tags.filter((tag) => keepPatterns.some((pattern) => tagMatchesPattern(tag, pattern)));
}

export function formatRomBaseName(parts: NameParts, naming: NamingSettings, systemId: string): string {
  const keptTagsText = selectKeptTags(parts.tags, naming.keepTags).map(renderTag).join(" ");
  const regionText = parts.tags
    .filter(isRegionTag)
    .map((tag) => tag.text)
    .join(", ");

  let formattedName = naming.template
    .replaceAll("{title}", parts.title)
    .replaceAll("{tags}", keptTagsText)
    .replaceAll("{region}", regionText)
    .replaceAll("{system}", systemId);

  // A token with no value can leave empty brackets behind, e.g. "{title} ({region})"
  // for a file without region → "Title ()". Remove them.
  formattedName = formattedName.replace(/\(\s*\)|\[\s*\]/g, "");

  return sanitizeFileName(formattedName);
}
