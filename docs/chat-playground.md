# Chat Playground

Page **Providers → [name] → Chat Playground**: multi-turn streaming chat.
Requests go through the normal `/v1/chat/completions` pipeline, so routing,
proxy pools, compression, logging, and client-key rules all apply.

## Features

- **Smooth streaming** — SSE deltas are batched per frame (rAF) with a timer
  fallback when the tab is hidden; server-side SSE keep-alive keeps the
  connection from feeling dead during long time-to-first-token.
- **Thought process** — reasoning models stream their thinking into a
  collapsible block (open while thinking, labelled "Thought process" once
  content starts); it is saved per message and re-rendered on reload.
- **Always-visible tok/s meter** — shown during and after each answer; uses
  official `usage.completion_tokens` when the provider reports it, otherwise
  a chars/4 estimate marked `(est.)`.
- **Copy buttons** — full-response copy on every assistant message plus a
  Copy button on each fenced code block (flips to "Copied" briefly).
- **Elapsed time + 24h finish clock** — each answer shows duration (`2.1s`)
  and the finished-at time (`14:03:22`).
- **Layout** — assistant messages are full-width; user messages are a
  right-aligned bubble.
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
