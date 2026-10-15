import { readStoredCredential, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ImageAuthContext = Pick<ExtensionContext, "modelRegistry">;

export async function resolveImageApiKey(
  provider: "openrouter" | "runware",
  ctx?: ImageAuthContext,
): Promise<string> {
  const runtimeKey = await ctx?.modelRegistry.getApiKeyForProvider(provider);
  if (runtimeKey?.trim()) return runtimeKey.trim();

  const credential = readStoredCredential(provider);
  if (credential?.type === "api_key" && credential.key?.trim()) return credential.key.trim();
  if (credential?.type === "oauth" && credential.access?.trim()) return credential.access.trim();
  return process.env[`${provider.toUpperCase()}_API_KEY`]?.trim() ?? "";
}
