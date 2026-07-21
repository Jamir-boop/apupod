#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const lockPath = join(root, 'package-lock.json');
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function relativePath(path) {
  return relative(root, path).replaceAll('\\', '/');
}

async function collectWrites(newVersion) {
  const writes = [];
  const pkgOriginal = await readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgOriginal);
  const currentVersion = pkg.version;

  if (pkg.version !== newVersion) {
    pkg.version = newVersion;
    writes.push({ path: pkgPath, content: `${JSON.stringify(pkg, null, 2)}\n`, original: pkgOriginal, from: currentVersion });
  }

  const lockOriginal = await readFile(lockPath, 'utf8');
  const lock = JSON.parse(lockOriginal);
  if (lock.version !== newVersion || lock.packages?.['']?.version !== newVersion) {
    const from = lock.version;
    lock.version = newVersion;
    if (lock.packages?.['']) lock.packages[''].version = newVersion;
    writes.push({ path: lockPath, content: `${JSON.stringify(lock, null, 2)}\n`, original: lockOriginal, from });
  }

  return { currentVersion, writes };
}

async function confirm(currentVersion, newVersion, writes) {
  console.log(`Current package: ${currentVersion}`);
  console.log(`New version:     ${newVersion}`);
  console.log('Files:');
  writes.forEach((write) => {
    console.log(`- ${relativePath(write.path)} (${write.from} -> ${newVersion})`);
  });

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question('Proceed? [y/N] ')).toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

export async function applyWrites(writes, write = writeFile) {
  const completed = [];
  try {
    for (const item of writes) {
      await write(item.path, item.content);
      completed.push(item);
    }
  } catch (error) {
    await Promise.allSettled(completed.map((item) => write(item.path, item.original)));
    throw error;
  }
}

async function main() {
  const newVersion = process.argv[2];
  if (!newVersion || !SEMVER_RE.test(newVersion)) {
    console.error('Usage: node scripts/update-version.mjs <semver>');
    console.error('Example: node scripts/update-version.mjs 1.2.3');
    process.exit(1);
  }

  const { currentVersion, writes } = await collectWrites(newVersion);
  if (!writes.length) {
    console.log(`Already at version ${newVersion}`);
    return;
  }

  if (!(await confirm(currentVersion, newVersion, writes))) {
    console.log('Aborted');
    process.exit(2);
  }

  await applyWrites(writes);
  console.log(`Updated ${writes.length} file(s) to ${newVersion}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Error:', error.message);
    process.exit(3);
  });
}
