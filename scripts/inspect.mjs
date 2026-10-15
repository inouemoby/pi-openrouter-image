import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const [model, provider, reference, output] = process.argv.slice(2);
if (!model || !provider || !reference || !output) {
  throw new Error("Usage: node scripts/inspect.mjs <model> <provider> <reference-path-or-url> <output-path>");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const entry = process.env.PI_TEST_HOST_ENTRY || require.resolve("@earendil-works/pi-coding-agent");
const host = await import(pathToFileURL(entry));
const runtime = await host.ModelRuntime.create({ refreshOnCreate: false });
const modelRegistry = new host.ModelRegistry(runtime);
const credentialStatus = ["openrouter", "runware"].map((provider) => {
  const credential = host.readStoredCredential(provider);
  return { provider, storedType: credential?.type, present: Boolean(credential) };
});
console.log(JSON.stringify({
  credentialStatus,
  storedProviders: (await runtime.listCredentials()).map(({ providerId, type }) => ({ providerId, type })),
}));
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", pathToFileURL(entry)));
const loaded = await loadExtensions([path.join(root, "index.ts")], process.cwd());
assert.deepEqual(loaded.errors, []);
const tool = loaded.extensions[0].tools.get("openrouter_image_generate").definition;
const result = await tool.execute("inspect", {
  model,
  prompt: "Read-only compatibility inspection; do not generate an image.",
  references: [reference],
  output,
  providerOnly: [provider],
  allowFallbacks: false,
  aspectRatio: "9:16",
  outputFormat: "png",
  background: "transparent",
  dryRun: true,
}, undefined, undefined, { modelRegistry, ui: { notify() {} } });
console.log(JSON.stringify(result.structuredContent, null, 2));
