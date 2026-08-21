import test from "node:test";
import assert from "node:assert/strict";

import { escapeRegex, normalizeBoolean } from "../routes/picking.js";

test("escapes user search text before building Mongo regexes", () => {
  assert.equal(escapeRegex("Mox (Ruby) [Foil]?"), "Mox \\(Ruby\\) \\[Foil\\]\\?");
  assert.equal(escapeRegex(".*"), "\\.\\*");
});

test("normalizes supported boolean query and body values", () => {
  assert.equal(normalizeBoolean(true), true);
  assert.equal(normalizeBoolean("1"), true);
  assert.equal(normalizeBoolean("true"), true);
  assert.equal(normalizeBoolean(false), false);
  assert.equal(normalizeBoolean("0"), false);
  assert.equal(normalizeBoolean("false"), false);
  assert.equal(normalizeBoolean("anything-else"), null);
});
