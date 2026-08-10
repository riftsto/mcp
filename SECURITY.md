# Security

## Reporting a vulnerability

Email **support@rifts.to** with "security" in the subject. Please don't open a
public issue for anything exploitable.

Include what you did, what happened, and what you expected. If you have a
proof of concept, send it. You'll get an acknowledgement within a few days.

Please don't test against other people's accounts or surveys. Use your own.

## What this server can and cannot reach

The server is a protocol adapter. It holds no database, no secrets of its own,
and no credential it wasn't handed for the request it is serving.

Every call carries the caller's own token straight through to the rifts.to
API over HTTPS. The server does not store it, cache it, or log it. Nothing it
returns is broader than what that token already grants, because the API
enforces scope and ownership on every request, not the server.

That means a compromise of this server yields nothing that wasn't already
presented to it, and running your own copy grants you nothing extra: a
self-hosted instance still needs a token from a real rifts.to account.

## Tokens

Two kinds work here:

- **Personal access tokens**, `rifts_pat_…`, pasted into your environment as
  `RIFTS_TOKEN`. They don't expire on their own. Revoke them under
  **API tokens** on your rifts.to account page.
- **OAuth access tokens**, obtained by the hosted server at `mcp.rifts.to`
  through an authorization flow you approve in the browser. These are
  short-lived and refreshed automatically. Revoke them under
  **Connected applications** on the same page.

rifts.to stores only a salted hash of either kind, so a token cannot be
recovered from the database. A personal access token is shown once, at
creation.

A token acts on your account with the scopes you granted. Treat it like a
password: don't commit it, don't paste it into a shared config, and revoke it
if it goes somewhere it shouldn't.

## Admin links

`create_survey` returns an admin URL, and `list_surveys` returns them when you
pass `include_admin`. An admin link is itself a credential: anyone holding it
can read every response and close the survey.

They're omitted from listings by default for that reason, so a routine "what
surveys do I have" doesn't put a pile of credentials into a conversation
transcript. If one leaks, rotate it from the survey's admin dashboard.

## Scope of this policy

This covers the MCP server in this repository. For the rifts.to service
itself, including the API this server calls, report to the same address.
