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
- System prompts are not user-configurable. They are defined in the repository per provider/model under `server/prompts/`.
- Users must register and log in locally before using the app.
- The local Node server stores encrypted user vault records on disk in `data/vault-store.json` and keeps login state in an HTTP-only cookie-backed persistent session.
- No plaintext username, password, or API key is written to the vault store. User lookup uses one-way probes derived from the typed username and password, so credential matching does not require decrypting stored usernames or passwords.
- Each vault payload is encrypted once with a key derived from `username@password`. There is no reversible global vault-encryption layer.
- API keys can still fall back to environment variables like `OPENAI_API_KEY` if a provider key is not stored in the logged-in vault.
- Claude, Gemini, and Grok are exposed as placeholders in the provider registry so their API modules can be added without replacing the frontend state model.

## Notes

- The browser no longer stores user vaults in local storage.
- The local proxy does not persist decrypted user keys or transcripts in the browser. Decrypted vault material is retained in the server-side session until logout or session expiry.
