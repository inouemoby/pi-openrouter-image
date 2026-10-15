# pi-openrouter-image

A Pi extension that standardizes OpenRouter image generation and editing through the dedicated `POST /api/v1/images` API.

## Features

- `openrouter_image_generate` tool for the LLM.
- Interactive `/openrouter-image` command with searchable model and parameter selectors.
- `meta/muse-image` is the default and recommended model for both the tool and command.
- Automatic model and endpoint capability checks before each request.
- Correct OpenRouter reference-image shape:

```json
"input_references": [
  { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
]
```

- Parameters: `n`, `aspect_ratio`, `resolution`, `size`, `quality`, `output_format`, `response_format`, `background`, `output_compression`, `seed`, `moderation`, `reasoning_strength`, `stream`, `partial_images`, `user`, provider routing, provider options, and tool enablement.
- Local references are detected by file signature, not filename extension.
- Returned files are saved using the actual response signature/media type. Request results, usage, and warnings are returned through the tool result.
- Dynamic model and endpoint capability checks use `providerOnly` and `providerIgnore` to select eligible providers, and warn when parameters or image input are not advertised.
- An explicit `providerOnly` request requires a matching discovered endpoint before a paid generation request is sent. Discovery failures and empty endpoint lists are reported, not treated as availability.
- `dryRun: true` returns request metadata with inline image data omitted. Real requests still send the complete references.
- Pi 1.3 structured tool results expose `model`, `saved`, `warnings`, and optional usage metadata to codemode callers without JSON text parsing. Dry-run capability metadata is in `modelCapabilities`; `model` is always the requested model ID.
- Output writes use Pi's file mutation queue and exclusive creation unless `overwrite: true`; cancellation also applies to image downloads.

## Interactive command

Run `/openrouter-image` to start an interactive wizard. It first shows a fuzzy-searchable model list, with `meta/muse-image` highlighted first as the recommended default. After the prompt editor, parameter names and legal values are loaded from the selected model's `/images/models` and endpoint capability metadata; each parameter uses the same searchable selector style. Local reference images and existing output paths are also selectable, with a custom path/URL option when enumeration is not possible.

The LLM tool accepts the equivalent structured request directly:

```json
{
  "model": "meta/muse-image",
  "prompt": "Edit only the clothing of the adult character...",
  "references": ["J:/path/to/reference.png"],
  "aspectRatio": "16:9",
  "size": "1920x1080",
  "outputFormat": "png",
  "moderation": "auto",
  "output": "J:/path/to/output.png",
  "overwrite": true
}
```

For Muse, use `references` for image-guided generation. Muse may still reinterpret identity and style; inspect the output. The plugin warns when eligible endpoints do not publish detailed image-parameter capabilities. This extension uses OpenRouter, not the Runware direct API: `providerOnly: ["runware"]` is usable only if OpenRouter advertises a matching endpoint. `extraParams` cannot replace model, prompt, references, provider restrictions, or other dedicated request fields. The plugin does not bypass provider safety filters. `moderation: "none"` is explicit and always produces a warning; it is subject to Meta/OpenRouter access and policy.

## Authentication

Uses Pi's request-time `modelRegistry.getApiKeyForProvider("openrouter")` resolution, falling back to Pi's stored `openrouter` credential and then `OPENROUTER_API_KEY` when no runtime key is available. The same credential authenticates model discovery, endpoint discovery, and generation. Keys and authorization headers are not included in tool results.

## Development

Development dependencies target Pi 1.3. Host-provided runtime dependencies remain peers. Run `npm run check` for type checking and `npm test` for offline compatibility tests. To test against a specific installed Pi, set `PI_TEST_HOST_ENTRY` to its `dist/index.js` path. The tests use simulated API responses, do not generate paid images, and remove their temporary fixtures.

See [scripts](scripts/README.md) for validation and read-only inspection entries.

## Install

```text
pi install git:github.com/inouemoby/pi-openrouter-image
```
