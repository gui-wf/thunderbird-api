# Thunderbird API

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Thunderbird](https://img.shields.io/badge/Thunderbird-102%2B-0a84ff.svg)](https://www.thunderbird.net/)
[![MCP](https://img.shields.io/badge/MCP-compatible-green.svg)](https://modelcontextprotocol.io/)

> Inspired by [bb1/thunderbird-mcp](https://github.com/bb1/thunderbird-mcp). Rewritten from scratch with a bundled HTTP server, proper MIME decoding, and UTF-8 handling throughout.

MCP server and CLI for Thunderbird - read email, search contacts, manage messages, and draft replies.

## How it works

```
MCP Client <--stdio--> thunderbird-api <--HTTP--> Thunderbird Extension
                                           ^
thunderbird-cli  ------HTTP (JSON-RPC)-----+
```

The Thunderbird extension runs a local HTTP server on port 8765. Two Rust binaries talk to it:

- **MCP bridge** (`thunderbird-api`) - translates MCP's stdio protocol to HTTP for AI assistants
- **CLI** (`thunderbird-cli`) - direct terminal access with subcommands for all operations

## Setup

**1. Install the extension**

```bash
# With Nix
nix build github:gui-wf/thunderbird-api#extension
# Then install result/thunderbird-api.xpi in Thunderbird

# Or build from source
cd extension && zip -r ../thunderbird-api.xpi .
```

Restart Thunderbird.

**2. Configure your MCP client**

Example for `~/.claude.json` (with Nix):

```json
{
  "mcpServers": {
    "thunderbird-mail": {
      "command": "nix",
      "args": ["run", "github:gui-wf/thunderbird-api"]
    }
  }
}
```

Or with a local build:

```json
{
  "mcpServers": {
    "thunderbird-mail": {
      "command": "thunderbird-api",
      "args": []
    }
  }
}
```

## What you can do

| Tool | What it does |
|------|--------------|
| `listAccounts` | List email accounts and identities |
| `searchMessages` | Find emails by subject, sender, or recipient |
| `getMessage` | Read full email with optional attachment download to temp files |
| `listFolders` | List all mail folders with URIs and message counts |
| `updateMessage` | Mark read/unread, flag/unflag, move, or trash a message |
| `sendMail` | Open a compose window with pre-filled content |
| `replyToMessage` | Reply with proper threading and quoted original |
| `forwardMessage` | Forward with attachments preserved |
| `searchContacts` | Look up contacts |
| `listCalendars` | List your calendars |

Compose tools open a window for you to review before sending. Nothing gets sent automatically.

## CLI usage

```bash
thunderbird-cli search "quarterly report"       # Search messages
thunderbird-cli get "<id>" "<folder>"            # Read a message
thunderbird-cli folders                          # List all folders
thunderbird-cli accounts                         # List accounts
thunderbird-cli update "<id>" "<folder>" --read  # Mark as read
thunderbird-cli update "<id>" "<folder>" --trash # Trash a message
thunderbird-cli contacts "alice"                 # Search contacts
thunderbird-cli help                             # Full usage info
```

Install with Nix: `nix build github:gui-wf/thunderbird-api#cli` or `nix run github:gui-wf/thunderbird-api#cli`.

## Security

The extension only listens on localhost, but any local process can access it while Thunderbird is running. Keep this in mind on shared machines.

## Troubleshooting

**Extension not loading?**
Check Tools > Add-ons and Themes. For errors: Tools > Developer Tools > Error Console.

**Connection refused?**
Make sure Thunderbird is running and the extension is enabled.

**Can't find recent emails?**
IMAP folders can be stale. Click on the folder in Thunderbird to sync, or right-click > Properties > Repair Folder.

## Development

```bash
# Enter dev shell
nix develop

# Build
cargo build

# Test
cargo test

# Test the HTTP API directly (Thunderbird must be running)
curl -X POST http://localhost:8765 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Test the bridge
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | cargo run --bin thunderbird-api
```

After changing extension code, you'll need to remove it from Thunderbird, restart, reinstall, and restart again. Thunderbird caches aggressively.

## Known issues

- IMAP folder databases can be stale until you click on them
- Email bodies with weird control characters get sanitized to avoid breaking JSON

## Project structure

```
thunderbird-api/
├── Cargo.toml                  # Rust crate with two binary targets
├── src/
│   ├── lib.rs                  # Library re-exports
│   ├── types.rs                # JSON-RPC request/response types
│   ├── sanitize.rs             # JSON control-char sanitization
│   ├── client.rs               # HTTP client for Thunderbird extension
│   ├── bin/
│   │   ├── thunderbird_api.rs  # MCP stdio bridge
│   │   └── thunderbird_cli.rs  # CLI tool
│   └── cli/
│       ├── mod.rs              # Clap definitions
│       ├── commands.rs         # Subcommand dispatch
│       └── format.rs           # Output formatting
├── extension/
│   ├── manifest.json
│   ├── background.js           # Extension entry point
│   ├── httpd.sys.mjs           # Mozilla's HTTP server lib
│   └── mcp_server/
│       ├── api.js              # The actual API implementation
│       └── schema.json
└── flake.nix                   # Nix packaging (bridge + CLI, extension)
```

## License

MIT. The bundled `httpd.sys.mjs` is from Mozilla and licensed under MPL-2.0.
