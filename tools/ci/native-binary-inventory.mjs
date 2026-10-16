#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOTS = [
  "/app",
  "/usr/local/bin",
  "/usr/local/lib",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/usr/lib64",
  "/usr/lib32",
  "/lib",
  "/lib64",
];

const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 250_000,
  maxFiles: 10_000,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxDepth: 64,
});

const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const IMAGE_CONFIG_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const MACH_O_MAGICS = new Set([
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
]);
const ARCHIVE_MAGIC = Buffer.from("!<arch>\n", "ascii");
const PE_MAGIC = Buffer.from([0x50, 0x45, 0x00, 0x00]);
const HASH_CHUNK_BYTES = 1024 * 1024;

export class NativeInventoryLimitError extends Error {
  constructor(limit, message) {
    super(message);
    this.name = "NativeInventoryLimitError";
    this.limit = limit;
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isWithinRoot(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function validateLimit(name, value, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
}

function resolveRoots(requestedRoots) {
  if (!Array.isArray(requestedRoots)) throw new TypeError("roots must be an array of directory paths");

  const canonicalRoots = new Set();
  const missingRoots = new Set();
  for (const requestedRoot of requestedRoots) {
    if (typeof requestedRoot !== "string" || requestedRoot.length === 0) {
      throw new TypeError("each root must be a non-empty path string");
    }

    const absoluteRoot = path.resolve(requestedRoot);
    try {
      // A configured root is an explicit trust boundary. Resolve it once, then skip all
      // symlinks found beneath it so traversal cannot escape that boundary.
      const canonicalRoot = realpathSync.native(absoluteRoot);
      const rootStat = lstatSync(canonicalRoot);
      if (!rootStat.isDirectory()) throw new Error(`inventory root is not a directory: ${absoluteRoot}`);
      canonicalRoots.add(path.resolve(canonicalRoot));
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        missingRoots.add(normalizePath(absoluteRoot));
        continue;
      }
      throw error;
    }
  }

  return {
    roots: [...canonicalRoots].sort(compareText),
    missingRoots: [...missingRoots].sort(compareText),
  };
}

function extensionKind(fileName) {
  if (/\.node$/iu.test(fileName)) return "node-addon";
  if (/\.so(?:\.\d+)*$/iu.test(fileName)) return "shared-library";
  if (/\.dll$/iu.test(fileName)) return "windows-dll";
  if (/\.dylib$/iu.test(fileName)) return "macos-dylib";
  if (/\.exe$/iu.test(fileName)) return "windows-executable";
  if (/\.pyd$/iu.test(fileName)) return "python-extension";
  if (/\.bundle$/iu.test(fileName)) return "native-bundle";
  return null;
}

function readAt(descriptor, position, length) {
  const buffer = Buffer.alloc(length);
  const bytesRead = readSync(descriptor, buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

function detectBinaryKind(descriptor, header, fileSize, fileName) {
  if (header.length >= ELF_MAGIC.length && header.subarray(0, 4).equals(ELF_MAGIC)) return "elf";
  if (header.length >= 4 && MACH_O_MAGICS.has(header.subarray(0, 4).toString("hex"))) return "macho";
  if (header.length >= ARCHIVE_MAGIC.length && header.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)) {
    return "native-archive";
  }

  if (header.length >= 64 && header[0] === 0x4d && header[1] === 0x5a) {
    const peOffset = header.readUInt32LE(0x3c);
    // Bound the secondary header read so malformed DOS headers cannot induce arbitrary reads.
    if (peOffset >= 64 && peOffset <= 1024 * 1024 && BigInt(peOffset) + 4n <= fileSize) {
      if (readAt(descriptor, peOffset, 4).equals(PE_MAGIC)) return "pe";
    }
  }

  return extensionKind(fileName);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchangedDuringRead(before, after) {
  return before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function hashCandidate(filePath, inventoryPath, expectedStat, limits, currentTotalBytes, currentFileCount) {
  const openFlags = constants.O_RDONLY |
    (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0) |
    (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0);
  const descriptor = openSync(filePath, openFlags);

  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !sameFileIdentity(expectedStat, before)) {
      throw new Error(`file identity changed before inventory read: ${normalizePath(inventoryPath)}`);
    }

    const header = readAt(descriptor, 0, 64);
    const kind = detectBinaryKind(descriptor, header, before.size, path.basename(filePath));
    if (!kind) return null;
    if (currentFileCount >= limits.maxFiles) {
      throw new NativeInventoryLimitError("maxFiles", "native inventory exceeds maxFiles");
    }

    if (before.size > BigInt(limits.maxFileBytes)) {
      throw new NativeInventoryLimitError(
        "maxFileBytes",
        `native file exceeds maxFileBytes: ${normalizePath(inventoryPath)}`,
      );
    }
    if (currentTotalBytes + Number(before.size) > limits.maxTotalBytes) {
      throw new NativeInventoryLimitError(
        "maxTotalBytes",
        `native inventory exceeds maxTotalBytes at ${normalizePath(inventoryPath)}`,
      );
    }

    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let byteCount = 0;
    let position = 0;
    while (true) {
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      byteCount += bytesRead;
      if (byteCount > limits.maxFileBytes || currentTotalBytes + byteCount > limits.maxTotalBytes) {
        throw new NativeInventoryLimitError(
          byteCount > limits.maxFileBytes ? "maxFileBytes" : "maxTotalBytes",
          `native inventory byte limit exceeded while reading ${normalizePath(inventoryPath)}`,
        );
      }
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }

    const after = fstatSync(descriptor, { bigint: true });
    if (!unchangedDuringRead(before, after) || BigInt(byteCount) !== before.size) {
      throw new Error(`file changed during inventory read: ${normalizePath(inventoryPath)}`);
    }

    return {
      path: normalizePath(inventoryPath),
      sha256: hash.digest("hex"),
      bytes: byteCount,
      kind,
    };
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Collect stable file identities for native runtime candidates below explicit roots.
 * Symlink entries are skipped. The result is an identity inventory only, not license clearance.
 */
export function collectNativeBinaryInventory(requestedRoots, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object of inventory limits");
  }
  for (const optionName of Object.keys(options)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, optionName)) throw new TypeError(`unsupported inventory option: ${optionName}`);
  }
  const limits = {
    maxEntries: options.maxEntries ?? DEFAULT_LIMITS.maxEntries,
    maxFiles: options.maxFiles ?? DEFAULT_LIMITS.maxFiles,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes,
    maxDepth: options.maxDepth ?? DEFAULT_LIMITS.maxDepth,
  };
  validateLimit("maxEntries", limits.maxEntries);
  validateLimit("maxFiles", limits.maxFiles, true);
  validateLimit("maxFileBytes", limits.maxFileBytes, true);
  validateLimit("maxTotalBytes", limits.maxTotalBytes, true);
  validateLimit("maxDepth", limits.maxDepth);

  const { roots, missingRoots } = resolveRoots(requestedRoots);
  const files = [];
  const seenFiles = new Set();
  const seenDirectories = new Set();
  const pending = roots.map((directory) => ({ directory, depth: 0 }));
  let entriesVisited = 0;
  let directoriesVisited = 0;
  let skippedSymlinkCount = 0;
  let totalBytes = 0;

  while (pending.length > 0) {
    const { directory, depth } = pending.pop();
    const canonicalDirectory = realpathSync.native(directory);
    if (!roots.some((root) => isWithinRoot(canonicalDirectory, root))) {
      throw new Error(`directory escaped configured roots: ${normalizePath(directory)}`);
    }
    if (canonicalDirectory !== path.resolve(directory)) {
      skippedSymlinkCount += 1;
      continue;
    }
    if (seenDirectories.has(canonicalDirectory)) continue;
    seenDirectories.add(canonicalDirectory);
    directoriesVisited += 1;

    const entries = readdirSync(canonicalDirectory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      entriesVisited += 1;
      if (entriesVisited > limits.maxEntries) {
        throw new NativeInventoryLimitError("maxEntries", "native inventory exceeds maxEntries");
      }

      const entryPath = path.join(canonicalDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        skippedSymlinkCount += 1;
        continue;
      }

      const entryStat = lstatSync(entryPath, { bigint: true });
      if (entryStat.isSymbolicLink()) {
        skippedSymlinkCount += 1;
        continue;
      }

      if (entryStat.isDirectory()) {
        if (depth >= limits.maxDepth) {
          throw new NativeInventoryLimitError(
            "maxDepth",
            `native inventory exceeds maxDepth at ${normalizePath(entryPath)}`,
          );
        }
        pending.push({ directory: entryPath, depth: depth + 1 });
        continue;
      }

      if (!entryStat.isFile()) continue;
      const canonicalFile = realpathSync.native(entryPath);
      if (!roots.some((root) => isWithinRoot(canonicalFile, root))) {
        throw new Error(`file escaped configured roots: ${normalizePath(entryPath)}`);
      }
      if (canonicalFile !== path.resolve(entryPath)) {
        skippedSymlinkCount += 1;
        continue;
      }
      if (seenFiles.has(canonicalFile)) continue;

      const record = hashCandidate(entryPath, canonicalFile, entryStat, limits, totalBytes, files.length);
      if (!record) continue;
      seenFiles.add(canonicalFile);
      totalBytes += record.bytes;
      files.push(record);
    }
  }

  files.sort((left, right) => compareText(left.path, right.path));
  return {
    roots,
    missingRoots,
    limits: { ...limits },
    entriesVisited,
    directoriesVisited,
    skippedSymlinkCount,
    totalBytes,
    files,
  };
}

function readIdentityMetadata(environment) {
  const candidateSha = environment.NATIVE_CANDIDATE_SHA ?? "";
  const imageConfigDigest = environment.NATIVE_IMAGE_CONFIG_DIGEST ?? "";
  if (!COMMIT_SHA.test(candidateSha)) {
    throw new Error("NATIVE_CANDIDATE_SHA must be a full lowercase 40-character commit SHA");
  }
  if (!IMAGE_CONFIG_DIGEST.test(imageConfigDigest)) {
    throw new Error("NATIVE_IMAGE_CONFIG_DIGEST must be sha256 followed by 64 lowercase hex characters");
  }
  return { candidateSha, imageConfigDigest };
}

function isDirectExecution() {
  const entryPoint = process.argv[1];
  return entryPoint === "-" || (entryPoint && pathToFileURL(path.resolve(entryPoint)).href === import.meta.url);
}

function runCli() {
  const { candidateSha, imageConfigDigest } = readIdentityMetadata(process.env);
  const inventory = collectNativeBinaryInventory(DEFAULT_ROOTS);
  const report = {
    kind: "eqoboard-native-binary-inventory",
    schemaVersion: 1,
    candidateSha,
    imageConfigDigest,
    licenseClosure: "NOT_CLAIMED",
    symlinkPolicy: "SKIP_ALL_SYMLINK_ENTRIES",
    ...inventory,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (isDirectExecution()) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`native-binary-inventory: ${error.message}\n`);
    process.exitCode = 1;
  }
}
