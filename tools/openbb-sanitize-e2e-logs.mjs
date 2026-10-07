import { readFile, writeFile } from "node:fs/promises";

const [inputPath, outputPath, envPath] = process.argv.slice(2);
if (!inputPath || !outputPath || !envPath) {
  throw new Error("usage: openbb-sanitize-e2e-logs.mjs INPUT OUTPUT ENV_FILE");
}

const envText = await readFile(envPath, "utf8");
const sensitiveValues = envText
  .split(/\r?\n/)
  .flatMap((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || !/(?:_SECRET|_TOKEN|_PASSWORD|_API_KEY|_KEY)$/.test(match[1])) return [];
    return match[2] ? [match[2]] : [];
  })
  .sort((left, right) => right.length - left.length);

let logText = await readFile(inputPath, "utf8");
for (const value of sensitiveValues) {
  logText = logText.replaceAll(value, "[redacted]");
}
logText = logText
  .replace(/([?&](?:code|state|token|access_token|refresh_token|id_token|client_secret|secret|password|api_key)=)[^&#\s"']+/gi, "$1[redacted]")
  .replace(/((?:authorization|cookie|set-cookie)\s*['"]?\s*[:=]\s*['"]?)[^,'"}\r\n]+/gi, "$1[redacted]")
  .replace(/(["']?(?:access_token|refresh_token|id_token|client_secret|password|api_key|secret|token|code|state)["']?\s*:\s*["'])[^"']+(["'])/gi, "$1[redacted]$2");

await writeFile(outputPath, logText, { mode: 0o600 });
