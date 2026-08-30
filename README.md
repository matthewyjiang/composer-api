# API for Cursor

Run Cursor models (Composer 2.5, Grok 4.6, and more) through a local OpenAI-compatible API.

It starts a small server on your machine at `http://127.0.0.1:8787/v1`. Any tool that speaks the OpenAI API can point at that URL and use your Cursor subscription.

## Quick start

You need [Bun](https://bun.sh) (or Node 22.6+, see below) and a Cursor API key from the Cursor Dashboard under Integrations.

```bash
# 1. Get the code and its dependencies
git clone https://github.com/standardagents/composer-api.git
cd composer-api
bun install

# 2. Install the `cursor-api` command globally
bun run build
bun link && bun link api-for-cursor

# 3. Save your Cursor API key (stored in ~/.config/api-for-cursor/config.json)
cursor-api set-key your-cursor-key

# 4. Start the server
cursor-api serve
```

That's it. The API is now running at `http://127.0.0.1:8787/v1`.

## Use it

Point any OpenAI-compatible client at the local URL. The API key on the client side can be anything (like `local`) — the server uses your stored Cursor key.

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer local" \
  -H "Content-Type: application/json" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"Hello"}]}'
```

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

To set up a coding agent (opencode, codex, vscode, cline, kilo, pi, or rho) to use the local server automatically:

```bash
cursor-api setup          # configure all of them
cursor-api setup opencode # or just one
```

## Commands

```bash
cursor-api serve [--host 127.0.0.1] [--port 8787] [--key KEY]
cursor-api set-key <cursor-api-key>
cursor-api setup [opencode|codex|vscode|cline|kilo|pi|rho|all]
cursor-api models
```

Instead of `set-key`, you can also set the key in your environment:

```bash
export CURSOR_API_KEY="your-cursor-key"
```

## Using Node instead of Bun

With Node 22.6 or newer:

```bash
npm install
npm run build
npm link
```

`npm link` installs the same global `cursor-api` command, so everything above works unchanged.

## Models

- `composer-2.5`
- `composer-2.5-fast`
- `grok-4.6`
- `grok-4.6-fast`
- `grok-4.5`
- `grok-4.5-fast`

## Supported endpoints

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`
- `POST /v1/completions`
- `POST /v1/responses/input_tokens`
- `POST /v1/responses/compact`

## Compatibility notes

This project supports text and image input, non-streaming and streaming output, JSON-output prompt constraints, tool calls, and the common SDK response shapes. Image inputs can be sent as Chat Completions `image_url` parts or Responses `input_image` parts.

These OpenAI features are rejected because Cursor does not expose equivalent controls through this path:

- `n` greater than `1`
- `logprobs` and `top_logprobs`
- audio output
- background Responses API jobs

Token usage is estimated from character counts because Cursor's stream does not return OpenAI token accounting on this path. For all listed models, `usage.cost` is estimated from Cursor's published per-million-token pricing.

## Development

```bash
bun install
bun run test
bun run typecheck
```
