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
- Users must register and log in locally before using the app.
- Each user's chats and API keys are stored inside that user's encrypted local vault. The vault key is sealed with the login password and only decrypted in memory after login.
- API keys can still fall back to environment variables like `OPENAI_API_KEY` if a provider key is not stored in the logged-in vault.
- Claude, Gemini, and Grok are exposed as placeholders in the provider registry so their API modules can be added without replacing the frontend state model.

## Notes

- Usernames are stored as local identifiers, but passwords are not stored in plaintext. The browser keeps encrypted credential material plus the encrypted vault in local storage.
- The local proxy does not persist decrypted user keys or transcripts on disk.
