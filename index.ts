import { StringEnum } from "@earendil-works/pi-ai";
import {
  readStoredCredential,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  type SelectItem,
  type TUI,
  Input,
  SelectList,
  fuzzyFilter,
  getKeybindings,
  truncateToWidth,
} from "@earendil-works/pi-tui";
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

type ImageParameterSpec = {
  type?: string;
  values?: unknown[];
  min?: number;
  max?: number;
};

type SupportedParameters = Record<string, ImageParameterSpec>;

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
  supported_parameters?: SupportedParameters;
  supports_streaming?: boolean;
};

type Endpoint = {
  provider_name?: string;
  provider_slug?: string;
  provider_tag?: string;
  supported_parameters?: SupportedParameters;
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

async function fetchImageModels(signal?: AbortSignal): Promise<ImageModel[]> {
  const body = await jsonFetch<ImageModelsResponse>(
    IMAGE_MODELS_URL,
    { headers: { Accept: "application/json" } },
    signal,
  );
  return (body.data ?? [])
    .filter((model) => Boolean(model.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function discoverModel(model: string, signal?: AbortSignal): Promise<{ model?: ImageModel; endpoints: Endpoint[] }> {
  const models = await fetchImageModels(signal);
  const found = models.find((item) => item.id === model);
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
  return { model: request.model, saved, warnings, usage: response.usage, outputFormat: response.output_format };
}

function normalizeInput(input: ImageToolInput): ImageRequest {
  return {
    ...input,
    model: input.model ?? DEFAULT_MODEL,
    output: input.output,
  } as ImageRequest;
}

const OMIT_VALUE = "__openrouter_image_omit__";
const CUSTOM_VALUE = "__openrouter_image_custom__";
const DONE_VALUE = "__openrouter_image_done__";
const CUSTOM_REFERENCE_VALUE = "__openrouter_image_reference__";

const IMAGE_PARAMETER_FIELDS: Record<string, string> = {
  aspect_ratio: "aspectRatio",
  resolution: "resolution",
  size: "size",
  quality: "quality",
  output_format: "outputFormat",
  response_format: "responseFormat",
  background: "background",
  output_compression: "outputCompression",
  seed: "seed",
  n: "n",
  moderation: "moderation",
  reasoning_strength: "reasoningStrength",
  stream: "stream",
  partial_images: "partialImages",
};

const KNOWN_PASSTHROUGH_SPECS: Record<string, ImageParameterSpec> = {
  moderation: { type: "enum", values: ["auto", "low", "none"] },
  response_format: { type: "enum", values: ["url", "b64_json"] },
};

const PARAMETER_ORDER = [
  "aspect_ratio",
  "resolution",
  "size",
  "quality",
  "background",
  "output_format",
  "output_compression",
  "n",
  "input_references",
  "seed",
  "moderation",
  "response_format",
  "stream",
  "partial_images",
  "reasoning_strength",
];

function parameterLabel(name: string): string {
  const labels: Record<string, string> = {
    aspect_ratio: "Aspect ratio",
    output_compression: "Output compression",
    output_format: "Output format",
    input_references: "Reference images",
    response_format: "Response format",
    reasoning_strength: "Reasoning strength",
  };
  return labels[name] ?? name.replaceAll("_", " ");
}

function parameterDescription(name: string, spec: ImageParameterSpec): string {
  if (spec.type === "enum" && Array.isArray(spec.values)) {
    return `Legal values: ${spec.values.map(String).join(", ")}`;
  }
  if (spec.type === "range" && typeof spec.min === "number" && typeof spec.max === "number") {
    return `Legal range: ${spec.min}–${spec.max}`;
  }
  if (name === "seed") return "The provider supports a caller-supplied integer seed.";
  if (name === "input_references") return "Image input is supported, but the provider did not publish a reference-count range.";
  return "Provider-specific parameter; enter a value if needed.";
}

class FilterSelectComponent implements Component, Focusable {
  private readonly searchInput = new Input();
  private readonly allItems: SelectItem[];
  private filteredItems: SelectItem[];
  private list: SelectList;
  private focusedState = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly title: string,
    items: SelectItem[],
    private readonly done: (value: string | null) => void,
  ) {
    this.allItems = items;
    this.filteredItems = items;
    this.list = this.createList(items);
  }

  get focused(): boolean {
    return this.focusedState;
  }

  set focused(value: boolean) {
    this.focusedState = value;
    this.searchInput.focused = value;
  }

  private createList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, Math.min(Math.max(items.length, 1), 10), {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("warning", text),
    });
    list.onSelect = (item) => this.done(item.value);
    list.onCancel = () => this.done(null);
    return list;
  }

  private refilter(): void {
    const query = this.searchInput.getValue().trim();
    this.filteredItems = query
      ? fuzzyFilter(this.allItems, query, (item) => `${item.value} ${item.label} ${item.description ?? ""}`)
      : this.allItems;
    this.list = this.createList(this.filteredItems);
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (
      keybindings.matches(data, "tui.select.up")
      || keybindings.matches(data, "tui.select.down")
      || keybindings.matches(data, "tui.select.confirm")
    ) {
      this.list.handleInput(data);
    } else if (keybindings.matches(data, "tui.select.cancel")) {
      this.done(null);
    } else {
      this.searchInput.handleInput(data);
      this.refilter();
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const count = `${this.filteredItems.length}/${this.allItems.length} matching`;
    return [
      truncateToWidth(this.theme.fg("accent", this.theme.bold(this.title)), width),
      ...this.searchInput.render(width),
      "",
      ...this.list.render(width),
      this.theme.fg("dim", truncateToWidth(`${count} • type to filter • ↑↓ select • Enter confirm • Esc cancel`, width)),
    ];
  }

  invalidate(): void {
    this.searchInput.invalidate();
    this.list.invalidate();
  }
}

async function selectFromFilteredList(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
): Promise<string | null> {
  if (ctx.mode !== "tui") {
    throw new Error("/openrouter-image requires Pi's interactive TUI mode.");
  }
  const result = await ctx.ui.custom<string | null>(
    (tui, theme, _keybindings, done) => new FilterSelectComponent(tui, theme, title, items, done),
  );
  return result ?? null;
}

async function askRequiredInput(
  ctx: ExtensionCommandContext,
  title: string,
  placeholder: string,
): Promise<string | undefined> {
  while (true) {
    const answer = await ctx.ui.input(title, placeholder);
    if (answer === undefined) return undefined;
    const trimmed = answer.trim();
    if (trimmed) return trimmed;
    ctx.ui.notify(`${title} cannot be empty.`, "warning");
  }
}

async function askRequiredEditor(
  ctx: ExtensionCommandContext,
  title: string,
): Promise<string | undefined> {
  while (true) {
    const answer = await ctx.ui.editor(title, "");
    if (answer === undefined) return undefined;
    const trimmed = answer.trim();
    if (trimmed) return trimmed;
    ctx.ui.notify(`${title} cannot be empty.`, "warning");
  }
}

function parseInteger(value: string, label: string, min?: number, max?: number): number {
  const parsed = Number(value.trim());
  if (
    !Number.isSafeInteger(parsed)
    || (min !== undefined && parsed < min)
    || (max !== undefined && parsed > max)
  ) {
    const range = min !== undefined && max !== undefined
      ? ` between ${min} and ${max}`
      : min !== undefined
        ? ` greater than or equal to ${min}`
        : max !== undefined
          ? ` less than or equal to ${max}`
          : "";
    throw new Error(`${label} must be a whole number${range}.`);
  }
  return parsed;
}

function modelSelectItems(models: ImageModel[]): SelectItem[] {
  return [...models]
    .sort((a, b) => {
      if (a.id === DEFAULT_MODEL) return -1;
      if (b.id === DEFAULT_MODEL) return 1;
      return a.id.localeCompare(b.id);
    })
    .map((model) => {
      const input = model.architecture?.input_modalities?.join(", ") || "?";
      const output = model.architecture?.output_modalities?.join(", ") || "?";
      const isRecommended = model.id === DEFAULT_MODEL;
      return {
        value: model.id,
        label: isRecommended ? `★ ${model.id} (recommended)` : model.id,
        description: `${model.name ?? model.id} • ${input} → ${output}${isRecommended ? " • default" : ""}`,
      };
    });
}

function getParameterSpecs(discovery: { model?: ImageModel; endpoints: Endpoint[] }): Map<string, ImageParameterSpec> {
  const endpoint = discovery.endpoints[0];
  const endpointSpecs = endpoint?.supported_parameters;
  const modelSpecs = discovery.model?.supported_parameters;
  const source = endpointSpecs && Object.keys(endpointSpecs).length > 0 ? endpointSpecs : modelSpecs ?? {};
  const specs = new Map(Object.entries(source));

  for (const name of endpoint?.allowed_passthrough_parameters ?? []) {
    if (!specs.has(name)) specs.set(name, KNOWN_PASSTHROUGH_SPECS[name] ?? { type: "custom" });
  }
  if (!specs.has("input_references") && discovery.model?.architecture?.input_modalities?.includes("image")) {
    specs.set("input_references", { type: "custom" });
  }
  if (endpoint?.supports_streaming && !specs.has("stream")) {
    specs.set("stream", { type: "enum", values: [true] });
  }
  return specs;
}

function sortedParameterNames(specs: Map<string, ImageParameterSpec>): string[] {
  return [...specs.keys()].sort((a, b) => {
    const aOrder = PARAMETER_ORDER.indexOf(a);
    const bOrder = PARAMETER_ORDER.indexOf(b);
    if (aOrder !== -1 && bOrder !== -1) return aOrder - bOrder;
    if (aOrder !== -1) return -1;
    if (bOrder !== -1) return 1;
    return a.localeCompare(b);
  });
}

function parameterSelectItems(specs: Map<string, ImageParameterSpec>): SelectItem[] {
  const items = sortedParameterNames(specs).map((name) => ({
    value: name,
    label: parameterLabel(name),
    description: `${name} • ${parameterDescription(name, specs.get(name)!)}`,
  }));
  items.push({
    value: DONE_VALUE,
    label: "Done — generate image",
    description: "Finish parameter selection and continue to the output path.",
  });
  return items;
}

function parameterValueItems(name: string, spec: ImageParameterSpec): SelectItem[] {
  const items: SelectItem[] = [{
    value: OMIT_VALUE,
    label: "Use provider default",
    description: "Do not send this parameter.",
  }];

  if (spec.type === "enum" && Array.isArray(spec.values)) {
    items.push(...spec.values.map((value) => ({
      value: String(value),
      label: String(value),
    })));
    return items;
  }

  if (
    spec.type === "range"
    && Number.isSafeInteger(spec.min)
    && Number.isSafeInteger(spec.max)
    && spec.min !== undefined
    && spec.max !== undefined
    && spec.max >= spec.min
    && spec.max - spec.min <= 1000
  ) {
    for (let value = spec.min; value <= spec.max; value++) {
      items.push({ value: String(value), label: String(value) });
    }
    return items;
  }

  if (spec.type === "boolean" && name !== "seed") {
    items.push({ value: "true", label: "true" }, { value: "false", label: "false" });
    return items;
  }

  items.push({
    value: CUSTOM_VALUE,
    label: "Enter a custom value…",
    description: name === "seed"
      ? "The provider accepts an integer seed."
      : "This provider parameter has no finite value list.",
  });
  return items;
}

type ValueChoice =
  | { cancelled: true }
  | { cancelled: false; omitted: true }
  | { cancelled: false; omitted: false; value: unknown };

function decodeSelectedValue(name: string, spec: ImageParameterSpec, value: string): unknown {
  const original = spec.values?.find((candidate) => String(candidate) === value);
  if (original !== undefined) return original;
  if (spec.type === "range") return parseInteger(value, parameterLabel(name), spec.min, spec.max);
  if (spec.type === "boolean") return value === "true";
  return value;
}

function decodeCustomValue(name: string, value: string): unknown {
  if (name === "seed") return parseInteger(value, "Seed");
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function chooseParameterValue(
  ctx: ExtensionCommandContext,
  name: string,
  spec: ImageParameterSpec,
): Promise<ValueChoice> {
  const selected = await selectFromFilteredList(ctx, `${parameterLabel(name)} — select a value`, parameterValueItems(name, spec));
  if (selected === null) return { cancelled: true };
  if (selected === OMIT_VALUE) return { cancelled: false, omitted: true };
  if (selected === CUSTOM_VALUE) {
    const raw = await askRequiredInput(ctx, `${parameterLabel(name)} value`, "Enter a value");
    if (raw === undefined) return { cancelled: true };
    return { cancelled: false, omitted: false, value: decodeCustomValue(name, raw) };
  }
  return { cancelled: false, omitted: false, value: decodeSelectedValue(name, spec, selected) };
}

function setRequestParameter(request: ImageToolInput, name: string, value: unknown): void {
  if (name === "input_references") return;
  const field = IMAGE_PARAMETER_FIELDS[name];
  if (field) {
    (request as unknown as Record<string, unknown>)[field] = value;
    return;
  }
  request.extraParams = { ...(request.extraParams ?? {}), [name]: value };
}

function clearRequestParameter(request: ImageToolInput, name: string): void {
  if (name === "input_references") {
    request.references = undefined;
    return;
  }
  const field = IMAGE_PARAMETER_FIELDS[name];
  if (field) {
    delete (request as unknown as Record<string, unknown>)[field];
    return;
  }
  if (request.extraParams) {
    const extraParams = { ...request.extraParams };
    delete extraParams[name];
    request.extraParams = extraParams;
  }
}

function listLocalReferenceFiles(root: string, maxFiles = 200): string[] {
  const result: string[] = [];
  const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"]);
  const ignoredDirectories = new Set([".git", ".pi", "node_modules", "dist", "build"]);

  const visit = (directory: string, depth: number) => {
    if (depth > 4 || result.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.length >= maxFiles) return;
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) visit(path.join(directory, entry.name), depth + 1);
      } else if (entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase())) {
        result.push(path.join(directory, entry.name));
      }
    }
  };

  visit(root, 0);
  return result;
}

async function chooseReferences(ctx: ExtensionCommandContext, count: number): Promise<string[] | null> {
  if (count === 0) return [];
  const selected: string[] = [];
  const available = listLocalReferenceFiles(ctx.cwd);

  for (let index = 0; index < count; index++) {
    const items: SelectItem[] = available
      .filter((file) => !selected.includes(file))
      .map((file) => ({
        value: file,
        label: path.relative(ctx.cwd, file) || file,
        description: "Local reference image",
      }));
    items.push({
      value: CUSTOM_REFERENCE_VALUE,
      label: "Enter a local path or URL…",
      description: "Use this for a file outside the workspace or an HTTP(S) URL.",
    });

    const choice = await selectFromFilteredList(ctx, `Reference image ${index + 1}/${count}`, items);
    if (choice === null) return null;
    if (choice === CUSTOM_REFERENCE_VALUE) {
      const reference = await askRequiredInput(ctx, "Reference image path or URL", "C:/path/to/image.png or https://...");
      if (reference === undefined) return null;
      selected.push(reference);
    } else {
      selected.push(choice);
    }
  }
  return selected;
}

async function chooseOutputPath(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const items: SelectItem[] = listLocalReferenceFiles(ctx.cwd).map((file) => ({
    value: file,
    label: path.relative(ctx.cwd, file) || file,
    description: "Use this existing path and choose whether to overwrite it.",
  }));
  items.push({
    value: CUSTOM_REFERENCE_VALUE,
    label: "Enter a new output path…",
    description: "Create a new image file at a custom path.",
  });

  const choice = await selectFromFilteredList(ctx, "Select output path", items);
  if (choice === null) return undefined;
  if (choice === CUSTOM_REFERENCE_VALUE) {
    return askRequiredInput(ctx, "Output file path", "C:/path/to/output.png");
  }
  return choice;
}

async function configureImageParameters(
  ctx: ExtensionCommandContext,
  request: ImageToolInput,
  discovery: { model?: ImageModel; endpoints: Endpoint[] },
): Promise<boolean> {
  const specs = getParameterSpecs(discovery);
  while (true) {
    const selected = await selectFromFilteredList(ctx, "Select an image parameter", parameterSelectItems(specs));
    if (selected === null) return false;
    if (selected === DONE_VALUE) return true;

    const spec = specs.get(selected);
    if (!spec) continue;
    const choice = await chooseParameterValue(ctx, selected, spec);
    if (choice.cancelled) return false;
    if (choice.omitted) {
      clearRequestParameter(request, selected);
      continue;
    }

    if (selected === "input_references") {
      const count = parseInteger(String(choice.value), "Reference image count", 0);
      const references = await chooseReferences(ctx, count);
      if (references === null) return false;
      request.references = references.length ? references : undefined;
    } else {
      setRequestParameter(request, selected, choice.value);
    }
  }
}

async function promptForImageRequest(ctx: ExtensionCommandContext): Promise<ImageRequest | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("/openrouter-image requires Pi's interactive TUI mode.", "error");
    return undefined;
  }

  const models = await fetchImageModels(ctx.signal);
  if (models.length === 0) throw new Error("OpenRouter returned no image models.");
  const model = await selectFromFilteredList(ctx, "Select an OpenRouter image model", modelSelectItems(models));
  if (model === null) return undefined;

  const prompt = await askRequiredEditor(ctx, "Image prompt");
  if (prompt === undefined) return undefined;

  const discovery = await discoverModel(model, ctx.signal);
  const request: ImageToolInput = { model, prompt, output: "" };
  if (!await configureImageParameters(ctx, request, discovery)) return undefined;

  const output = await chooseOutputPath(ctx);
  if (output === undefined) return undefined;
  request.output = output;

  const overwrite = await selectFromFilteredList(ctx, "Overwrite existing output files?", [
    {
      value: "false",
      label: "Do not overwrite",
      description: "Fail if the generated output path already exists.",
    },
    {
      value: "true",
      label: "Overwrite existing files",
      description: "Replace an existing generated output file.",
    },
  ]);
  if (overwrite === null) return undefined;
  request.overwrite = overwrite === "true";

  return normalizeInput(request);
}

export default function piOpenRouterImage(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "openrouter_image_generate",
    label: "OpenRouter Image",
    description: "Generate or edit images through OpenRouter's standardized /api/v1/images API. The default and recommended model is meta/muse-image. Supports local/URL reference images, input_references, Muse options, moderation, provider routing, output format validation, and capability warnings with request metadata in the tool result.",
    promptSnippet: "Generate or edit an image with OpenRouter; default/recommended model: meta/muse-image",
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
    description: "Interactively generate or edit an OpenRouter image",
    handler: async (_args, ctx) => {
      try {
        const request = await promptForImageRequest(ctx);
        if (!request) {
          ctx.ui.notify("OpenRouter image cancelled.", "info");
          return;
        }
        const result = await generate(request, ctx.signal);
        if (Array.isArray(result.warnings) && result.warnings.length) {
          ctx.ui.notify(result.warnings.join("\n"), "warning");
        }
        ctx.ui.notify(JSON.stringify(result, null, 2), "info");
      } catch (error: any) {
        ctx.ui.notify(`OpenRouter image: ${error?.message || String(error)}`, "error");
      }
    },
  });
}
