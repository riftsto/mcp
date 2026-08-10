# rifts.to MCP server

An MCP server for [rifts.to](https://rifts.to), a live audience survey tool. It lets an AI client create a survey, list the surveys on your account, read back the results, and close a survey when you're done collecting responses.

Point a poll at your audience by asking your AI client to do it, and check the answers the same way, without leaving the chat.

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

```bash
claude mcp add --transport http rifts https://mcp.rifts.to/mcp
```

In Claude Desktop, add it as a custom connector with that same URL.

Running it yourself, with a token you paste in, is the rest of this document.

## Install and run

```bash
npx @riftsto/mcp
```

The server reads its configuration from two environment variables:

- `RIFTS_TOKEN` (required): your personal access token.
- `RIFTS_API_URL` (optional): defaults to `https://rifts.to`. Set this only if you're pointing the server at a different rifts.to deployment.

### Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rifts": {
      "command": "npx",
      "args": ["-y", "@riftsto/mcp"],
      "env": {
        "RIFTS_TOKEN": "your-token-here"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add rifts -e RIFTS_TOKEN=your-token-here -- npx -y @riftsto/mcp
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

## License

Apache-2.0. See [LICENSE](./LICENSE).
