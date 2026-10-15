import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const hostEntry = process.env.PI_TEST_HOST_ENTRY
  || require.resolve("@earendil-works/pi-coding-agent");
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", pathToFileURL(hostEntry)));
const loaded = await loadExtensions([path.join(root, "index.ts")], root);
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];
const tool = extension.tools.get("openrouter_image_generate").definition;
const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_API_KEY = "test-key-no-network";
const tempRoot = path.join(os.homedir(), "Temp");
await fs.mkdir(tempRoot, { recursive: true });
const temp = await fs.mkdtemp(path.join(tempRoot, "pi-openrouter-image-test-"));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBeYAAAAASUVORK5CYII=", "base64");
const reference = path.join(temp, "reference.png");
await fs.writeFile(reference, png);
const base = {
  model: "meta/muse-image",
  prompt: "Compatibility fixture",
  output: path.join(temp, "output.png"),
  providerOnly: ["runware"],
  allowFallbacks: false,
};
const runware = {
  provider_tag: "runware",
  supported_parameters: { aspect_ratio: { type: "enum", values: ["9:16"] } },
};
const context = {
  ui: { notify() {} },
  modelRegistry: { async getApiKeyForProvider() { return "runtime-test-key"; } },
};
const call = (input, signal) => tool.execute("compatibility-test", { ...base, ...input }, signal, undefined, context);

function mockApi({ endpoints = [runware], endpointError, image, onPost, download } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, init });
    if (url.endsWith("/images/models")) {
      return Response.json({ data: [{ id: base.model, architecture: { input_modalities: ["text", "image"] } }] });
    }
    if (url.endsWith("/endpoints")) {
      if (endpointError) return Response.json({ error: { message: endpointError } }, { status: 503 });
      return Response.json({ endpoints });
    }
    if (url.endsWith("/images") && init.method === "POST") {
      onPost?.(JSON.parse(init.body));
      return Response.json({ data: [image || { b64_json: png.toString("base64"), media_type: "image/png" }] });
    }
    if (url === "https://fixture.invalid/image") return download(init);
    throw new Error(`Unexpected network request: ${url}`);
  };
  return calls;
}

after(async () => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
  await fs.rm(temp, { recursive: true, force: true });
});

test("current host loads tool, output schema and interactive command", () => {
  assert.ok(tool.outputSchema);
  assert.ok(extension.commands.has("openrouter-image"));
});

test("dry run returns structured metadata without reference payloads or POST", async () => {
  const calls = mockApi();
  const result = await call({ dryRun: true, references: [reference], aspectRatio: "9:16" });
  const data = result.structuredContent;
  assert.equal(data.model, base.model);
  assert.equal(data.modelCapabilities.id, base.model);
  assert.deepEqual(data.request.provider, { only: ["runware"], allow_fallbacks: false });
  assert.match(data.request.input_references[0].image_url.url, /omitted/);
  assert.ok(!JSON.stringify(result).includes(png.toString("base64")));
  assert.deepEqual(JSON.parse(result.content[0].text), data);
  assert.equal(calls.filter(({ init }) => init.method === "POST").length, 0);
});

test("Pi runtime credentials authenticate discovery and generation", async () => {
  const calls = mockApi();
  await call({ output: path.join(temp, "authenticated.png") });
  for (const { init } of calls) {
    assert.equal(init.headers.Authorization, "Bearer runtime-test-key");
  }
});

test("capability checks use requested provider rather than first endpoint", async () => {
  mockApi({ endpoints: [{ provider_tag: "other", supported_parameters: { background: {} } }, runware] });
  const { structuredContent: data } = await call({ dryRun: true, aspectRatio: "9:16", background: "transparent" });
  assert.ok(!data.warnings.some((warning) => warning.startsWith("aspect_ratio is not declared")));
  assert.ok(data.warnings.some((warning) => warning.startsWith("background is not declared")));
});

test("empty and mismatched endpoint lists block paid generation", async () => {
  for (const endpoints of [[], [{ provider_tag: "other" }]]) {
    const calls = mockApi({ endpoints });
    await assert.rejects(call({}), /No discovered endpoint/);
    assert.equal(calls.filter(({ init }) => init.method === "POST").length, 0);
  }
});

test("endpoint discovery failure remains visible in dry run", async () => {
  mockApi({ endpointError: "fixture unavailable" });
  const { structuredContent: data } = await call({ dryRun: true });
  assert.match(data.discoveryError, /fixture unavailable/);
  assert.ok(data.warnings.some((warning) => warning.includes("Endpoint discovery failed")));
});

test("extraParams cannot replace provider restrictions", async () => {
  const calls = mockApi();
  await assert.rejects(call({ extraParams: { provider: { only: ["other"] } } }), /dedicated tool field/);
  assert.equal(calls.filter(({ init }) => init.method === "POST").length, 0);
});

test("actual request retains reference bytes and saves format-safe output", async () => {
  let sent;
  mockApi({ onPost: (body) => { sent = body; } });
  const { structuredContent: data } = await call({ references: [reference], output: path.join(temp, "generated.jpg") });
  assert.equal(sent.input_references[0].image_url.url, `data:image/png;base64,${png.toString("base64")}`);
  assert.deepEqual(sent.provider, { only: ["runware"], allow_fallbacks: false });
  assert.deepEqual(data.saved, [path.join(temp, "generated.png")]);
  assert.deepEqual(await fs.readFile(data.saved[0]), png);
});

test("download cancellation propagates and does not create output", async () => {
  const controller = new AbortController();
  const output = path.join(temp, "cancelled.png");
  mockApi({
    image: { url: "https://fixture.invalid/image" },
    download: ({ signal }) => {
      controller.abort();
      signal.throwIfAborted();
    },
  });
  await assert.rejects(call({ output }, controller.signal), /abort/i);
  await assert.rejects(fs.access(output), { code: "ENOENT" });
});

test("concurrent writes preserve no-overwrite behavior", async () => {
  mockApi();
  const output = path.join(temp, "shared.png");
  const results = await Promise.allSettled([call({ output }), call({ output })]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.deepEqual(await fs.readFile(output), png);
});
