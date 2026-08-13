# API for Cursor

Local OpenAI-compatible `chat.completions` and `responses` endpoints backed by Cursor models (Composer 2.5, Grok 4.6, and more).

This is a Linux CLI. It starts a localhost `/v1` server, reads your Cursor API key from the environment or a config file, and runs the Cursor SDK on the same machine.

## Install

```bash
npm install
npm run build
```

Node 22.6 or newer is required.

## Configure

A Cursor user API key comes from the Cursor Dashboard under Integrations.

```bash
export CURSOR_API_KEY="your-cursor-key"
# or
node dist/cli.js set-key your-cursor-key
```

`set-key` writes `~/.config/api-for-cursor/config.json`.

## Start the local API

```bash
node dist/cli.js serve
```

The default base URL is:

```txt
http://127.0.0.1:8787/v1
```

Point any OpenAI-compatible client at that URL. The client bearer token can be any placeholder such as `local`; the server uses the stored Cursor key.

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "local",
  baseURL: "http://127.0.0.1:8787/v1"
});

const completion = await client.chat.completions.create({
  model: "composer-2.5",
  messages: [{ role: "user", content: "Write a TypeScript debounce." }]
});
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer local" \
  -H "Content-Type: application/json" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"Hello"}]}'
```

## Commands

```bash
cursor-api serve [--host 127.0.0.1] [--port 8787] [--key KEY]
cursor-api set-key <cursor-api-key>
cursor-api setup [opencode|codex|vscode|cline|kilo|pi|all]
cursor-api models
```

`setup` writes local provider config for coding agents so they point at `http://127.0.0.1:8787/v1`.

## Supported endpoints

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`
- `POST /v1/completions`
- `POST /v1/responses/input_tokens`
- `POST /v1/responses/compact`

## Models

- `composer-2.5`
- `composer-2.5-fast`
- `grok-4.6`
- `grok-4.6-fast`
- `grok-4.5`
- `grok-4.5-fast`

## Compatibility notes

This project supports text and image input, non-streaming and streaming output, JSON-output prompt constraints, and the common SDK response shapes. Image inputs can be sent as Chat Completions `image_url` parts or Responses `input_image` parts; each resolved image must be 1MB or smaller.

These OpenAI features are rejected because Cursor does not expose equivalent controls through this path:

- `n` greater than `1`
- `logprobs` and `top_logprobs`
- audio output
- OpenAI function/tool calls on the Responses API
- background Responses API jobs

Token usage is estimated from character counts because Cursor's stream does not return OpenAI token accounting on this path. For Composer 2.5 and the listed Grok models, `usage.cost` is estimated from Cursor's published per-million-token pricing.

## Development

```bash
npm install
npm run test
npm run typecheck
npm run build
```
