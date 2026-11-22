import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json());

// ── Snowflake config from env ─────────────────────────────────────────────────
const SF_ACCOUNT   = process.env.SNOWFLAKE_ACCOUNT;    // required, e.g. "myorg-myaccount"
const SF_PAT       = process.env.SNOWFLAKE_PAT;       // required
const SF_WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE  || "COMPUTE_WH";
const SF_DATABASE  = process.env.SNOWFLAKE_DATABASE   || "CIRRUSSOLAR";
const SF_SCHEMA    = process.env.SNOWFLAKE_SCHEMA     || "PUBLIC";
const SEMANTIC_MODEL_FILE = process.env.SEMANTIC_MODEL_FILE
  || "@CIRRUSSOLAR.PUBLIC.CIRRUS_SOLAR_STAGE/cirrus_solar_semantic_model.yaml";

const SF_BASE = `https://${SF_ACCOUNT}.snowflakecomputing.com`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sfHeaders() {
  return {
    "Authorization": `Bearer ${SF_PAT}`,
    "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN",
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

/** Ask Cortex Analyst and return the SQL statement it generates. */
async function callCortexAnalyst(question) {
  const url = `${SF_BASE}/api/v2/cortex/analyst/message`;
  const body = {
    messages: [{ role: "user", content: [{ type: "text", text: question }] }],
    semantic_model_file: SEMANTIC_MODEL_FILE,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: sfHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Cortex Analyst error ${res.status}: ${errText}`);
  }

  const data = await res.json();

  // Extract the first SQL block from the analyst message
  const content = data?.message?.content ?? [];
  const sqlBlock = content.find((c) => c.type === "sql");
  const textBlock = content.find((c) => c.type === "text");

  if (!sqlBlock) {
    // Return the text explanation if no SQL was generated
    const explanation = textBlock?.text ?? JSON.stringify(data);
    throw new Error(`Cortex Analyst did not generate SQL. Response: ${explanation}`);
  }

  return {
    sql: sqlBlock.statement,
    explanation: textBlock?.text ?? null,
  };
}

/** Execute a SQL statement via Snowflake SQL API and return rows as objects. */
async function executeSQL(sql) {
  const url = `${SF_BASE}/api/v2/statements`;
  const body = {
    statement: sql,
    database: SF_DATABASE,
    schema: SF_SCHEMA,
    warehouse: SF_WAREHOUSE,
    parameters: { MULTI_STATEMENT_COUNT: "0" },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { ...sfHeaders(), "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Snowflake SQL API error ${res.status}: ${errText}`);
  }

  const data = await res.json();

  // data.resultSetMetaData.rowType contains column names
  // data.data contains rows as arrays of strings
  const columns = (data?.resultSetMetaData?.rowType ?? []).map((c) => c.name);
  const rawRows = data?.data ?? [];

  // Convert each row array to an object keyed by column name
  const rows = rawRows.map((row) => {
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });

  return { columns, rows };
}

/** Format rows as a markdown-ish table string for LLM consumption. */
function formatResults(columns, rows) {
  if (rows.length === 0) return "No results found.";

  const header = columns.join(" | ");
  const separator = columns.map(() => "---").join(" | ");
  const body = rows
    .map((row) => columns.map((c) => (row[c] ?? "NULL")).join(" | "))
    .join("\n");

  return `${header}\n${separator}\n${body}`;
}

// ── MCP Server factory ────────────────────────────────────────────────────────

function createMcpServer() {
  const server = new McpServer({
    name: "cirrus-solar-mcp-server",
    version: "1.0.0",
  });

  server.tool(
    "customer-solar-search",
    "Search Cirrus Solar customer records. Returns energy production, consumption, grid export, system efficiency, financing balance, payment status, installation details, and warranty information. Ask natural language questions about any customer.",
    {
      question: z
        .string()
        .describe(
          "Natural language question about a Cirrus Solar customer. Examples: " +
          "'What is the remaining loan balance for customer C001?', " +
          "'How much energy did C003 produce last month?', " +
          "'When does the warranty expire for C005?', " +
          "'Has customer C007 made their last payment?'"
        ),
    },
    async ({ question }) => {
      const missing = [!SF_ACCOUNT && "SNOWFLAKE_ACCOUNT", !SF_PAT && "SNOWFLAKE_PAT"].filter(Boolean);
      if (missing.length) {
        return {
          content: [{
            type: "text",
            text: `Error: ${missing.join(" and ")} environment variable${missing.length > 1 ? "s are" : " is"} not set.`,
          }],
          isError: true,
        };
      }

      try {
        // Step 1 — translate question to SQL via Cortex Analyst
        const { sql, explanation } = await callCortexAnalyst(question);

        // Step 2 — execute the SQL
        const { columns, rows } = await executeSQL(sql);

        // Step 3 — format and return
        const table = formatResults(columns, rows);
        const parts = [];
        if (explanation) parts.push(explanation);
        parts.push(`**Query Results:**\n\`\`\`\n${table}\n\`\`\``);
        parts.push(`\n*SQL executed:* \`${sql.replace(/\s+/g, " ").trim()}\``);

        return {
          content: [{ type: "text", text: parts.join("\n\n") }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ── Express routes ────────────────────────────────────────────────────────────

// Health check — useful for Railway and Salesforce connectivity tests
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "cirrus-solar-mcp-server", version: "1.0.0" });
});

// MCP Streamable HTTP — single endpoint handles all MCP traffic
app.all("/mcp", async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — new session per request
  });

  // Clean up when the response closes
  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal MCP server error", message: err.message });
    }
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Cirrus Solar MCP server running on port ${PORT}`);
  console.log(`  MCP endpoint : http://localhost:${PORT}/mcp`);
  console.log(`  Health check : http://localhost:${PORT}/health`);
  console.log(`  Snowflake acct: ${SF_ACCOUNT ? SF_BASE : "NOT SET — set SNOWFLAKE_ACCOUNT env var!"}`);
  console.log(`  PAT configured: ${SF_PAT ? "YES" : "NO — set SNOWFLAKE_PAT env var!"}`);
});
