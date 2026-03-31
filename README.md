# Unified Chat

Unified Chat is a local-first multi-provider chat app. Each conversation is pinned to one provider and model, while the local Node server handles encrypted vault storage, session management, and provider-specific API translation.

## What It Does

- Creates chat sessions against OpenAI, Anthropic, Google, and xAI models.
- Stores chat history and provider API keys inside a per-user encrypted local vault.
- Streams responses into the browser and preserves provider-specific conversation state when supported.
- Supports resumable background-style runs for Responses API providers.

## Architecture

The repo is split into three main areas:

- `public/`: browser UI, chat state, streaming consumer, and rendering.
- `server/`: local HTTP server, auth/session handling, encrypted vault persistence, and provider adapters.
- `shared/`: model catalog and protocol helpers shared between browser and server.

### Provider Layer

Providers are implemented behind a common handler interface in `server/providers/`.

- OpenAI: Responses API with `background: true`, `store: true`, and `previous_response_id`.
- xAI: Responses-style API with provider-specific system-message shaping.
- Anthropic: Messages API with streaming and thinking blocks.
- Google: Gemini streaming API with provider-managed conversation context.

Responses-based providers share a common transport in `server/providers/responses-api.js`. Provider-specific adapters remain responsible for request shaping and response peculiarities.

## Local Security Model

- Users register and log in locally; there is no third-party auth flow.
- Vault records are persisted in `data/vault-store.json`.
- Session state is persisted in `data/session-store.json`.
- Vault payloads are encrypted with a key derived from `username@password`.
- Username lookup and credential checks use one-way probes rather than plaintext identifiers.
- Session cookies are HTTP-only.

This is a local app, not a hardened hosted service. The trust boundary is your local machine and local browser session.

## Chat Behavior

- Provider/model selection happens at the chat level.
- Once the first user turn is sent, the chat config locks for that conversation.
- Title summarization is best-effort and runs separately from the main completion flow.
- Provider capabilities differ by model and transport:
  - Responses API providers can expose resumable operations.
  - Google and Anthropic stream directly without a retrievable background operation token.

## Running The App

Requirements:

- Node.js 20+

Start the server:

```bash
npm start
```

Then open:

```text
http://127.0.0.1:3000
```

## Repo Notes

- System prompts live under `server/prompts/`.
- The browser does not use local storage for vault persistence.
- The UI polls only when there are pending provider operations to retrieve.
- There is currently no automated test suite in the repo.
