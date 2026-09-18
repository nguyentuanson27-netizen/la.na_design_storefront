import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const HOST = "127.0.0.1";
const PORT = 3214;
const BASE_URL = `http://${HOST}:${PORT}`;
const APP_ROOT = process.cwd();
const NEXT_CLI = resolve(APP_ROOT, "node_modules/next/dist/bin/next");
const TRUSTED_CLIENT_IP = "203.0.113.44";

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return true;
  return Promise.race([
    once(child, "exit").then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  if (!(await waitForExit(child, 5_000))) {
    child.kill("SIGKILL");
    await waitForExit(child, 5_000);
  }
}

for (let attempt = 1; attempt <= 20; attempt += 1) {
  let output = "";
  const child = spawn(process.execPath, [NEXT_CLI, "dev", "--hostname", HOST, "--port", String(PORT)], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      BETTER_AUTH_URL: BASE_URL,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-12_000);
  });
  child.stderr?.on("data", (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-12_000);
  });

  try {
    let pageStatus = null;
    for (let poll = 0; poll < 160; poll += 1) {
      if (child.exitCode !== null) {
        throw new Error(`next dev exited early with ${child.exitCode}\n${output}`);
      }
      try {
        const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
        pageStatus = response.status;
        if (response.status < 500) break;
      } catch {}
      await delay(100);
    }
    if (pageStatus === null || pageStatus >= 500) {
      throw new Error(`homepage never became ready; last status=${pageStatus}\n${output}`);
    }

    const auth = await fetch(`${BASE_URL}/api/auth/get-session`, {
      redirect: "manual",
      headers: { "x-ci-client-ip": TRUSTED_CLIENT_IP },
    });
    console.log(`attempt=${attempt} page=${pageStatus} auth=${auth.status}`);

    if (auth.status !== 200) {
      throw new Error(
        `reproduced readiness race: homepage=${pageStatus}, auth=${auth.status}\n${output}`,
      );
    }
  } finally {
    await stop(child);
  }
}
