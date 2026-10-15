const PERMISSIVE_LICENSES = new Set([
  "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense",
  "CC0-1.0", "CC-BY-4.0", "Python-2.0", "BlueOak-1.0.0", "Zlib", "WTFPL",
]);

const RUNTIME_EXCLUDED_LICENSES = new Set([
  ...PERMISSIVE_LICENSES,
  "LGPL-3.0-or-later",
  "MPL-2.0",
]);

const IDENTIFIER = /^(?:DocumentRef-[A-Za-z0-9.-]+:)?(?:LicenseRef-[A-Za-z0-9.-]+|[A-Za-z0-9][A-Za-z0-9.-]*)(?:\+)?$/u;

function tokenize(expression) {
  if (typeof expression !== "string" || expression.length === 0 || expression.length > 256) return null;
  const tokens = [];
  let offset = 0;
  while (offset < expression.length) {
    if (/\s/u.test(expression[offset])) {
      offset += 1;
      continue;
    }
    if (expression[offset] === "(" || expression[offset] === ")") {
      tokens.push(expression[offset]);
      offset += 1;
      continue;
    }
    const match = expression.slice(offset).match(/^(?:DocumentRef-[A-Za-z0-9.-]+:)?(?:LicenseRef-[A-Za-z0-9.-]+|[A-Za-z0-9][A-Za-z0-9.-]*)(?:\+)?/u);
    if (!match) return null;
    tokens.push(match[0]);
    offset += match[0].length;
  }
  return tokens.length === 0 ? null : tokens;
}

/** Parse the SPDX expression grammar and return a small syntax tree, or null. */
export function parseSpdxExpression(expression) {
  const tokens = tokenize(expression);
  if (!tokens) return null;
  let cursor = 0;

  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];
  const isIdentifier = (token) => typeof token === "string" && IDENTIFIER.test(token) && !["AND", "OR", "WITH"].includes(token);

  function primary() {
    if (peek() === "(") {
      take();
      const nested = disjunction();
      if (take() !== ")") throw new SyntaxError("missing closing parenthesis");
      return nested;
    }
    const token = peek();
    if (!isIdentifier(token)) throw new SyntaxError("expected a license identifier");
    take();
    return { type: "license", id: token };
  }

  function withException() {
    let node = primary();
    if (peek() === "WITH") {
      if (node.type !== "license") throw new SyntaxError("WITH must follow one license identifier");
      take();
      const exception = peek();
      if (!isIdentifier(exception) || exception.endsWith("+")) throw new SyntaxError("expected an exception identifier");
      take();
      node = { type: "with", license: node, exception };
    }
    return node;
  }

  function conjunction() {
    const terms = [withException()];
    while (peek() === "AND") {
      take();
      terms.push(withException());
    }
    return terms.length === 1 ? terms[0] : { type: "and", terms };
  }

  function disjunction() {
    const terms = [conjunction()];
    while (peek() === "OR") {
      take();
      terms.push(conjunction());
    }
    return terms.length === 1 ? terms[0] : { type: "or", terms };
  }

  try {
    const tree = disjunction();
    return cursor === tokens.length ? tree : null;
  } catch {
    return null;
  }
}

function collectIdentifiers(node, result = []) {
  if (node.type === "license") result.push(node.id);
  else if (node.type === "with") {
    result.push(node.license.id, node.exception);
  } else {
    for (const term of node.terms) collectIdentifiers(term, result);
  }
  return result;
}

function containsWithException(node) {
  return node.type === "with" || (node.type !== "license" && node.terms.some(containsWithException));
}

export function isPermissiveSpdxExpression(expression) {
  const tree = parseSpdxExpression(expression);
  return tree !== null && !containsWithException(tree) && collectIdentifiers(tree).every((id) => PERMISSIVE_LICENSES.has(id));
}

export function isKnownRuntimeExcludedSpdxExpression(expression) {
  const tree = parseSpdxExpression(expression);
  return tree !== null && !containsWithException(tree) && collectIdentifiers(tree).every((id) => RUNTIME_EXCLUDED_LICENSES.has(id));
}

export function packageNameFromLockPath(relativePath) {
  if (typeof relativePath !== "string") return null;
  const parts = relativePath.split("/");
  const index = parts.lastIndexOf("node_modules");
  if (index < 0 || index + 1 >= parts.length) return null;
  if (parts[index + 1].startsWith("@")) {
    if (index + 2 >= parts.length) return null;
    return `${parts[index + 1]}/${parts[index + 2]}`;
  }
  return parts[index + 1];
}

export function isRuntimeExcludedPackageName(name) {
  return name === "sharp" || name.startsWith("@img/sharp-") || name === "lightningcss" || name.startsWith("lightningcss-");
}

export function compareRuntimeExcludedInventory(lockPackages, entries) {
  const failures = [];
  const inventoryByPath = new Map();
  const lockedRuntimeExcludedPaths = new Set();

  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || inventoryByPath.has(entry.path)) {
      failures.push({ path: entry?.path ?? "inventory", reason: "invalid or duplicate inventory path" });
      continue;
    }
    inventoryByPath.set(entry.path, entry);
  }

  for (const [relative, metadata] of Object.entries(lockPackages ?? {})) {
    const name = packageNameFromLockPath(relative);
    if (!isRuntimeExcludedPackageName(name ?? "")) continue;
    lockedRuntimeExcludedPaths.add(relative);
    const reviewed = inventoryByPath.get(relative);
    if (!reviewed) {
      failures.push({ path: relative, reason: "runtime-excluded package missing from pinned inventory" });
      continue;
    }
    const scope = name === "sharp" || name.startsWith("@img/sharp-")
      ? "disabled-optional-image-optimizer"
      : "build-only-css-transform";
    const exact = reviewed.path === relative && reviewed.name === name &&
      reviewed.version === metadata.version && reviewed.integrity === metadata.integrity &&
      reviewed.licenseExpression === metadata.license && reviewed.scope === scope;
    if (!exact) {
      failures.push({
        path: relative,
        reason: "runtime-excluded inventory differs from lock metadata",
        expected: { name, version: metadata.version, integrity: metadata.integrity, licenseExpression: metadata.license, scope },
        actual: reviewed,
      });
    }
  }

  for (const relative of inventoryByPath.keys()) {
    if (!lockedRuntimeExcludedPaths.has(relative)) failures.push({ path: relative, reason: "stale inventory entry is absent from the locked package graph" });
  }

  return { inventoryByPath, lockedRuntimeExcludedPaths, failures };
}
