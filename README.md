# rifts.to MCP server

[![npm](https://img.shields.io/npm/v/@rifts_to/mcp)](https://www.npmjs.com/package/@rifts_to/mcp)
[![CI](https://github.com/riftsto/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/riftsto/mcp/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

An MCP server for [rifts.to](https://rifts.to), a live audience survey tool. It lets an AI client create a survey — in your own colors — list the surveys on your account, read back the results, edit or reopen one, and relaunch a saved template when the same poll comes round again.

Point a poll at your audience by asking your AI client to do it, and check the answers the same way, without leaving the chat.

```bash
claude mcp add --transport http rifts https://mcp.rifts.to/mcp
```

That is the hosted server, and it signs you in through the browser. [Running your
own copy](#run-it-yourself) is supported too.

## Tools

- **`create_survey`**: creates a survey from a title and a list of questions and returns its public link and admin link. Optionally accepts a custom slug and a [theme](#colors).
- **`list_surveys`**: lists the surveys on your account, with title, status, and response count. Admin links are included only if you ask for them, so a routine listing doesn't hand a model a pile of credentials it didn't need.
- **`get_survey_results`**: returns a survey's questions and every response.
- **`get_survey_summary`**: returns the counts instead of the responses — a tally for every multiple-choice option including the ones nobody picked, and the mean and spread of each rating. Reach for this rather than `get_survey_results` when the question is about the numbers: a survey with hundreds of written answers is far bigger than its summary. Written answers are not included.
- **`rename_survey`**: changes a survey's title. The link and the answers are untouched.
- **`close_survey`**: stops a survey from accepting new responses.
- **`reopen_survey`**: lets a closed survey take answers again. A survey past its expiry date is refused rather than silently left closed.
- **`update_survey`**: changes a live survey's colors, its questions, or both. Questions can be added after people start answering, but not removed, reordered, retyped, or have their options renamed — see [editing a survey that already has answers](#editing-a-survey-that-already-has-answers).
- **`archive_survey`**: hides a survey from your list without closing it. `restore: true` puts it back.
- **`clone_survey`**: runs the same questions again as a brand new survey, with its own link and no responses. For a one-off repeat; save a template if it will run every week. The clone does not inherit the original's archived state or expiry, so copying an expired survey on an active subscription gives you a live one.
- **`save_survey_as_template`**: turns a live survey's questions into a template, the other direction from `launch_template`.
- **`list_templates`** / **`create_template`** / **`launch_template`**: saved question sets, and starting a fresh survey from one. Each launch collects its own answers, so a weekly poll keeps its weeks apart.

Editing and deleting templates stay on the website. A launch is additive and reversible; an edit silently rewrites something a recurring poll depends on.

## Colors

`create_survey`, `update_survey`, `launch_template` and `clone_survey` all take a `theme`. It is either one of the presets — `sunset`, `ocean`, `forest`, `rose`, `slate` — or your own pair of hex colors:

```json
{ "theme": { "primary": "#7c5cfa", "background": "#09090e" } }
```

rifts.to derives the rest of the palette (surfaces, borders, muted text, and a light-mode variant for respondents whose device asks for one) from those two, and contrast-checks the result.

**Leave `theme` out and the survey is painted in whatever palette your account last saved on rifts.to.** That is usually your own brand, so omitting it is the right default rather than a missing feature; `"default"` is how you ask for the rifts.to house colors instead. Setting a theme from here never changes the palette the website's own builder opens on — that one stays yours to set by hand.

Only the page respondents see is themed. Your results dashboard is not.

## Editing a survey that already has answers

`update_survey` replaces a survey's whole question list, and once responses exist rifts.to restricts what that list may become. Questions can be **added** to the end. They cannot be removed, reordered, or have their type changed, and a multiple-choice option cannot be renamed or dropped.

The reason is that a response stores the option's exact text against the question's position, and the responses table keeps no snapshot of the questions it was answering. Rename an option and every answer naming the old one stops matching; remove a question and the answers keyed to that position belong to whatever moved up into it. Neither is recoverable, so the API refuses the edit and says which rule stopped it. When the question set genuinely needs to change, start a new survey.

### Optional and conditional questions

Every question defaults to required, exactly as it always has. A question can opt out of that with a `requirement` field:

```json
{ "type": "free_text", "text": "Anything else?",
  "requirement": { "mode": "optional" } }
```

```json
{ "type": "free_text", "text": "What kept you away?",
  "requirement": {
    "mode": "conditional",
    "when": {
      "op": "all",
      "conditions": [{ "questionIndex": 0, "values": ["No"] }]
    }
  } }
```

`questionIndex` is the 0-based position of an earlier question in the same `questions` array — questions have no separate id, so position is the only way to point at one — and it must name a `multiple_choice` question, since only those have a fixed set of `options` for `values` to match against. `op` is `"all"` for AND or `"any"` for OR across `conditions`.

Either mode changes only whether an answer is *required*, never whether the question is *shown*: a conditional question is always visible to every respondent, and just carries an "Optional" marker when it isn't currently required for them. This is not branching or skip logic.

## Hosted, with sign-in

rifts.to runs this server at `https://mcp.rifts.to/mcp`. Add it as a remote MCP
server and your client walks an OAuth flow: it registers itself, sends you to
rifts.to to approve, and stores the token it gets back. Nothing to paste, and
you can revoke it later under "Connected applications" on `/account`.

In Claude Desktop, add it as a custom connector with that same URL.

Running it yourself, with a token you paste in, is the rest of this document.

## Run it yourself

```bash
npx @rifts_to/mcp
```

Releases are published from CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
so each version on npm carries a signed attestation linking it to the commit
and workflow run that built it. You can check the one you installed:

```bash
npm audit signatures
```

Cutting a GitHub release triggers the publish; the tag has to match the version
in `package.json` or the run fails.

Building from source works too, and is the same code:

```bash
git clone https://github.com/riftsto/mcp.git rifts-mcp
cd rifts-mcp
npm install
npm run build
node dist/stdio.js
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
      "args": ["-y", "@rifts_to/mcp"],
      "env": {
        "RIFTS_TOKEN": "your-token-here"
      }
    }
  }
}
```

Running from a clone instead means `"command": "node"` with
`"args": ["/path/to/rifts-mcp/dist/stdio.js"]`.

### Claude Code

```bash
claude mcp add rifts -e RIFTS_TOKEN=your-token-here -- npx -y @rifts_to/mcp
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
