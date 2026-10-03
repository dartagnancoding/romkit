import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTransferredBytes } from "../src/download/aria2c";
import { downloadFile, type DownloadRequest } from "../src/download/downloader";
import { RomkitError } from "../src/errors";
import { HttpClient } from "../src/sources/httpClient";

const FILE = new Uint8Array(300_000).map((_, index) => (index * 7) % 251);
const CRLF = "\r\n";

/** Bytes to send before dropping the next connection; null sends the whole file. */
let cutAfterBytes: number | null = null;
const rangeHeaders: (string | null)[] = [];

let server: Bun.TCPSocketListener<undefined>;
let workDirectory: string;

/**
 * A raw HTTP server, so a dropped connection is real: the headers promise the
 * full Content-Length and the socket closes early.
 */
beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), "romkit-download-test-"));
  server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        const requestText = Buffer.from(data).toString("latin1");
        const path = requestText.split(" ")[1] ?? "/";
        if (path === "/page.zip") {
          const html = "<html><body>Click here to continue</body></html>";
          const head = ["HTTP/1.1 200 OK", "Content-Type: text/html", `Content-Length: ${html.length}`, "Connection: close", "", ""];
          socket.end(head.join(CRLF) + html);
          return;
        }

        const range = /range: *bytes=(\d+)-/i.exec(requestText);
        rangeHeaders.push(range ? `bytes=${range[1]}-` : null);
        const start = range ? Number(range[1]) : 0;
        const body = FILE.slice(start);
        const head = [
          range ? "HTTP/1.1 206 Partial Content" : "HTTP/1.1 200 OK",
          "Content-Type: application/octet-stream",
          `Content-Length: ${body.length}`,
          'ETag: "v1"',
          ...(range ? [`Content-Range: bytes ${start}-${FILE.length - 1}/${FILE.length}`] : []),
          "Connection: close",
          "",
          "",
        ];
        const limit = cutAfterBytes;
        cutAfterBytes = null;
        socket.write(head.join(CRLF));
        if (limit === null) {
          socket.end(body);
        } else {
          // Closes before the promised Content-Length; the pause lets the bytes arrive first, as on a real dropped line.
          socket.write(body.slice(0, limit));
          setTimeout(() => socket.end(), 100);
        }
      },
    },
  });
});

afterAll(async () => {
  server.stop(true);
  await rm(workDirectory, { recursive: true, force: true });
});

function requestFor(path: string, name: string): DownloadRequest {
  return {
    url: `http://127.0.0.1:${server.port}${path}`,
    pageUrl: `http://127.0.0.1:${server.port}/`,
    destinationDirectory: workDirectory,
    fallbackFileName: name,
    partialRoot: join(workDirectory, "partial"),
  };
}

const httpClient = () => new HttpClient({ userAgent: "romkit-test", timeoutMs: 5_000, delayBetweenRequestsMs: 0 });

describe("built-in downloader", () => {
  test("a dropped connection is continued with a Range request and the file comes out intact", async () => {
    rangeHeaders.length = 0;
    cutAfterBytes = 100_000;
    const outcome = await downloadFile(requestFor("/game-a.bin", "x"), httpClient());
    if (outcome.kind !== "downloaded") throw new Error(outcome.detail);
    expect(rangeHeaders[0]).toBeNull();
    expect(rangeHeaders[1]).toMatch(/^bytes=\d+-$/);
    expect(new Uint8Array(await readFile(outcome.filePath))).toEqual(FILE);
  });

  test("a download interrupted in one run continues in the next run", async () => {
    const request = requestFor("/game-b.bin", "x");
    // Every attempt of the first run is dropped after 50 KB.
    const failingClient = httpClient();
    const originalOpen = failingClient.openDownload.bind(failingClient);
    failingClient.openDownload = (...args) => {
      cutAfterBytes = 50_000;
      return originalOpen(...args);
    };
    const firstRun = downloadFile(request, failingClient);
    await expect(firstRun).rejects.toBeInstanceOf(RomkitError);
    await expect(firstRun).rejects.toHaveProperty("hint", expect.stringContaining("run the same command again"));

    rangeHeaders.length = 0;
    const outcome = await downloadFile(request, httpClient());
    if (outcome.kind !== "downloaded") throw new Error(outcome.detail);
    // The probe, then one request for the missing part only (3 attempts × 50 KB were kept).
    expect(rangeHeaders).toEqual([null, "bytes=150000-"]);
    expect(new Uint8Array(await readFile(outcome.filePath))).toEqual(FILE);
  });

  test("a web page instead of a file is reported as blocked", async () => {
    const outcome = await downloadFile(requestFor("/page.zip", "x"), httpClient());
    expect(outcome.kind).toBe("blocked");
  });
});

describe("aria2c progress", () => {
  test("reads the transferred bytes from aria2c's summary line", () => {
    expect(parseTransferredBytes("[#91b596 22MiB/93MiB(23%) CN:4 DL:7.8MiB ETA:9s]")).toBe(22 * 1024 ** 2);
    expect(parseTransferredBytes("[#91b596 864KiB/93MiB(0%) CN:4 DL:1.0MiB ETA:1m28s]")).toBe(864 * 1024);
    expect(parseTransferredBytes("FILE: C:/x/crash2.chd")).toBeNull();
  });
});
