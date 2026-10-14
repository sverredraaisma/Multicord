import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { contentTypeFor, uploadSource } from "../../../src/main/files";
import { FluxerRest, type UploadSource } from "../../../src/main/fluxer/rest";

describe("upload sources", () => {
  it("guesses content types from the extension", () => {
    expect(contentTypeFor("cat.PNG")).toBe("image/png");
    expect(contentTypeFor("notes.txt")).toBe("text/plain");
    expect(contentTypeFor("archive.tar.xz")).toBe("application/octet-stream");
    expect(contentTypeFor("README")).toBe("application/octet-stream");
  });

  it("reads exact byte ranges from disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multicord-upload-"));
    const file = path.join(dir, "data.bin");
    fs.writeFileSync(file, Buffer.from("0123456789"));
    try {
      const source = await uploadSource(file);
      expect(source).toMatchObject({ filename: "data.bin", size: 10, contentType: "application/octet-stream" });
      expect(Buffer.from(await source.read(2, 5)).toString()).toBe("234");
      expect(Buffer.from(await source.read(8, 20)).toString()).toBe("89");
      expect((await source.read(5, 5)).length).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function memorySource(filename: string, text: string): UploadSource {
  const bytes = Buffer.from(text);
  return {
    filename,
    size: bytes.length,
    contentType: "text/plain",
    read: async (start, end) => bytes.subarray(start, end),
  };
}

type Reply = { status: number; body?: unknown };

function client(route: (url: string, init: RequestInit) => Reply) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const reply = route(url, init);
    return { ok: reply.status < 300, status: reply.status, json: async () => reply.body } as Response;
  });
  const rest = new FluxerRest("https://api.fx/v1", { fetch: fetch as unknown as typeof globalThis.fetch, sleep: async () => {} });
  rest.token = "flx_secret";
  return { rest, calls };
}

describe("FluxerRest.upload", () => {
  it("uploads small files in one PUT and large ones in parts, then completes multipart", async () => {
    const plan = {
      attachments: [
        { id: 0, filename: "a.txt", upload_filename: "up/a", content_type: "text/plain; charset=utf-8", upload_mode: "singlepart", upload_url: "https://store/a?sig=1" },
        {
          id: 1,
          filename: "b.txt",
          upload_filename: "up/b",
          content_type: "text/plain",
          upload_mode: "multipart",
          upload_id: "mp1",
          part_size: 4,
          parts: [
            { part_number: 1, upload_url: "https://store/b/1" },
            { part_number: 2, upload_url: "https://store/b/2" },
            { part_number: 3, upload_url: "https://store/b/3" },
          ],
        },
      ],
    };
    const { rest, calls } = client((url) =>
      url.endsWith("/attachments") ? { status: 200, body: plan } : url.endsWith("/attachments/complete") ? { status: 200, body: { uploads: [] } } : { status: 200 },
    );
    const claimed = await rest.upload("5", [memorySource("a.txt", "hello"), memorySource("b.txt", "0123456789")]);

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      attachments: [
        { id: 0, filename: "a.txt", file_size: 5, content_type: "text/plain" },
        { id: 1, filename: "b.txt", file_size: 10, content_type: "text/plain" },
      ],
    });
    const puts = calls.filter((c) => c.init.method === "PUT");
    expect(puts.map((c) => [c.url, Buffer.from(c.init.body as Uint8Array).toString()])).toEqual([
      ["https://store/a?sig=1", "hello"],
      ["https://store/b/1", "0123"],
      ["https://store/b/2", "4567"],
      ["https://store/b/3", "89"],
    ]);
    // Presigned URLs carry their own authorisation: our token must not leak to storage.
    expect(puts.every((c) => !("Authorization" in (c.init.headers as Record<string, string>)))).toBe(true);
    expect((puts[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("text/plain; charset=utf-8");
    const complete = calls.find((c) => c.url.endsWith("/attachments/complete"))!;
    expect(JSON.parse(String(complete.init.body))).toEqual({ uploads: [{ upload_filename: "up/b", upload_id: "mp1" }] });
    expect(claimed).toEqual([
      { id: 0, filename: "a.txt", upload_filename: "up/a", file_size: 5, content_type: "text/plain; charset=utf-8" },
      { id: 1, filename: "b.txt", upload_filename: "up/b", file_size: 10, content_type: "text/plain" },
    ]);
  });

  it("skips the complete step when everything was single-part", async () => {
    const plan = { attachments: [{ upload_filename: "up/a", upload_url: "https://store/a" }] };
    const { rest, calls } = client((url) => (url.endsWith("/attachments") ? { status: 200, body: plan } : { status: 200 }));
    const [claimed] = await rest.upload("5", [memorySource("a.txt", "hi")]);
    expect(claimed!.content_type).toBe("text/plain"); // server did not override it
    expect(calls.some((c) => c.url.endsWith("/complete"))).toBe(false);
  });

  it("rejects plans it cannot follow and failed PUTs", async () => {
    const plans: unknown[] = [
      {},
      { attachments: [] },
      { attachments: [{ upload_url: "https://store/a" }] },
      { attachments: [{ upload_filename: "u" }] },
      { attachments: [{ upload_filename: "u", upload_id: "m", part_size: 4, parts: [{ part_number: 0, upload_url: "x" }] }] },
      { attachments: [{ upload_filename: "u", upload_id: "m", part_size: 4, parts: ["junk"] }] },
      { attachments: ["junk"] },
    ];
    for (const plan of plans) {
      const { rest } = client(() => ({ status: 200, body: plan }));
      await expect(rest.upload("5", [memorySource("a.txt", "hi")])).rejects.toThrow("Unexpected upload plan");
    }
    const { rest } = client((url) =>
      url.endsWith("/attachments") ? { status: 200, body: { attachments: [{ upload_filename: "u", upload_url: "https://store/a" }] } } : { status: 401 },
    );
    await expect(rest.upload("5", [memorySource("a.txt", "hi")])).rejects.toThrow("Upload failed (HTTP 401)");
  });

  it("claims uploads when sending", async () => {
    const { rest, calls } = client(() => ({ status: 200, body: { id: "9", channel_id: "5", author: { id: "1", username: "me" } } }));
    const attachment = { id: 0, filename: "a.txt", upload_filename: "up/a", file_size: 2, content_type: "text/plain" };
    await rest.sendMessage("5", "", "n", undefined, [attachment]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ content: "", nonce: "n", attachments: [attachment] });
  });
});
