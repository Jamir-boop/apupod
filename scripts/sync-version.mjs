// Run by `npm version`: writes the new package.json version to every other place that names it.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const rewrite = (file, pattern) => writeFileSync(file, readFileSync(file, "utf8").replace(pattern, `$1${version}`));
for (const file of ["plugin.json", ".claude-plugin/plugin.json"]) rewrite(file, /("version":\s*")[^"]+/);
for (const file of [".mcp.json", "mcp.json", "examples/opencode.json", "public/index.html", "README.md"]) rewrite(file, /(apupod#v)\d+\.\d+\.\d+/g);
