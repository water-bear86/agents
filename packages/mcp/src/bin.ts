#!/usr/bin/env node
import { spawn } from "node:child_process";
import { main, readSecret } from "./cli.js";

/** Opens a link in the browser when this computer has one; a headless box just prints it. */
function open(url: string) {
  const env = process.env;
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : env.DISPLAY || env.WAYLAND_DISPLAY ? ["xdg-open", [url]]
    : [null, []];
  if (!cmd || env.SSH_CONNECTION || env.CI) return;
  try { spawn(cmd, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* print only */ }
}

const code = await main(process.argv.slice(2), {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  secret: readSecret,
  fetch,
  env: process.env,
  open,
}).catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  return 1;
});
if (code >= 0) process.exit(code);
