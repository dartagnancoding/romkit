/**
 * Registry of custom source adapters.
 *
 * To add one: create a file in this folder exporting a SourceAdapterFactory,
 * add it below under the name you will use in the config ("adapter": "<name>").
 */

import type { SourceAdapterFactory } from "../sourceAdapter";
import { createExampleJsonApiSource } from "./exampleJsonApiSource";

export const customAdapterFactories: Record<string, SourceAdapterFactory> = {
  "example-json-api": createExampleJsonApiSource,
};
