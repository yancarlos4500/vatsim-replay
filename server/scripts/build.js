import { mkdirSync, cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(__dirname, "..");
const dist = join(serverRoot, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// This is a plain JS project, so build just copies src -> dist
cpSync(join(serverRoot, "src"), dist, { recursive: true });

console.log("Server build complete.");
