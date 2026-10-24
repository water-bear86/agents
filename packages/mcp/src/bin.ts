#!/usr/bin/env node
import { main, readSecret } from "./cli.js";

const code = await main(process.argv.slice(2), {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  secret: readSecret,
  fetch,
  env: process.env,
}).catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  return 1;
});
if (code >= 0) process.exit(code);
