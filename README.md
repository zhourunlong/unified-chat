# Unified Chat

A local-first chat UI for switching between model providers per conversation. GPT support is implemented first through the OpenAI Responses API, with background mode enabled so long reasoning runs can be polled and cancelled reliably.

## Run

```bash
npm start
```

Then open `http://localhost:3000`.

## Current behavior

- Provider and model selection happens at the chat level. Once the first turn is sent, the chat config locks to preserve a single model lane for that conversation.
- GPT chats call `POST /v1/responses` with `background: true`, `store: true`, and `previous_response_id` for multi-turn conversation state.
- API keys can be provided either in the UI or through environment variables like `OPENAI_API_KEY`.
- Claude, Gemini, and Grok are exposed as placeholders in the provider registry so their API modules can be added without replacing the frontend state model.

## Notes

- Keys entered in the UI are stored in browser local storage. They are only posted to the local Node proxy when a request is made.
- The local proxy does not persist user keys or transcripts on disk.
