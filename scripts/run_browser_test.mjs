import { existsSync, readdirSync, symlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , script, ...args] = process.argv;
if (!script) {
  console.error('Usage: node scripts/run_browser_test.mjs <browser-test-script> [args...]');
  process.exit(2);
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localLibraryDirectories = [
  join(repositoryRoot, '.browser-libs', 'usr', 'lib', 'x86_64-linux-gnu'),
  join(repositoryRoot, '.browser-libs', 'lib', 'x86_64-linux-gnu'),
].filter((directory) => existsSync(directory));
const configuredDirectories = process.env.TRACEFAB_BROWSER_LIB_DIR
  ? process.env.TRACEFAB_BROWSER_LIB_DIR.split(':').filter(Boolean)
  : [];
function ensureLibraryAliases(directory) {
  for (const entry of readdirSync(directory)) {
    const match = entry.match(/^(.*\.so\.\d+)(?:\..+)$/);
    if (!match) continue;
    const alias = join(directory, match[1]);
    if (existsSync(alias)) continue;
    try {
      symlinkSync(entry, alias);
    } catch {
      // A concurrent test process may have created the alias already.
    }
  }
}

for (const directory of localLibraryDirectories) ensureLibraryAliases(directory);
const libraryDirectories = [...configuredDirectories, ...localLibraryDirectories];
const existingLibraryPath = process.env.LD_LIBRARY_PATH?.trim();
const env = {
  ...process.env,
  ...(libraryDirectories.length
    ? { LD_LIBRARY_PATH: [...libraryDirectories, existingLibraryPath].filter(Boolean).join(':') }
    : {}),
};

const child = spawn(process.execPath, [resolve(repositoryRoot, script), ...args], {
  cwd: repositoryRoot,
  env,
  stdio: 'inherit',
});
child.on('error', (error) => {
  console.error(`Unable to start browser test: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Browser test terminated by ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
