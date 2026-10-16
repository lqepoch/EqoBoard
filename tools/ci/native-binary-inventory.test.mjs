import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectNativeBinaryInventory,
  NativeInventoryLimitError,
} from "./native-binary-inventory.mjs";

function withFixture(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "native-binary-inventory-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("inventory hashes native candidates, records format, and sorts paths", () => {
  withFixture((root) => {
    const libraryDirectory = path.join(root, "usr/lib");
    const executableDirectory = path.join(root, "usr/bin");
    mkdirSync(libraryDirectory, { recursive: true });
    mkdirSync(executableDirectory, { recursive: true });
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 1, 2, 3, 4]);
    const addon = Buffer.from("synthetic node addon bytes\n", "utf8");
    writeFileSync(path.join(executableDirectory, "helper"), elf);
    writeFileSync(path.join(libraryDirectory, "addon.node"), addon);

    const inventory = collectNativeBinaryInventory([root]);
    assert.deepEqual(inventory.files, [
      {
        path: path.join(executableDirectory, "helper").split(path.sep).join("/"),
        sha256: createHash("sha256").update(elf).digest("hex"),
        bytes: elf.byteLength,
        kind: "elf",
      },
      {
        path: path.join(libraryDirectory, "addon.node").split(path.sep).join("/"),
        sha256: createHash("sha256").update(addon).digest("hex"),
        bytes: addon.byteLength,
        kind: "node-addon",
      },
    ]);
    assert.equal(inventory.totalBytes, addon.byteLength + elf.byteLength);
    assert.equal(inventory.skippedSymlinkCount, 0);
  });
});

test("overlapping roots deduplicate file identities and preserve stable ordering", () => {
  withFixture((root) => {
    const nestedRoot = path.join(root, "app");
    mkdirSync(nestedRoot, { recursive: true });
    const first = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]);
    const second = Buffer.from("library", "utf8");
    writeFileSync(path.join(nestedRoot, "z-last.so.1"), second);
    writeFileSync(path.join(nestedRoot, "a-first.so"), first);

    const inventory = collectNativeBinaryInventory([nestedRoot, root]);
    assert.deepEqual(inventory.files.map((file) => file.path), [
      path.join(nestedRoot, "a-first.so").split(path.sep).join("/"),
      path.join(nestedRoot, "z-last.so.1").split(path.sep).join("/"),
    ]);
    assert.equal(inventory.files.length, 2);
    assert.equal(inventory.totalBytes, first.byteLength + second.byteLength);
  });
});

test("escaping file and directory symlinks are skipped without reading their targets", (t) => {
  withFixture((temporaryRoot) => {
    const scanRoot = path.join(temporaryRoot, "scan");
    const outsideRoot = path.join(temporaryRoot, "outside");
    mkdirSync(scanRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    const outsideFile = path.join(outsideRoot, "secret.node");
    const outsideNestedFile = path.join(outsideRoot, "nested-elf");
    writeFileSync(outsideFile, Buffer.from("outside addon", "utf8"));
    writeFileSync(outsideNestedFile, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2]));

    try {
      symlinkSync(outsideFile, path.join(scanRoot, "linked.node"), "file");
      symlinkSync(outsideRoot, path.join(scanRoot, "linked-directory"), "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(error.code)) {
        t.skip(`symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    const inventory = collectNativeBinaryInventory([scanRoot]);
    assert.deepEqual(inventory.files, []);
    assert.equal(inventory.skippedSymlinkCount, 2);
    assert.equal(inventory.totalBytes, 0);
  });
});

test("inventory fails closed when the native-byte budget is exceeded", () => {
  withFixture((root) => {
    const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]);
    writeFileSync(path.join(root, "candidate.so"), bytes);

    assert.throws(
      () => collectNativeBinaryInventory([root], { maxTotalBytes: bytes.byteLength - 1 }),
      (error) => error instanceof NativeInventoryLimitError && error.limit === "maxTotalBytes",
    );
  });
});

test("inventory fails closed before hashing beyond the native-file-count budget", () => {
  withFixture((root) => {
    writeFileSync(path.join(root, "candidate.so"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1]));

    assert.throws(
      () => collectNativeBinaryInventory([root], { maxFiles: 0 }),
      (error) => error instanceof NativeInventoryLimitError && error.limit === "maxFiles",
    );
  });
});
