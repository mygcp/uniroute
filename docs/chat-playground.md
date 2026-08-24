# Chat Playground

Page **Providers → [name] → Chat Playground**: multi-turn streaming chat
direct to a provider, bypassing the whole gateway pipeline (routing, pools,
logging).

## Features

- **Smooth streaming** — SSE deltas are batched per frame (rAF) with a timer
  fallback when the tab is hidden; server-side SSE keep-alive keeps the
  connection from feeling dead during long time-to-first-token.
- **Live tok/s meter** (chars/4 estimate) and the real value after completion
  when the provider reports usage.
- **Multi-turn** — full history is sent to the model; Stop aborts the stream;
  Enter sends, Shift+Enter inserts a newline.
- **Markdown + syntax highlighting** in answers (fenced code, inline code,
  bold/italic/link/list/quote); input is escaped first.

## Saving and loading conversations

Stored in the same SQLite database (`chat_sessions` + `chat_messages`):

- **Auto-save** (toggle, persisted via localStorage): after each turn the
  active session is updated — no duplicates.
- **+ New** starts a fresh conversation; previous sessions stay saved.
- **Saved chats** sidebar: click to reload, trash icon to delete permanently
  (with confirmation). Titles are taken from the first user message.

## Notes

- Conversations are saved only when you hit send (unsent drafts are not kept).
- Latency is shown per assistant answer (`2.1s`).
