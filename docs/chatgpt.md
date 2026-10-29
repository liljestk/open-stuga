# ChatGPT and voice

Stugu includes a focused, read-only MCP profile for private ChatGPT
conversations. It exposes current and historical measurements, openings,
electricity use and its 30-day projection, heat-pump state, weather, alerts,
and temperature-corrected indoor/outdoor moisture response. It cannot change the Home or control equipment.

The recommended private connection is OpenAI's
[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
It runs beside Stugu and makes an outbound HTTPS connection; Stugu does not
need a public port. A tunnel is for private and developer-mode use, not public
plugin submission.

## 1. Build and inspect the focused server

From the Stugu repository:

```sh
npm ci
npm run build
npx @modelcontextprotocol/inspector@latest \
  node --env-file-if-exists=.env apps/api/dist/chatgpt-mcp-server.js
```

The server name is `stugu-chatgpt`. It advertises only the conversation tools,
with read-only, non-destructive, and idempotent annotations. For local
development, `npm run mcp:chatgpt` starts the same profile from TypeScript. A
stdio host that must avoid npm's console banner can invoke the source directly:

```sh
node --import tsx --env-file-if-exists=.env apps/api/src/chatgpt-mcp-server.ts
```

## 2. Create the private tunnel

Create a tunnel in [OpenAI Platform tunnel
settings](https://platform.openai.com/settings/organization/tunnels), associate
it with the ChatGPT workspace that will use it, and create a runtime API key
with Tunnels Read + Use. Download the current
[`tunnel-client`](https://github.com/openai/tunnel-client/releases/latest) for
the Stugu host.

Run the following from the repository root so relative database and environment
paths keep their normal meaning:

```sh
export CONTROL_PLANE_API_KEY="sk-..."

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile stugu-chatgpt \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --mcp-command "node --env-file-if-exists=.env apps/api/dist/chatgpt-mcp-server.js"

tunnel-client doctor --profile stugu-chatgpt --explain
tunnel-client run --profile stugu-chatgpt
```

Keep the runtime key in the host's secret manager or service environment, not
in this repository. Keep `tunnel-client run` healthy under the host's service
manager, with the repository root as its working directory, for
always-available voice use.

## 3. Create the ChatGPT app

Follow OpenAI's current [connection
steps](https://developers.openai.com/plugins/deploy/connect-chatgpt):

1. In ChatGPT, open **Settings → Security and login** and enable Developer mode.
2. Open **Plugins**, select **+**, name the app **Stugu**, and describe it as a
   read-only view of the Home.
3. Under **Connection**, select **Tunnel**, choose the Stugu tunnel (or paste
   its `tunnel_id`), and create the connection.
4. Review the 22 discovered tools and test the starter questions below.

The connection is usable immediately. The reusable package in
`plugins/stugu-home` adds Stugu's conversation guidance and branding. After
ChatGPT creates the connection, copy its `plugin_asdk_app...` technical ID and
give it to the plugin creator to add `.app.json` plus the manifest's `apps`
field. The account-bound ID is intentionally not fabricated or checked in
before registration.

## 4. Talk to Stugu

Voice uses the same app permissions as typed Chat. In the ChatGPT desktop app,
open a new empty Chat, select **Start new voice chat before sending a
message**, enable Stugu, and ask, for example:

- “What is the temperature in Köket right now?”
- “What was the average temperature in the Home last night?”
- “Is the front door open?”
- “How much electricity did we use yesterday?”
- “Is the heat pump on, and what is it set to?”
- “Is the current wind consistent with the humidity change inside?”

The last question combines current weather, indoor readings, opening state, and
the moisture-response model. Stugu reports association, coverage, and
confidence; it does not claim that wind caused an indoor humidity change.

## Security boundary

The stdio process opens SQLite read-only and queries TimeDB for requested
history. It does not use browser sessions or Guest grants, so anyone permitted
to use this private app can inspect the configured Stugu workspace. Grant app
and tunnel access accordingly. Only requested tool results cross the tunnel;
there is no public Stugu listener.
