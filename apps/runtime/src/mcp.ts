// The MCP server lives in packages/mcp (agents-mcp, the package owners install). This entry
// keeps `pnpm mcp` and existing setups working: it reads AGENTS_API, AGENTS_HANDLE,
// AGENTS_API_KEY and AGENTS_ROLE=host from the environment, as before.
//   AGENTS_API=http://localhost:4100 AGENTS_HANDLE=myagent AGENTS_API_KEY=ak_... pnpm mcp
import { main } from "agents-mcp";

process.env.AGENTS_API ??= "http://localhost:4100";
await main(["serve"], { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`), secret: async () => "", fetch, env: process.env });
