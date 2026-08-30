#!/usr/bin/env node

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(scriptsDirectory);
const currentFile = path.basename(fileURLToPath(import.meta.url));
const testFiles = readdirSync(scriptsDirectory, { withFileTypes: true })
  .filter(entry => entry.isFile() && /^test-dataops-.*\.mjs$/u.test(entry.name) && entry.name !== currentFile)
  .map(entry => entry.name)
  .sort((left, right) => left.localeCompare(right, "en"));

if (testFiles.length !== 23) {
  console.error(`Expected exactly 23 DataOps contract tests, found ${testFiles.length}.`);
  process.exit(1);
}

const failures = [];
for (const testFile of testFiles) {
  console.log(`\n[DataOps] ${testFile}`);
  const result = spawnSync(process.execPath, [path.join(scriptsDirectory, testFile)], {
    cwd: repositoryRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    console.error(result.error);
    failures.push({ testFile, status: "spawn-error" });
  } else if (result.status !== 0) {
    failures.push({ testFile, status: result.status ?? "signal" });
  }
}

if (failures.length > 0) {
  console.error(`\nDataOps suite failed: ${23 - failures.length}/23 passed.`);
  failures.forEach(failure => console.error(`- ${failure.testFile} (${failure.status})`));
  process.exit(1);
}

console.log("\nPASS DataOps complete contract suite: 23/23");
