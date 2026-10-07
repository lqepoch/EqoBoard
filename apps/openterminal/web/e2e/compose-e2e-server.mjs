import { spawn } from "node:child_process";

const children = [];
let stopping = false;

function start(command, args) {
  const child = spawn(command, args, { cwd: "/srv", stdio: "inherit", env: process.env });
  children.push(child);
  return child;
}

const mocks = start(process.execPath, ["/srv/e2e/mock-services.mjs"]);
for (let attempt = 0; attempt < 100; attempt += 1) {
  if (mocks.exitCode !== null) throw new Error(`offline mock exited with ${mocks.exitCode}`);
  try {
    const response = await fetch("http://127.0.0.1:4310/.well-known/openid-configuration");
    if (response.ok) break;
  } catch {
    // The mock service is still starting.
  }
  if (attempt === 99) throw new Error("offline mock did not become ready");
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const terminal = start("npm", ["run", "start", "--workspace", "web"]);
terminal.once("exit", (code) => {
  if (!stopping) void shutdown(code ?? 1);
});
mocks.once("exit", (code) => {
  if (!stopping) void shutdown(code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void shutdown(0, signal));
}

async function shutdown(code, signal) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal ?? "SIGTERM");
  }
  await Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", resolve);
  })));
  process.exitCode = code;
}
