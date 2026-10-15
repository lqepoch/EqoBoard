import assert from "node:assert/strict";
import test from "node:test";
import {
  compareRuntimeExcludedInventory,
  isRuntimeExcludedPackageName,
  isKnownRuntimeExcludedSpdxExpression,
  isPermissiveSpdxExpression,
  packageNameFromLockPath,
  parseSpdxExpression,
} from "./native-license-policy.mjs";

test("SPDX parser accepts identifiers and operator precedence", () => {
  assert.deepEqual(parseSpdxExpression("MIT"), { type: "license", id: "MIT" });
  assert.ok(parseSpdxExpression("(MIT OR Apache-2.0) AND BSD-3-Clause"));
  assert.ok(parseSpdxExpression("GPL-2.0-only WITH Classpath-exception-2.0"));
  assert.ok(parseSpdxExpression("DocumentRef-vendor:LicenseRef-fonts"));
});

test("SPDX parser rejects malformed operators, identifiers, and grouping", () => {
  for (const expression of [
    "",
    "MIT OR",
    "MIT AND AND Apache-2.0",
    "MIT Apache-2.0",
    "(MIT OR Apache-2.0",
    "MIT WITH",
    "MIT WITH Exception+",
    "MIT OR # Apache-2.0",
  ]) assert.equal(parseSpdxExpression(expression), null, expression);
});

test("license policy fails closed outside permissive or explicitly known runtime-excluded IDs", () => {
  assert.equal(isPermissiveSpdxExpression("(MIT OR Apache-2.0) AND BSD-3-Clause"), true);
  assert.equal(isPermissiveSpdxExpression("MIT OR GPL-3.0-only"), false);
  assert.equal(isPermissiveSpdxExpression("Not-A-Real-License"), false);
  assert.equal(isPermissiveSpdxExpression("MIT WITH MIT"), false);
  assert.equal(isPermissiveSpdxExpression("MIT WITH Classpath-exception-2.0"), false);
  assert.equal(isKnownRuntimeExcludedSpdxExpression("Apache-2.0 AND LGPL-3.0-or-later AND MIT"), true);
  assert.equal(isKnownRuntimeExcludedSpdxExpression("MPL-2.0"), true);
  assert.equal(isKnownRuntimeExcludedSpdxExpression("LGPL-3.0-or-later WITH MIT"), false);
  assert.equal(isKnownRuntimeExcludedSpdxExpression("GPL-3.0-only"), false);
});

test("lock path parsing and runtime-excluded package family matching stay narrow", () => {
  assert.equal(packageNameFromLockPath("node_modules/sharp"), "sharp");
  assert.equal(packageNameFromLockPath("node_modules/next/node_modules/@img/sharp-linux-x64"), "@img/sharp-linux-x64");
  assert.equal(packageNameFromLockPath("node_modules/@img"), null);
  assert.equal(isRuntimeExcludedPackageName("@img/sharp-libvips-linux-x64"), true);
  assert.equal(isRuntimeExcludedPackageName("lightningcss-linux-x64-gnu"), true);
  assert.equal(isRuntimeExcludedPackageName("@img/not-sharp"), false);
  assert.equal(isRuntimeExcludedPackageName("next"), false);
});

test("runtime-exclusion inventory must exactly match lock path, version, bytes, license, and scope", () => {
  const lock = {
    "node_modules/sharp": {
      version: "0.35.5",
      integrity: "sha512-sharpbytes",
      license: "Apache-2.0",
    },
  };
  const inventory = [{
    path: "node_modules/sharp",
    name: "sharp",
    version: "0.35.5",
    integrity: "sha512-sharpbytes",
    licenseExpression: "Apache-2.0",
    scope: "disabled-optional-image-optimizer",
  }];

  assert.deepEqual(compareRuntimeExcludedInventory(lock, inventory).failures, []);
  assert.match(compareRuntimeExcludedInventory(lock, []).failures[0].reason, /missing from pinned inventory/u);
  assert.match(compareRuntimeExcludedInventory(lock, [{ ...inventory[0], integrity: "sha512-changed" }]).failures[0].reason, /differs from lock/u);
  assert.match(compareRuntimeExcludedInventory(lock, [...inventory, { ...inventory[0], path: "node_modules/old-sharp" }]).failures[0].reason, /stale inventory/u);
});
