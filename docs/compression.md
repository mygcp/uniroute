# Compression

The **Compression** page (`/compression`) shrinks prompts before they
reach the upstream provider and can make model output terser. It uses two
external tools that are **not bundled** with UniRoute:

| Tool | Source | Used for |
| --- | --- | --- |
| RTK (Rust Token Killer) | [rtk-ai/rtk](https://github.com/rtk-ai/rtk) | Compressing tool output (logs, test runs, diffs, grep, ...) |
| Caveman Engine | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) | Compressing JSON, code, text, HTML, tables, ... and the output voice |

## External binaries

Binaries are downloaded from the **External Binaries** card into
`~/.uniroute/bin/` (override with `UNIROUTE_TOOLS_DIR`).

- Downloads go straight to `github.com` Releases. The GitHub API and OAuth
  are not used, so there is no auth and no API rate limit, which suits a VPS.
- Every download is verified against the SHA-256 in the release `checksums.txt`.
- Binary lookup order: custom path saved in the UI, managed binary in
  `~/.uniroute/bin/`, then `PATH`.

## Global pipeline

When compression is **on**, it applies to every request that goes through the
gateway (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`), not only to
the test lab. Options:

- **Scope**: `tool_and_last` (tool outputs + latest user message, default),
  `all_messages`, or `last_only`.
- **RTK filter**: auto-detect or a fixed filter (`log`, `git-diff`, `pytest`,
  `tsc`, ...).
- **Caveman type**: auto-detect or a fixed type (`json`, `code`, `diff`, ...).
- **Output voice**: `off`, `caveman`, `ultracave`, `megacave`.
- **Min chars**: skip messages shorter than this.
- **Timeout**: per-tool time limit in ms.
- **Never worse**: keep the original text when the compressed result is not
  smaller.

## Test lab

Paste sample text on the page and run it through the configured pipeline to
see the before/after size and duration.

## MCP

The `compression_settings`, `set_compression` and `test_compression` MCP tools
read, change and test the same settings. See [AI Agents & MCP](ai-agents.md).

## Environment overrides

| Variable | Purpose |
| --- | --- |
| `UNIROUTE_TOOLS_DIR` | Directory for downloaded binaries |
| `UNIROUTE_RTK_VERSION`, `UNIROUTE_CAVEMAN_VERSION` | Pin a release version |
| `UNIROUTE_RTK_DOWNLOAD_URL`, `UNIROUTE_CAVEMAN_DOWNLOAD_URL` | Download from a mirror |
