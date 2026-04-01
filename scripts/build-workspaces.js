const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");

function runStep(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const userAgent = process.env.npm_config_user_agent ?? "";
const isBun = /\bbun\//i.test(userAgent) || Boolean(process.env.BUN_INSTALL);

if (isBun) {
  runStep("bun", ["run", "build"], { cwd: resolve(process.cwd(), "client") });
  runStep("bun", ["run", "build"], { cwd: resolve(process.cwd(), "server") });
} else {
  runStep("npm", ["run", "build", "--workspace", "client"]);
  runStep("npm", ["run", "build", "--workspace", "server"]);
}
