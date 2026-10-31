# Claude and ChatGPT

Connect Claude or ChatGPT to Stugu and ask about your Homes in plain language.
For example: "Is the front door open?", "What was the average temperature in
the Home last night?", or "How much electricity did we use yesterday?" A
connection works wherever you use that assistant: on the web, in the desktop
apps, on your phone, and by voice.

The assistant signs in to Stugu with OAuth. An Owner or Admin approves each
connection in Stugu, and the assistant then reads Stugu's read-only
conversation tools. It cannot change anything, control equipment, or see
accounts, passwords or integration credentials.

## Before you start

Claude and ChatGPT call Stugu from their own servers, not from your phone or
computer. Stugu therefore needs a **public HTTPS address**. The supported way
to get one is the [Cloudflare Tunnel and Access setup](cloudflare-access.md).
Any HTTPS reverse proxy that forwards `/api/v1/mcp`, `/api/v1/oauth/*` and
`/.well-known/oauth-*` to the Stugu web service also works.

If you set up Cloudflare before 0.58.0, run the Cloudflare setup again: the
[UI-managed setup](cloudflare-access.md#ui-managed-setup), or
`node scripts/cloudflare-stugu.mjs provision …` (or `provision-coordinator`)
with the same arguments. This adds one Access application that lets the
assistants reach the endpoints listed under
[What is reachable from the internet](#what-is-reachable-from-the-internet).

An installation that is reachable only on your home network or over a VPN
such as Tailscale cannot be reached from Claude's or ChatGPT's servers. You
can still connect Claude Code and other MCP apps that run on a computer on
that network (see [Claude Code and other MCP apps](#claude-code-and-other-mcp-apps)).

## Connect

1. In Stugu, open **Advanced → API & MCP** through your public HTTPS address,
   and copy the **Connector URL** from **Claude and ChatGPT**. It is
   `https://<your Stugu>/api/v1/mcp`.
2. Add it to the assistant:
   - **Claude** (claude.ai, Claude Desktop, mobile): **Settings → Connectors →
     Add custom connector**, name it *Stugu*, paste the URL, and select
     **Add**. No client ID or secret is needed. On Team and Enterprise plans,
     an organization Owner adds custom connectors.
   - **ChatGPT**: add a custom MCP connector or app (under **Settings → Apps**
     or **Plugins**, depending on your plan and workspace), paste the URL, and
     choose **OAuth** sign-in.
3. The assistant opens Stugu's **Connect an assistant** page. Sign in if
   asked, check the assistant and the address it names, and select **Allow**.
4. Back in the assistant, enable Stugu for a conversation and ask a question.

The connection stays in place across Stugu restarts and updates. Stugu issues
one-hour access tokens and rotates the refresh token on every use, so the
assistant renews its access without asking you again.

### Claude Code and other MCP apps

An MCP app on your own computer can use the same URL, including a local
address such as `http://stugu.local:8080/api/v1/mcp` on your home network:

```sh
claude mcp add --transport http stugu https://stugu.example.com/api/v1/mcp
```

The first time it connects, the app opens the same approval page in your
browser and receives the code on a `localhost` address. Stugu shows such a
connection as **An app on this computer**.

## Disconnect

**Advanced → API & MCP → Claude and ChatGPT** lists every connected assistant,
who approved it, and when it was last used. **Disconnect** invalidates its
tokens immediately; the assistant must be connected and approved again to
regain access. Disconnecting from inside Claude or ChatGPT revokes the
connection in Stugu too, if the assistant calls Stugu's revocation endpoint.

A connection also stops working when the account that approved it is
removed, or is no longer an Owner or Admin.

## What an assistant can read

Assistants use the same 22 conversation tools as the
[ChatGPT tunnel profile](chatgpt.md):

- Homes, floors and rooms, sensors and measurement definitions
- current readings, history and Home summaries
- doors and windows, current state and recent activity
- electricity prices, cost and energy summaries, and the 30-day energy projection
- heat-pump state: power, mode, target and room temperature
- weather, outdoor temperature history and the indoor/outdoor moisture model
- active alerts, Home monitoring and the latest daily findings
- calendar comparisons

They do not get the full 69-tool local inspection set, so they do not get
integration set-up, connection tests or LAN discovery. Every tool opens the
Stugu database read-only.

An approved assistant can read every Home in the workspace. Guest grants do
not limit it, which is why only an Owner or Admin can approve one. What the
assistant reads leaves your network and is handled under that assistant's
privacy terms.

## What is reachable from the internet

With the Cloudflare setup, these paths bypass the Access login, because the
assistants' servers cannot complete it. Each one authenticates the caller
itself:

| Path | What it does | How it is protected |
| --- | --- | --- |
| `/.well-known/oauth-authorization-server` | OAuth server metadata | Public metadata only |
| `/.well-known/oauth-protected-resource/api/v1/mcp` | Says which server signs in to `/api/v1/mcp` | Public metadata only |
| `/api/v1/oauth/register` | Dynamic client registration | Accepts only Claude's and ChatGPT's own callback addresses and `localhost`; unapproved registrations are removed after a day |
| `/api/v1/oauth/token`, `/api/v1/oauth/revoke` | Token exchange and revocation | Client authentication, single-use two-minute codes bound to a PKCE verifier |
| `/api/v1/mcp` | The MCP endpoint | A valid bearer token for this exact URL |

The approval page (`/connect/assistant`) and every other path stay behind
Access, so approving still requires Access sign-in followed by Stugu sign-in.
The bundled proxy rate-limits the OAuth paths before the API reads a request
body.

## Troubleshooting

- **The assistant says it cannot reach the server.** Open
  `https://<your Stugu>/.well-known/oauth-authorization-server` in a private
  browser window. It should show JSON whose `issuer` is your Stugu address.
  An Access login page means the Cloudflare setup has not been run again
  since 0.58.0. `node scripts/cloudflare-stugu.mjs verify --secret-dir …`
  checks the paths for you.
- **"This connection request can't be used".** The assistant asked for
  something Stugu does not support, or its registration expired. Remove the
  connector in the assistant and add it again.
- **"Ask an Owner or Admin".** The signed-in account is a Member or Guest.
  Sign in as an Owner or Admin, or ask one to connect the assistant.
- **The assistant stops answering after a while.** Check
  **Advanced → API & MCP**: if the connection is gone, it was disconnected,
  or a refresh token was used twice, which Stugu treats as theft. Connect it
  again.
