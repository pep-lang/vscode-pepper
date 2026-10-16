const test = require("node:test");
const assert = require("node:assert");
const { suggestedInstall, isOlder, installerCommand } = require("./toolchain");

test("suggestedInstall reads the command pep-install suggests", () => {
  assert.deepStrictEqual(
    suggestedInstall("pep-install: toolchain 0.3 (pinned by /w/pep.toml) is not installed; install it with 'pepper install add 0.3'"),
    ["install", "add", "0.3"]
  );
  assert.deepStrictEqual(
    suggestedInstall("no toolchain is chosen here and there is no default; install one with 'pepper install update'"),
    ["install", "update"]
  );
  assert.strictEqual(suggestedInstall("pep.toml names 'x', not a version such as 0.3.0, 0.3 or latest"), null);
});

test("isOlder compares release numbers", () => {
  assert.strictEqual(isOlder("0.9.2", "0.9.3"), true);
  assert.strictEqual(isOlder("0.9.3", "0.9.3"), false);
  assert.strictEqual(isOlder("0.10.0", "0.9.3"), false);
  assert.strictEqual(isOlder("0.9.3-dev", "0.9.3"), false);
  assert.strictEqual(isOlder("dev", "0.9.3"), false);
});

test("installerCommand runs the platform's install script", () => {
  assert.match(installerCommand("win32").args.at(-1), /install\.ps1 \| iex$/);
  assert.match(installerCommand("darwin").args.at(-1), /install\.sh \| sh$/);
});
