# pi-openrouter-image

A Pi extension that standardizes OpenRouter image generation and editing through the dedicated `POST /api/v1/images` API.

## Features

- `openrouter_image_generate` tool for the LLM.
- `/openrouter-image <JSON>` command, or `/openrouter-image @request.json`.
- `/openrouter-image-models` capability discovery.
- Correct OpenRouter reference-image shape:

```json
"input_references": [
  { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
]
```

- Parameters: `n`, `aspect_ratio`, `resolution`, `size`, `quality`, `output_format`, `response_format`, `background`, `output_compression`, `seed`, `moderation`, `reasoning_strength`, `stream`, `partial_images`, `user`, provider routing, provider options, and tool enablement.
- Local references are detected by file signature, not filename extension.
- Returned files are saved using the actual response signature/media type. Request results, usage, and warnings are returned through the tool result.
- Dynamic model and endpoint capability checks warn when a parameter is not declared or a model does not advertise image input.

## Example

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

For Muse, use `references` rather than describing the character only in text. Muse may still reinterpret identity and style; the plugin records a warning when the current endpoint does not publish detailed image-parameter capabilities. The plugin does not bypass provider safety filters. `moderation: "none"` is explicit and always produces a warning; it is subject to Meta/OpenRouter access and policy.

## Authentication

Uses `OPENROUTER_API_KEY`, Pi's stored `openrouter` credential, or `~/.pi/agent/auth.json` as a fallback.

## Install

```text
pi install git:github.com/inouemoby/pi-openrouter-image
```
