import assert from "node:assert/strict";
import test from "node:test";
import { html } from "./helpers.mjs";

const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
const theme = css.match(/\[data-theme=["']honey-graphite["']\]\s*\{([^}]+)\}/)?.[1] || "";
const expected = {
  "--bg": "#1E1E1D", "--surface": "#282725", "--field": "#191918", "--interaction": "#37332A",
  "--text": "#E6E2D8", "--muted": "#B6AFA1", "--disabled": "#B6AFA1", "--border": "#444036",
  "--control": "#8E8470", "--reference": "#CBAA60", "--accent": "#CBAA60", "--error": "#CBAA60",
  "--success": "#CBAA60", "--selection": "#CBAA60", "--selection-ink": "#191918", "--action-ink": "#191918",
};
const tokens = Object.fromEntries([...theme.matchAll(/(--[\w-]+)\s*:\s*(#[\da-f]{6})\s*;/gi)].map(([, name, value]) => [name, value.toUpperCase()]));

function rules(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`(?:^|[{},])\\s*${escaped}(?=\\s*[,\\{])[^{}]*\\{([^{}]*)\\}`, "g"))].map((match) => match[1]).join("\n");
}

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map((value) => parseInt(value, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

function assertContrast(foreground, background, minimum) {
  const light = luminance(tokens[foreground]);
  const dark = luminance(tokens[background]);
  const ratio = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
  assert.ok(ratio >= minimum, `${foreground} on ${background}: ${ratio} must be >= ${minimum}`);
}

test("Honey Graphite is enabled on the owned root with exact, non-overridden tokens", () => {
  assert.match(html, /<html\b[^>]*\bdata-theme=["']honey-graphite["']/);
  assert.match(theme, /\bcolor-scheme\s*:\s*dark\s*;/);
  assert.doesNotMatch(css, /\bcolor-scheme\s*:[^;{}]*\blight\b/);
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(tokens[name], value, name);
    const declarations = [...css.matchAll(new RegExp(`${name}\\s*:\\s*([^;{}]+)`, "g"))];
    assert.ok(declarations.length > 0, `${name} is declared`);
    for (const declaration of declarations) assert.equal(declaration[1].trim().toUpperCase(), value, `${name} cannot be overridden`);
  }
});

test("Honey Graphite text, control, focus, selection, and action pairs meet contrast targets", () => {
  for (const surface of ["--bg", "--surface", "--field", "--interaction"]) {
    for (const text of ["--text", "--muted", "--disabled", "--reference", "--accent", "--error", "--success"]) assertContrast(text, surface, 4.5);
    assertContrast("--control", surface, 3);
    assertContrast("--accent", surface, 3);
  }
  assertContrast("--selection-ink", "--selection", 4.5);
  assertContrast("--action-ink", "--accent", 4.5);
});

test("selection and primary actions use dark ink, not content text", () => {
  const selection = rules("::selection");
  assert.match(selection, /\bcolor\s*:\s*var\(--selection-ink\)/);
  assert.match(selection, /\bbackground(?:-color)?\s*:\s*var\(--selection\)/);
  const primary = rules("button.primary");
  assert.match(primary, /\bcolor\s*:\s*var\(--(?:action-ink|text-on-accent)\)/);
  assert.match(primary, /\bbackground(?:-color)?\s*:\s*var\(--accent\)/);
  if (primary.includes("--text-on-accent")) assert.match(theme, /--text-on-accent\s*:\s*var\(--action-ink\)/);
});

test("placeholders and disabled controls remain readable without fading text", () => {
  for (const selector of ["input::placeholder", "textarea::placeholder"]) {
    const paint = rules(selector) || rules("::placeholder");
    assert.match(paint, /\bcolor\s*:\s*var\(--muted\)/, selector);
    assert.match(paint, /\bopacity\s*:\s*1\s*(?:;|$)/, selector);
  }
  for (const selector of ["button:disabled", "input:disabled", "select:disabled", "textarea:disabled", "option:disabled"]) {
    const paint = rules(selector);
    assert.match(paint, /\bcolor\s*:\s*var\(--disabled\)/, selector);
    assert.match(paint, /\bopacity\s*:\s*1\s*(?:;|$)/, selector);
    assert.doesNotMatch(paint, /\bopacity\s*:\s*(?:0?\.\d+|0)\s*(?:;|$)/, selector);
  }
  assert.doesNotMatch(rules(".muted"), /\bopacity\s*:\s*(?:0?\.\d+|0)\s*(?:;|$)/);
});

test("notification and job details do not clip keyboard focus while summaries keep ellipsis", () => {
  for (const selector of [".notice-item", ".job-item"]) {
    assert.doesNotMatch(rules(selector), /\boverflow(?:-[xy])?\s*:[^;{}]*\b(?:hidden|clip|auto|scroll)\b/, selector);
    const summary = rules(`${selector} summary`);
    assert.match(summary, /\boverflow\s*:\s*hidden\b/, selector);
    assert.match(summary, /\btext-overflow\s*:\s*ellipsis\b/, selector);
    assert.match(summary, /\bwhite-space\s*:\s*nowrap\b/, selector);
    assert.match(rules(`${selector} summary:focus-visible`), /\boutline-offset\s*:\s*-4px\b/, selector);
  }
});

test("owned CSS does not retain the previous bright palette or light fallback", () => {
  const palette = new Set(Object.values(expected));
  for (const [, property, value] of css.matchAll(/(?:^|[;{])\s*([\w-]+)\s*:\s*([^;{}]*)/g)) {
    for (const [, literal] of value.matchAll(/#([\da-f]{3,8})\b/gi)) {
      const hex = `#${literal.length === 3 ? [...literal].map((channel) => channel.repeat(2)).join("") : literal}`.toUpperCase();
      const shadow = /^(?:box|text)-shadow$/.test(property) && hex === "#000000";
      assert.ok(palette.has(hex) || shadow, `${property}: ${hex} is outside the Honey Graphite palette`);
    }
  }
  assert.doesNotMatch(css, /(?:color|background(?:-color)?)\s*:\s*(?:white|black)\b/i);
});
