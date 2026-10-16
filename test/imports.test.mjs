import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const modules = (await readdir(SRC, { recursive: true }))
  .filter((file) => file.endsWith(".mjs"))
  .map((file) => join(SRC, file));

test("every src module imports cleanly", async () => {
  for (const file of modules) await import(pathToFileURL(file).href);
});

test("src import graph has no cycles", async () => {
  const graph = new Map();
  for (const file of modules) {
    const source = await readFile(file, "utf8");
    const deps = [...source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+"(\.{1,2}\/[^"]+)"/gm)]
      .map((match) => resolve(dirname(file), match[1]));
    graph.set(file, deps);
  }
  const state = new Map();
  const visit = (file, path) => {
    if (state.get(file) === "done") return;
    assert.notEqual(state.get(file), "active", `import cycle: ${[...path, file].map((f) => relative(SRC, f)).join(" -> ")}`);
    state.set(file, "active");
    for (const dep of graph.get(file) || []) visit(dep, [...path, file]);
    state.set(file, "done");
  };
  for (const file of modules) visit(file, []);
});
