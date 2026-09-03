import { StringEnum } from "@earendil-works/pi-ai";
import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

const API_BASE = "https://openrouter.ai/api/v1";
const IMAGES_URL = `${API_BASE}/images`;
const IMAGE_MODELS_URL = `${API_BASE}/images/models`;
const DEFAULT_MODEL = "meta/muse-image";
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
};

type Moderation = "auto" | "low" | "none";
type ReasoningStrength = "low" | "high";

type ImageRequest = {
  model: string;
  prompt: string;
  references?: string[];
  n?: number;
  aspectRatio?: string;
  resolution?: string;
  size?: string;
  quality?: string;
  outputFormat?: string;
  responseFormat?: string;
  background?: string;
  outputCompression?: number;
  seed?: number;
  moderation?: Moderation;
  reasoningStrength?: ReasoningStrength;
  stream?: boolean;
  partialImages?: number;
  user?: string;
  providerOnly?: string[];
  providerOrder?: string[];
  providerIgnore?: string[];
  providerSort?: string;
  allowFallbacks?: boolean;
  providerOptions?: Record<string, unknown>;
  toolEnablement?: Record<string, boolean>;
  extraParams?: Record<string, unknown>;
  output: string;
  overwrite?: boolean;
  dryRun?: boolean;
};

type ImageModel = {
  id: string;
  name?: string;
  description?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  supported_parameters?: Record<string, unknown>;
  supports_streaming?: boolean;
};

type Endpoint = {
  provider_name?: string;
  provider_slug?: string;
  provider_tag?: string;
  supported_parameters?: Record<string, unknown>;
  allowed_passthrough_parameters?: string[];
  supports_streaming?: boolean;
};

type ImageModelsResponse = { data?: ImageModel[] };
type EndpointsResponse = { id?: string; endpoints?: Endpoint[] };
type ImageResult = {
  b64_json?: string;
  url?: string;
  media_type?: string;
};
type ImageResponse = {
  created?: number;
  data?: ImageResult[];
  usage?: Record<string, unknown>;
  output_format?: string;
  background?: string;
};

type ImageToolInput = Static<typeof imageToolSchema>;

const imageToolSchema = Type.Object({
  model: Type.Optional(Type.String({ description: `OpenRouter image model ID. Default: ${DEFAULT_MODEL}` })),
  prompt: Type.String({ description: "The image generation or editing instruction." }),
  references: Type.Optional(Type.Array(Type.String({ description: "Local image path, HTTP(S) URL, or data URL." }))),
  output: Type.String({ description: "Output file path. Actual extension is corrected from the returned media type." }),
  n: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  aspectRatio: Type.Optional(Type.String({ description: "For example 16:9, 2:3, or auto." })),
  resolution: Type.Optional(Type.String({ description: "Model-supported tier such as 512, 1K, 2K, or 4K." })),
  size: Type.Optional(Type.String({ description: "Convenience size such as 1024x1536 or 2K." })),
  quality: Type.Optional(Type.String({ description: "Model-supported quality, commonly auto/low/medium/high." })),
  outputFormat: Type.Optional(Type.String({ description: "png, jpeg, webp, or svg when supported." })),
  responseFormat: Type.Optional(Type.String({ description: "url or b64_json when supported." })),
  background: Type.Optional(Type.String({ description: "auto, transparent, or opaque when supported." })),
  outputCompression: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  seed: Type.Optional(Type.Integer()),
  moderation: Type.Optional(StringEnum(["auto", "low", "none"] as const)),
  reasoningStrength: Type.Optional(StringEnum(["low", "high"] as const)),
  stream: Type.Optional(Type.Boolean()),
  partialImages: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
  user: Type.Optional(Type.String()),
  providerOnly: Type.Optional(Type.Array(Type.String())),
  providerOrder: Type.Optional(Type.Array(Type.String())),
  providerIgnore: Type.Optional(Type.Array(Type.String())),
  providerSort: Type.Optional(Type.String()),
  allowFallbacks: Type.Optional(Type.Boolean()),
  providerOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  toolEnablement: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
  extraParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  overwrite: Type.Optional(Type.Boolean()),
  dryRun: Type.Optional(Type.Boolean()),
});

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR
    || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".pi", "agent");
}

function readApiKey(): string {
  if (process.env.OPENROUTER_API_KEY?.trim()) return process.env.OPENROUTER_API_KEY.trim();
  try {
    const credential = readStoredCredential("openrouter");
    if (credential?.type === "api_key" && credential.key) return credential.key;
    if (credential?.type === "oauth" && credential.access) return credential.access;
  } catch {
    // Use auth.json fallback below.
  }
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "auth.json"), "utf8"));
    const credential = auth.openrouter;
    if (credential?.type === "api_key" && typeof credential.key === "string") return credential.key;
    if (credential?.type === "oauth" && typeof credential.access === "string") return credential.access;
  } catch {
    // No credential configured.
  }
  return "";
}

function absoluteOutput(output: string): string {
  return path.resolve(output);
}

function detectImageType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.slice(0, 6));
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  return undefined;
}

function mediaTypeForFile(file: string, bytes: Uint8Array): string {
  const detected = detectImageType(bytes);
  if (!detected) throw new Error(`Unsupported or unrecognized reference image format: ${file}`);
  return detected;
}

async function referenceToDataUrl(reference: string): Promise<string> {
  if (/^data:image\//i.test(reference)) return reference;
  if (/^https?:\/\//i.test(reference)) return reference;
  const file = path.resolve(reference);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`Reference is not a file: ${reference}`);
  if (stat.size > MAX_REFERENCE_BYTES) throw new Error(`Reference is larger than 20 MB: ${reference}`);
  const bytes = fs.readFileSync(file);
  const mediaType = mediaTypeForFile(file, bytes);
  return `data:${mediaType};base64,${bytes.toString("base64")}`;
}

function timeoutSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

async function jsonFetch<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { ...init, signal: timeoutSignal(signal) });
  const text = await response.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = undefined; }
  if (!response.ok) {
    const detail = body?.error?.message || body?.message || text || `HTTP ${response.status}`;
    throw new Error(`OpenRouter HTTP ${response.status}: ${detail}`);
  }
  return body as T;
}

async function discoverModel(model: string, signal?: AbortSignal): Promise<{ model?: ImageModel; endpoints: Endpoint[] }> {
  const models = await jsonFetch<ImageModelsResponse>(IMAGE_MODELS_URL, { headers: { Accept: "application/json" } }, signal);
  const found = models.data?.find((item) => item.id === model);
  let endpoints: Endpoint[] = [];
  const endpointUrl = `${IMAGE_MODELS_URL}/${model.split("/").map(encodeURIComponent).join("/")}/endpoints`;
  try {
    const detail = await jsonFetch<EndpointsResponse>(endpointUrl, { headers: { Accept: "application/json" } }, signal);
    endpoints = detail.endpoints ?? [];
  } catch {
    // Model list is still useful if endpoint discovery is unavailable.
  }
  return { model: found, endpoints };
}

function buildBody(request: ImageRequest, references: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
    ...(references.length ? {
      input_references: references.map((url) => ({
        type: "image_url",
        image_url: { url },
      })),
    } : {}),
  };
  const add = (key: string, value: unknown) => {
    if (value !== undefined) body[key] = value;
  };
  add("n", request.n);
  add("aspect_ratio", request.aspectRatio);
  add("resolution", request.resolution);
  add("size", request.size);
  add("quality", request.quality);
  add("output_format", request.outputFormat);
  add("response_format", request.responseFormat);
  add("background", request.background);
  add("output_compression", request.outputCompression);
  add("seed", request.seed);
  add("moderation", request.moderation);
  add("reasoning_strength", request.reasoningStrength);
  add("stream", request.stream);
  add("partial_images", request.partialImages);
  add("user", request.user);
  if (request.providerOnly?.length || request.providerOrder?.length || request.providerIgnore?.length
    || request.providerSort || request.allowFallbacks !== undefined || request.providerOptions) {
    body.provider = {
      ...(request.providerOnly?.length ? { only: request.providerOnly } : {}),
      ...(request.providerOrder?.length ? { order: request.providerOrder } : {}),
      ...(request.providerIgnore?.length ? { ignore: request.providerIgnore } : {}),
      ...(request.providerSort ? { sort: request.providerSort } : {}),
      ...(request.allowFallbacks !== undefined ? { allow_fallbacks: request.allowFallbacks } : {}),
      ...(request.providerOptions ? { options: request.providerOptions } : {}),
    };
  }
  if (request.toolEnablement) body.tool_enablement = request.toolEnablement;
  if (request.extraParams) Object.assign(body, request.extraParams);
  return body;
}

function capabilityWarnings(request: ImageRequest, model: ImageModel | undefined, endpoints: Endpoint[]): string[] {
  const warnings: string[] = [];
  if (!model) warnings.push(`Model ${request.model} was not found in /images/models.`);
  if (request.references?.length && !model?.architecture?.input_modalities?.includes("image")) {
    warnings.push("This model does not advertise image input; references may be ignored.");
  }
  const endpoint = endpoints[0];
  const declared = new Set(Object.keys(endpoint?.supported_parameters ?? model?.supported_parameters ?? {}));
  const standard = [
    ["aspectRatio", "aspect_ratio"], ["resolution", "resolution"], ["size", "size"],
    ["quality", "quality"], ["outputFormat", "output_format"], ["background", "background"],
    ["outputCompression", "output_compression"], ["seed", "seed"], ["n", "n"],
  ] as const;
  for (const [field, apiName] of standard) {
    if ((request as any)[field] !== undefined && declared.size && !declared.has(apiName)) {
      warnings.push(`${apiName} is not declared by the selected endpoint; it may be ignored.`);
    }
  }
  if (request.references?.length && request.model === "meta/muse-image") {
    warnings.push("Muse reference editing is advertised by the model, but the current Meta endpoint exposes no detailed image-parameter schema; verify identity preservation in the output.");
  }
  const requestedConfig = [
    request.aspectRatio, request.resolution, request.size, request.quality,
    request.outputFormat, request.responseFormat, request.background,
    request.outputCompression, request.seed, request.n,
  ].some((value) => value !== undefined);
  if (requestedConfig && endpoints.length && declared.size === 0) {
    warnings.push("The selected image endpoint publishes no detailed parameter schema; configuration fields are sent but may be ignored by the upstream provider.");
  }
  if (request.moderation === "none") {
    warnings.push("moderation:none requested explicitly; provider safety systems and OpenRouter policy still apply.");
  }
  if (request.reasoningStrength !== undefined && request.model === "meta/muse-image") {
    warnings.push("reasoning_strength is a Meta/Muse-native option and may be passed through only when the endpoint permits it.");
  }
  return warnings;
}

function extensionForMedia(mediaType: string | undefined, bytes: Uint8Array, requested: string): string {
  const detected = detectImageType(bytes);
  const effective = detected || mediaType;
  return IMAGE_EXTENSIONS[effective || ""] || path.extname(requested) || ".png";
}

function outputPathFor(output: string, index: number, total: number, extension: string): string {
  const abs = absoluteOutput(output);
  const ext = path.extname(abs);
  const stem = ext ? abs.slice(0, -ext.length) : abs;
  return total === 1 ? `${stem}${extension}` : `${stem}-${index + 1}${extension}`;
}

async function decodeResult(result: ImageResult): Promise<{ bytes: Uint8Array; mediaType?: string }> {
  if (result.b64_json) return { bytes: Buffer.from(result.b64_json, "base64"), mediaType: result.media_type };
  if (result.url) {
    const response = await fetch(result.url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Generated image download failed: HTTP ${response.status}`);
    return { bytes: new Uint8Array(await response.arrayBuffer()), mediaType: result.media_type || response.headers.get("content-type") || undefined };
  }
  throw new Error("OpenRouter returned an image object without b64_json or url.");
}

async function requestImageResponse(body: Record<string, unknown>, key: string, signal?: AbortSignal): Promise<ImageResponse> {
  const response = await fetch(IMAGES_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: timeoutSignal(signal),
  });
  const text = await response.text();
  if (!response.ok) {
    let errorBody: any;
    try { errorBody = JSON.parse(text); } catch { errorBody = undefined; }
    const detail = errorBody?.error?.message || errorBody?.message || text || `HTTP ${response.status}`;
    throw new Error(`OpenRouter HTTP ${response.status}: ${detail}`);
  }
  if (!body.stream) {
    try { return JSON.parse(text) as ImageResponse; }
    catch { throw new Error("OpenRouter returned invalid JSON for the image response."); }
  }

  // Image streaming is SSE. Keep only the completed image event(s); partial
  // preview events are intentionally not written as final files.
  const completed: ImageResult[] = [];
  let usage: Record<string, unknown> | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let event: any;
    try { event = JSON.parse(payload); } catch { continue; }
    if (event?.type === "image_generation.completed" || event?.type === "image_edit.completed") {
      if (event.b64_json) completed.push({ b64_json: event.b64_json, media_type: event.media_type });
      if (event.usage) usage = event.usage;
    }
  }
  return { data: completed, usage };
}

async function generate(request: ImageRequest, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
  const references = [];
  for (const reference of request.references ?? []) references.push(await referenceToDataUrl(reference));
  const discovery = await discoverModel(request.model, signal);
  const warnings = capabilityWarnings(request, discovery.model, discovery.endpoints);
  const body = buildBody(request, references);
  if (request.dryRun) return { dryRun: true, request: body, warnings, model: discovery.model, endpoints: discovery.endpoints };
  const key = readApiKey();
  if (!key) throw new Error("No OpenRouter API key found. Run /login openrouter or set OPENROUTER_API_KEY.");
  const response = await requestImageResponse(body, key, signal);
  const images = response.data ?? [];
  if (!images.length) throw new Error("OpenRouter returned no images.");
  const saved: string[] = [];
  const requested = request.outputFormat ? `.${request.outputFormat}` : request.output;
  for (let index = 0; index < images.length; index++) {
    const decoded = await decodeResult(images[index]);
    const mediaType = detectImageType(decoded.bytes) || decoded.mediaType;
    if (!mediaType) throw new Error(`Generated image ${index + 1} has an unrecognized file signature.`);
    const extension = extensionForMedia(mediaType, decoded.bytes, requested);
    const target = outputPathFor(request.output, index, images.length, extension);
    if (fs.existsSync(target) && !request.overwrite) throw new Error(`Output exists; set overwrite:true: ${target}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, decoded.bytes);
    saved.push(target);
  }
  const metadataPath = `${absoluteOutput(request.output)}.openrouter.json`;
  fs.writeFileSync(metadataPath, JSON.stringify({
    request: body,
    sourceReferences: request.references ?? [],
    warnings,
    response: { created: response.created, usage: response.usage, output_format: response.output_format, background: response.background },
    saved,
    generatedAt: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");
  return { model: request.model, saved, metadata: metadataPath, warnings, usage: response.usage, outputFormat: response.output_format };
}

function normalizeInput(input: ImageToolInput): ImageRequest {
  return {
    ...input,
    model: input.model ?? DEFAULT_MODEL,
    output: input.output,
  } as ImageRequest;
}

function parseCommandArgs(args: string): ImageRequest {
  const raw = args.trim();
  if (!raw) throw new Error("Usage: /openrouter-image <JSON request> or /openrouter-image @request.json");
  const text = raw.startsWith("@") ? fs.readFileSync(path.resolve(raw.slice(1)), "utf8") : raw;
  return normalizeInput(JSON.parse(text) as ImageToolInput);
}

export default function piOpenRouterImage(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "openrouter_image_generate",
    label: "OpenRouter Image",
    description: "Generate or edit images through OpenRouter's standardized /api/v1/images API. Supports local/URL reference images, input_references, Muse options, moderation, provider routing, output format validation, capability warnings, and a JSON sidecar.",
    promptSnippet: "Generate or edit an image with OpenRouter using explicit model parameters and optional reference images",
    parameters: imageToolSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await generate(normalizeInput(params), signal);
      if (Array.isArray(result.warnings) && result.warnings.length) {
        ctx.ui.notify(result.warnings.join("\n"), "warning");
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  pi.registerCommand("openrouter-image", {
    description: "Generate/edit an OpenRouter image from a JSON request; use @file.json for a request file",
    handler: async (args, ctx) => {
      try {
        const result = await generate(parseCommandArgs(String(args || "")), ctx.signal);
        if (Array.isArray(result.warnings) && result.warnings.length) {
          ctx.ui.notify(result.warnings.join("\n"), "warning");
        }
        ctx.ui.notify(JSON.stringify(result, null, 2), "info");
      } catch (error: any) {
        ctx.ui.notify(`OpenRouter image: ${error?.message || String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("openrouter-image-models", {
    description: "List OpenRouter image models and endpoint capabilities",
    handler: async (_args, ctx) => {
      try {
        const body = await jsonFetch<ImageModelsResponse>(IMAGE_MODELS_URL, { headers: { Accept: "application/json" } }, ctx.signal);
        const rows = (body.data ?? []).map((model) => `${model.id} | input:${model.architecture?.input_modalities?.join(",") || "?"} | params:${Object.keys(model.supported_parameters ?? {}).join(",") || "none"}`);
        ctx.ui.notify(rows.length ? rows.join("\n") : "No OpenRouter image models returned.", "info");
      } catch (error: any) {
        ctx.ui.notify(`OpenRouter image models: ${error?.message || String(error)}`, "error");
      }
    },
  });
}
