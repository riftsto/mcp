# rifts.to MCP server

[![CI](https://github.com/riftsto/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/riftsto/mcp/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

An MCP server for [rifts.to](https://rifts.to), a live audience survey tool. It lets an AI client create a survey, list the surveys on your account, read back the results, and close a survey when you're done collecting responses.

Point a poll at your audience by asking your AI client to do it, and check the answers the same way, without leaving the chat.

```bash
claude mcp add --transport http rifts https://mcp.rifts.to/mcp
```

That is the hosted server, and it signs you in through the browser. [Running your
own copy](#run-it-yourself) is supported too.

## Tools

- **`create_survey`**: creates a survey from a title and a list of questions and returns its public link and admin link. Optionally accepts a custom slug.
- **`list_surveys`**: lists the surveys on your account, with title, status, and response count. Admin links are included only if you ask for them, so a routine listing doesn't hand a model a pile of credentials it didn't need.
- **`get_survey_results`**: returns a survey's questions and every response.
- **`close_survey`**: stops a survey from accepting new responses. Reopening, retitling, and editing questions stay in the rifts.to admin dashboard, not here.

## Hosted, with sign-in

rifts.to runs this server at `https://mcp.rifts.to/mcp`. Add it as a remote MCP
server and your client walks an OAuth flow: it registers itself, sends you to
rifts.to to approve, and stores the token it gets back. Nothing to paste, and
you can revoke it later under "Connected applications" on `/account`.

In Claude Desktop, add it as a custom connector with that same URL.

Running it yourself, with a token you paste in, is the rest of this document.

## Run it yourself

Not on npm yet, so clone this repository and build:

```bash
git clone https://github.com/riftsto/mcp.git rifts-mcp
cd rifts-mcp
npm install
npm run build
node dist/stdio.js
```

When `@rifts_to/mcp` is published, `npx @rifts_to/mcp` will replace all of that,
and every `node /path/to/...` below becomes `npx -y @rifts_to/mcp`.

Releases are published from CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
so each version on npm carries a signed attestation linking it to the commit
and workflow run that built it. Cutting a GitHub release triggers the publish;
the tag has to match the version in `package.json` or the run fails.

The server reads its configuration from two environment variables:

- `RIFTS_TOKEN` (required): your personal access token.
- `RIFTS_API_URL` (optional): defaults to `https://rifts.to`. Set this only if you're pointing the server at a different rifts.to deployment.

### Claude Desktop

Add this to your `claude_desktop_config.json`, using the absolute path to your
build:

```json
{
  "mcpServers": {
    "rifts": {
      "command": "node",
      "args": ["/path/to/rifts-mcp/dist/stdio.js"],
      "env": {
        "RIFTS_TOKEN": "your-token-here"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add rifts -e RIFTS_TOKEN=your-token-here -- node /path/to/rifts-mcp/dist/stdio.js
```

Add `-s user` to make it available in every project instead of just the
current one.

## Getting a token

1. Sign in at [rifts.to](https://rifts.to).
2. Go to `/account`.
3. Create a token under "API tokens."

Token creation requires an active subscription. The token is shown once, at creation time, so save it somewhere before you close the dialog. If you lose it, create a new one.

## Self-hosting

This server is stateless and holds no credentials of its own. Every request carries your `RIFTS_TOKEN` and goes straight to the rifts.to API; the server doesn't store it, cache it, or log it anywhere. Running your own copy, on your own machine or your own infrastructure, is a supported way to use it, and it still needs a token from a real rifts.to account with an active subscription. There's no separate self-hosting tier or discount; the token is what's paid for, not the server.

## Development

```bash
npm install
npm test          # vitest, drives the server over an in-memory transport
npm run typecheck
npm run build
```

The tests connect a real MCP client to the server and call the tools against a
stub API, so a schema that rejects a valid question, or a result the SDK
refuses to serialize, fails in CI rather than in someone's chat window.

`src/server.ts` builds the server and is transport-free. `src/stdio.ts` and
`src/worker.ts` are the two entry points, and neither contains tool logic, so
the hosted and self-hosted paths cannot drift on what the tools do.

## Security

Token handling, what this server can reach, and how to report a vulnerability:
[SECURITY.md](./SECURITY.md).

## License

Apache-2.0. See [LICENSE](./LICENSE).
