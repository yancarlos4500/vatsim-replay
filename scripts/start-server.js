const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const userAgent = process.env.npm_config_user_agent ?? "";
const isBun = /\bbun\//i.test(userAgent) || Boolean(process.env.BUN_INSTALL);

const command = isBun ? "bun" : "npm";
const args = isBun
  ? ["run", "start"]
  : ["run", "start", "--workspace", "server"];

const child = spawn(command, args, {
  cwd: isBun ? resolve(process.cwd(), "server") : process.cwd(),
  stdio: "inherit",
  shell: process.platform === "win32",
});

function forwardSignal(signal) {
  if (!child.killed) {
    child.kill(signal);
  }
}

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
