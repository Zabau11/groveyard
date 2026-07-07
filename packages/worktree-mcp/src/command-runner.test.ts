import assert from "node:assert/strict";
import test from "node:test";

import { UnsafeCommandError, parseCommand } from "./command-runner.js";

test("parseCommand supports simple quoted arguments", () => {
  assert.deepEqual(parseCommand("npm run test -- --name 'checkout button'"), ["npm", "run", "test", "--", "--name", "checkout button"]);
});

test("parseCommand rejects shell syntax", () => {
  assert.throws(() => parseCommand("npm test && rm -rf ."), UnsafeCommandError);
  assert.throws(() => parseCommand("echo $HOME"), UnsafeCommandError);
  assert.throws(() => parseCommand("npm test > output.txt"), UnsafeCommandError);
});
