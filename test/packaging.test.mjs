import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const json = (path) => JSON.parse(read(path));
const pkg = json("package.json");
const TOOLS = new Set([...read("src/mcp.mjs").matchAll(/^\s*tool\("([a-z_]+)"/gm)].map((match) => match[1]));
const SKILLS = readdirSync(join(ROOT, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
// Backticked snake_case words, such as `save_script`, are tool references.
const toolRefs = (text) => new Set([...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1]));

test("src/mcp.mjs registers the 27 tools", () => {
  assert.equal(TOOLS.size, 27);
});

test("plugin manifests are valid, versioned and licensed with package.json, and run the bridge pinned to the release tag", () => {
  const claude = json(".claude-plugin/plugin.json");
  const portable = json("plugin.json");
  for (const manifest of [claude, portable]) {
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.license, pkg.license);
  }
  assert.equal(pkg.license, "MIT");
  assert.match(read("LICENSE"), /^MIT License\n\nCopyright \(c\) 2026 Jamir-boop\n/);
  assert.equal(portable.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");

  // Release: every harness config runs the GitHub tag v<package.json version> through npx.
  const npx = ["-y", `github:Jamir-boop/apupod#v${pkg.version}`, "mcp"];
  assert.deepEqual(json(".mcp.json").mcpServers.apupod, { command: "npx", args: npx });
  const mcp = json("mcp.json");
  assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.deepEqual(mcp.mcpServers.apupod, { type: "stdio", command: "npx", args: npx });
  const opencode = json("examples/opencode.json").mcp.servers.apupod;
  assert.deepEqual(opencode, { type: "local", command: ["npx", ...npx] });
  // The UI shows the same OpenCode snippet.
  assert.ok(read("public/index.html").includes(`&quot;command&quot;: [&quot;npx&quot;, &quot;-y&quot;, &quot;github:Jamir-boop/apupod#v${pkg.version}&quot;, &quot;mcp&quot;]`), "the UI OpenCode snippet pins the package.json version");
  assert.ok(existsSync(join(ROOT, "bin/apupod.mjs")));
});

test("marketplaces list the plugin at the repository root", () => {
  const claude = json(".claude-plugin/marketplace.json");
  assert.ok(claude.owner?.name);
  assert.deepEqual(claude.plugins.map(({ name, source }) => ({ name, source })), [{ name: "apupod", source: "./" }]);
  const codex = json(".agents/plugins/marketplace.json").plugins;
  assert.equal(codex.length, 1);
  assert.equal(codex[0].name, "apupod");
  assert.deepEqual(codex[0].source, { source: "local", path: "./" });
  assert.ok(codex[0].policy.installation && codex[0].policy.authentication && codex[0].category);
});

test("launch.json opens the local UI", () => {
  const configurations = json(".claude/launch.json").configurations;
  assert.ok(configurations.some((item) => item.url === "http://127.0.0.1:4173"));
});

test("package.json publishes the bin and only whitelisted files", () => {
  assert.equal(pkg.private, undefined);
  assert.deepEqual(pkg.bin, { apupod: "bin/apupod.mjs" });
  assert.match(read("bin/apupod.mjs"), /^#!\/usr\/bin\/env node\n/);
  for (const entry of pkg.files) assert.ok(existsSync(join(ROOT, entry)), `${entry} is missing`);
  for (const path of [".claude-plugin/", ".mcp.json", "plugin.json", "mcp.json", "skills/", "LICENSE"]) assert.ok(pkg.files.includes(path), `${path} is not in files`);
});

test("skills have portable frontmatter that matches the folder name", () => {
  assert.deepEqual(SKILLS.toSorted(), ["apupod", "apupod-hosts", "apupod-plan", "apupod-script"]);
  for (const name of SKILLS) {
    const frontmatter = read(`skills/${name}/SKILL.md`).match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    assert.ok(frontmatter, `${name} has no frontmatter`);
    const fields = Object.fromEntries(frontmatter.split("\n").map((line) => line.match(/^([a-z-]+):\s*(.*)$/).slice(1)));
    assert.deepEqual(Object.keys(fields), ["name", "description"], name);
    assert.equal(fields.name, name);
    assert.ok(fields.description.length > 20 && fields.description.length <= 1024, name);
  }
});

test("skills name only tools that exist, and the README tool table lists every tool", () => {
  for (const name of SKILLS) {
    for (const ref of toolRefs(read(`skills/${name}/SKILL.md`))) assert.ok(TOOLS.has(ref), `skills/${name} names unknown tool ${ref}`);
  }
  const readme = read("README.md");
  const table = new Set([...readme.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]));
  assert.deepEqual([...table].toSorted(), [...TOOLS].toSorted());
});
