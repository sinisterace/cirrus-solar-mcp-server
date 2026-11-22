# Cirrus Solar MCP Server

**A small remote MCP server that lets a Salesforce Agentforce agent ask plain-English questions of data in Snowflake.** Questions go to Snowflake Cortex Analyst, which turns them into SQL. The server runs that SQL and returns the rows to the agent.

It's built around a fictional residential solar company, Cirrus Solar (energy production, financing, warranties). The pattern works for any Snowflake semantic model: point `SEMANTIC_MODEL_FILE` at your own.

> Companion repo: [snowflake-cortex-mcp](https://github.com/sinisterace/snowflake-cortex-mcp) uses Snowflake's *managed* MCP server with Cortex Search. This repo is the *custom* option: you host the server, the questions are text-to-SQL, and no auth workaround is needed in Salesforce.

## How it works

```
Agentforce agent ──tools/call──► /mcp (this server, Streamable HTTP, stateless)
                                     │
                                     ├─► Snowflake Cortex Analyst   (question → SQL, using your semantic model)
                                     ├─► Snowflake SQL API          (runs the SQL with a PAT)
                                     ▼
Agentforce agent ◄── explanation + results table + the SQL that ran
```

**Tool:** `customer-solar-search`

| Input | Type | Example |
|---|---|---|
| `question` | string | "What is the remaining loan balance for customer C001?" |

The response includes Cortex Analyst's explanation, the result rows as a Markdown table, and the SQL that ran, so the agent can cite its source.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/mcp` | All MCP traffic (`initialize`, `tools/list`, `tools/call`) |
| `GET` | `/health` | Liveness check for your host and for connectivity tests |

The server stays up even if Snowflake isn't configured. `initialize` and `tools/list` still work, and the tool returns a clear error that names the missing variable.

## Configuration

Copy `.env.example` to `.env` for local runs, or set these on your host:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SNOWFLAKE_ACCOUNT` | yes | none | `orgname-accountname`, from `SELECT CURRENT_ORGANIZATION_NAME() \|\| '-' \|\| CURRENT_ACCOUNT_NAME();` |
| `SNOWFLAKE_PAT` | yes | none | A Programmatic Access Token. Keep it secret. |
| `SNOWFLAKE_WAREHOUSE` | no | `COMPUTE_WH` | |
| `SNOWFLAKE_DATABASE` | no | `CIRRUSSOLAR` | |
| `SNOWFLAKE_SCHEMA` | no | `PUBLIC` | |
| `SEMANTIC_MODEL_FILE` | no | `@CIRRUSSOLAR.PUBLIC.CIRRUS_SOLAR_STAGE/cirrus_solar_semantic_model.yaml` | Stage path to your Cortex Analyst semantic model |
| `PORT` | no | `3000` | Most hosts set this automatically |

## Run locally

```bash
npm install
cp .env.example .env      # fill in SNOWFLAKE_ACCOUNT and SNOWFLAKE_PAT
npm start                 # or: npm run dev (auto-reload)

curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Deploy

It's a plain Node 18+ Express app, so any Node host works (Render, Railway, Heroku, Fly.io).

1. Create a web service from this repo. The start command is `npm start`.
2. Set `SNOWFLAKE_ACCOUNT` and `SNOWFLAKE_PAT`, plus any overrides.
3. Your MCP endpoint is `https://<your-service-url>/mcp`.

## Register in Salesforce Agentforce

1. Go to **Setup → Agentforce Registry → Register MCP Server**.
2. Enter `https://<your-service-url>/mcp` as the endpoint URL. Use **No Authentication**, or OAuth 2.0 client credentials if you add auth middleware.
3. Under **Manage Tools**, select `customer-solar-search`.
4. Add the action to your agent and tell it in the instructions when to use it (energy, financing, warranty, and payment questions).

## Security notes

- The `/mcp` endpoint has **no authentication** by default. Anyone with the URL can query your semantic model. For anything beyond a demo, add auth middleware and register with OAuth.
- Give the PAT a least-privilege role that can read only the tables in your semantic model, and rotate it regularly.
- Never commit `.env`. It's already in `.gitignore`.

## License

[MIT](LICENSE)
