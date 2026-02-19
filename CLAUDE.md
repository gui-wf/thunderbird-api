# Thunderbird API

MCP server and CLI for Thunderbird email. Exposes 10 tools via a Thunderbird extension that runs an HTTP server on localhost:8765.

## Architecture

```
MCP Client <--stdio--> thunderbird-api <--HTTP/JSON-RPC--> Thunderbird Extension (port 8765)
thunderbird-cli --------HTTP/JSON-RPC-------------------->
```

Three components:
- **Extension** (`extension/`) - Thunderbird add-on with bundled HTTP server. All email logic lives in `extension/mcp_server/api.js`.
- **MCP bridge** (`thunderbird-api`) - Rust binary. Translates MCP stdio protocol to HTTP.
- **CLI** (`thunderbird-cli`) - Rust binary. Terminal interface with subcommands via clap.

The bridge and CLI are thin HTTP clients (using ureq). All real work happens in the extension's `api.js`.

## Key files

| File | What it does |
|------|--------------|
| `extension/mcp_server/api.js` | All tool implementations, XPCOM/Thunderbird API calls |
| `extension/mcp_server/schema.json` | WebExtension experiment API schema |
| `extension/background.js` | Extension entry point, starts HTTP server |
| `extension/httpd.sys.mjs` | Mozilla's HTTP server library (vendored, MPL-2.0) |
| `src/client.rs` | HTTP client for Thunderbird extension |
| `src/types.rs` | JSON-RPC request/response types |
| `src/sanitize.rs` | JSON control-char sanitization |
| `src/cli/mod.rs` | Clap subcommand definitions |
| `src/cli/commands.rs` | CLI subcommand dispatch |
| `src/cli/format.rs` | Output formatting (dates, truncation, lists) |
| `src/bin/thunderbird_api.rs` | MCP stdio bridge binary |
| `src/bin/thunderbird_cli.rs` | CLI binary |
| `flake.nix` | Nix packages: `default`/`cli` (Rust), `extension` (XPI) |

## Rust crate structure

Single crate with two `[[bin]]` targets sharing library code:
- `thunderbird-api` (MCP bridge)
- `thunderbird-cli` (CLI)

Dependencies: serde, serde_json, ureq (no TLS), clap (derive), anyhow. No async runtime.

## api.js structure

The file is a single WebExtension experiment API class. Key sections in order:

1. **Tool schemas** (~line 1-180) - JSON Schema definitions for all 10 tools
2. **Helper functions** (~line 350-410) - `sanitizeForJson`, `setComposeIdentity`, `findMessage`
3. **Tool functions** (~line 410-1100) - `searchMessages`, `listFolders`, `getMessage`, `replyToMessage`, `forwardMessage`, `updateMessage`, etc.
4. **callTool switch** (~line 1100-1130) - Routes tool names to functions
5. **HTTP server setup** (~line 1130+) - JSON-RPC handler, server start/stop

## Thunderbird APIs used

- `MailServices.accounts` - Account enumeration
- `MailServices.folderLookup.getFolderForURL()` - Folder access by URI
- `folder.msgDatabase.enumerateMessages()` - Message iteration
- `MsgHdrToMimeMessage` - Full MIME message parsing (body, attachments)
- `MailServices.compose` - Compose window creation
- `MailServices.copy.copyMessages()` - Message move/copy
- `NetUtil.asyncFetch` - Attachment download
- `nsIAbManager` - Address book contacts

## Extension permissions

Declared in `extension/manifest.json`:
- `accountsRead`, `addressBooks`, `messagesRead`, `messagesMove`, `accountsFolders`, `compose`

## Development workflow

Extension changes require full reinstall (Thunderbird caches aggressively):
1. Edit files in `extension/`
2. Build XPI: `cd extension && zip -r ../thunderbird-api.xpi .`
3. Remove extension from Thunderbird, restart
4. Install new XPI, restart again

Bridge/CLI changes: `cargo build` and test immediately.

## Testing

```bash
# Build and test
cargo build
cargo test

# Direct HTTP test (Thunderbird must be running)
curl -s -X POST http://localhost:8765 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'

# Test CLI
thunderbird-cli accounts
thunderbird-cli search "test" --max 3

# Test MCP bridge
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | cargo run --bin thunderbird-api
```

## Nix packages

| Package | Command | What |
|---------|---------|------|
| `default` | `nix run github:gui-wf/thunderbird-api` | MCP bridge (for AI clients) |
| `cli` | `nix run github:gui-wf/thunderbird-api#cli` | CLI tool (same derivation) |
| `extension` | `nix build github:gui-wf/thunderbird-api#extension` | XPI file |

## Conventions

- Blocking HTTP only (ureq, no async runtime) - sequential request/response, no concurrency needed
- MIME-decoded headers everywhere (`mime2DecodedSubject`, `mime2DecodedAuthor`, `mime2DecodedRecipients`)
- `findMessage(messageId, folderPath)` helper for all message lookup (deduplicates the folder+db+enumerate pattern)
- Compose tools open a review window, never send automatically
- Attachments saved to `/tmp/thunderbird-api/<sanitized-id>/` when requested
- 50MB per-attachment size guard
- Message IDs are strings (RFC 2822 Message-ID header), not integers
- Bridge must flush stdout after every response (piped buffering)
- JSON sanitization uses backslash parity toggle for correctness
