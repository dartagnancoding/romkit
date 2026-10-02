/**
 * Maps the "adapter" name of a source in the config to its implementation.
 * "selector" is the built-in generic scraper; custom adapters live in ./custom.
 */

import type { SourceConfig } from "../config/configTypes";
import { RomkitError } from "../errors";
import { customAdapterFactories } from "./custom";
import { SelectorSource } from "./selectorSource";
import type { SourceAdapter, SourceAdapterFactory, SourceContext } from "./sourceAdapter";

const adapterFactories: Record<string, SourceAdapterFactory> = {
  selector: (sourceConfig, context) => new SelectorSource(sourceConfig, context),
  ...customAdapterFactories,
};

export function knownAdapterNames(): string[] {
  return Object.keys(adapterFactories);
}

export function createSourceAdapter(sourceConfig: SourceConfig, context: SourceContext): SourceAdapter {
  const adapterName = sourceConfig.adapter ?? "selector";
  const factory = adapterFactories[adapterName];
  if (!factory) {
    throw new RomkitError(`Source "${sourceConfig.name}" uses unknown adapter "${adapterName}".`);
  }
  return factory(sourceConfig, context);
}
