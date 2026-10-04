// A2 图像工具 handler 单测（specs/image-tools.md）
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  IMAGE_EDIT_TOOL_NAME,
  IMAGE_GEN_TOOL_NAME,
  ImageEditInputSchema,
  ImageGenInputSchema,
  ImageToolOutputSchema,
} from "@zcode/contracts";
import { imageEditToolEntry } from "../../src/tool/handlers/image-edit.js";
import { imageGenToolEntry } from "../../src/tool/handlers/image-gen.js";
import type { ToolExecutionContext } from "../../src/tool/types.js";

type PortResult = { dataBase64: string; mimeType: string; width?: number; height?: number };

function fakePort(result: PortResult) {
  return {
    generateImage: async () => result,
    editImage: async () => result,
  };
}

function fakeStore(dir: string) {
  let n = 0;
  return {
    writeToolResultBinaryArtifact: async (req: {
      content: Uint8Array;
      extension?: string;
    }) => {
      n += 1;
      const p = join(dir, `img-${n}.${req.extension ?? "bin"}`);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(p, req.content);
      return { id: `a${n}`, uri: p, path: p, bytes: req.content.length, contentType: "image/png", createdAt: new Date() };
    },
  };
}

function makeContext(port: unknown, store: unknown, extra: Record<string, unknown> = {}) {
  return { toolCallId: "call-1", sessionId: "s-1", traceId: "t-1", imageGenerationPort: port, artifactStore: store, ...extra } as unknown as Parameters<typeof imageGenToolEntry.handler>[1];
}

const DIR = mkdtempSync(join(tmpdir(), "zcode-image-tools-"));

test("契约：image_gen 非法入参被 zod 拒绝", () => {
  assert.throws(() => ImageGenInputSchema.parse({ prompt: "" }));
  assert.throws(() => ImageGenInputSchema.parse({}));
});

test("契约：image_edit 必填 file/prompt", () => {
  assert.throws(() => ImageEditInputSchema.parse({ prompt: "x" }));
  const ok = ImageEditInputSchema.parse({ file: "/ws/a.png", prompt: "把背景换深色" });
  assert.equal(ok.file, "/ws/a.png");
});

test("image_gen：fake 端口生成 → 落盘 artifacts → 输出路径与尺寸", async () => {
  const png1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const store = fakeStore(DIR);
  const context = makeContext(
    fakePort({ dataBase64: png1x1.toString("base64"), mimeType: "image/png", width: 1, height: 1 }),
    store,
  );
  const output = (await imageGenToolEntry.handler!(
    { prompt: "一只戴帽子的猫", size: "1024x1024" },
    context,
  )) as { file: string; width?: number; height?: number };
  assert.equal(output.width, 1);
  assert.equal(output.height, 1);
  assert.ok(statSync(output.file).size > 0);
  assert.ok(output.file.endsWith(".png"));
});

test("image_gen：端口缺席 → ConfigurationError（fail-closed 守卫）", async () => {
  const context = makeContext(undefined, fakeStore(DIR));
  await assert.rejects(
    () => imageGenToolEntry.handler!({ prompt: "x" }, context),
    /ImageGenerationPort is not configured/u,
  );
});

test("image_edit：编辑结果写为新文件，输出含路径", async () => {
  const png1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const port = {
    generateImage: async () => {
      throw new Error("not used");
    },
    editImage: async () => ({
      dataBase64: png1x1.toString("base64"),
      mimeType: "image/png",
      width: 1,
      height: 1,
    }),
  };
  const context = makeContext(port, fakeStore(DIR), {
    fileSystemPort: {
      readBinaryFile: async () => ({ content: png1x1, sizeBytes: png1x1.length, path: "/ws/src.png" }),
    },
  });
  const output = (await imageEditToolEntry.handler!(
    { file: "/ws/src.png", prompt: "把背景换深色" },
    context,
  )) as { file: string };
  assert.ok(output.file.endsWith(".png"));
});