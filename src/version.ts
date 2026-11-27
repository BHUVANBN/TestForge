import fs from 'fs';
import path from 'path';

function readVersion(): string {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  // Works from both src/ (ts-node) and dist/ (compiled).
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, candidate), 'utf8'));
      if (pkg.version) return pkg.version as string;
    } catch {
      /* try next */
    }
  }
  return '0.0.0';
}

export const VERSION = readVersion();
