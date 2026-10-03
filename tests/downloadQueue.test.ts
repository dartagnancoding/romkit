import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NeedsDecisionError, UnattendedPrompter } from "../src/cli/unattendedPrompter";
import { DownloadQueue } from "../src/queue/downloadQueue";
import type { SearchResult } from "../src/sources/sourceAdapter";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "romkit-queue-test-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const result = (title: string): SearchResult => ({ sourceName: "Test", title, pageUrl: `https://example.invalid/${encodeURIComponent(title)}`, regionTags: [] });

describe("download queue", () => {
  test("adds, keeps one item per game page and system, updates and removes", async () => {
    const queue = new DownloadQueue(join(directory, "a.json"));
    const first = await queue.add({ systemId: "PS1", query: "crash 2", result: result("Crash 2"), status: "pending" });
    const again = await queue.add({ systemId: "PS1", query: "crash", result: result("Crash 2"), status: "pending" });
    expect(again.alreadyQueued).toBe(true);
    expect(again.item.id).toBe(first.item.id);

    await queue.patch(first.item.id, { status: "unfinished", downloadUrl: "https://example.invalid/file.chd" });
    expect((await queue.list())[0]).toMatchObject({ status: "unfinished", downloadUrl: "https://example.invalid/file.chd" });

    await queue.remove([first.item.id]);
    expect(await queue.list()).toEqual([]);
  });

  test("changes made at the same time are all kept", async () => {
    const queue = new DownloadQueue(join(directory, "b.json"));
    await Promise.all(Array.from({ length: 10 }, (_, index) => queue.add({ systemId: "NES", query: `game ${index}`, result: result(`Game ${index}`), status: "pending" })));
    expect((await queue.list()).length).toBe(10);
  });

  test("a missing or broken file is an empty queue", async () => {
    expect(await new DownloadQueue(join(directory, "missing.json")).list()).toEqual([]);
  });
});

describe("unattended prompter", () => {
  test("turns every question into a NeedsDecisionError carrying the question", async () => {
    const prompter = new UnattendedPrompter();
    await expect(prompter.chooseFromList("The archive contains 16 valid ROMs. Which one do you want to keep?", ["a", "b"])).rejects.toBeInstanceOf(NeedsDecisionError);
    await expect(prompter.confirm("Use this name?", true)).rejects.toHaveProperty("question", "Use this name?");
  });
});
