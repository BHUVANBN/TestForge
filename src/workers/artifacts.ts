import fs from 'fs/promises';
import path from 'path';
import { Artifact } from '../utils/types';

export interface ArtifactLimits {
  maxBytes: number;
  maxFiles: number;
}

export interface CollectedArtifacts {
  artifacts: Artifact[];
  truncated: boolean;
}

/** Normalize an archive/file path into a safe relative artifact name, or null to skip it. */
export function safeArtifactName(raw: string): string | null {
  const parts = raw
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.');
  if (parts.length === 0 || parts.some((p) => p === '..')) return null;
  const name = parts.join('/');
  if (name.length > 255 || [...name].some((c) => c.charCodeAt(0) < 0x20)) return null;
  return name;
}

class Collector {
  readonly artifacts: Artifact[] = [];
  truncated = false;
  private bytes = 0;

  constructor(private readonly limits: ArtifactLimits) {}

  /** Returns false once limits are reached. */
  add(name: string, data: Buffer): boolean {
    if (this.artifacts.length >= this.limits.maxFiles || this.bytes + data.length > this.limits.maxBytes) {
      this.truncated = true;
      return this.artifacts.length < this.limits.maxFiles;
    }
    this.bytes += data.length;
    this.artifacts.push({ name, data });
    return true;
  }
}

/** Read regular files under `dir` (symlinks are ignored, never followed). */
export async function collectFromDirectory(dir: string, limits: ArtifactLimits): Promise<CollectedArtifacts> {
  const collector = new Collector(limits);
  if (limits.maxFiles === 0) return { artifacts: [], truncated: false };

  const walk = async (current: string): Promise<boolean> => {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return true;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!(await walk(full))) return false;
      } else if (entry.isFile()) {
        const name = safeArtifactName(path.relative(dir, full));
        if (!name) continue;
        const stat = await fs.lstat(full);
        if (!stat.isFile()) continue;
        if (stat.size > limits.maxBytes) {
          collector.truncated = true;
          continue;
        }
        if (!collector.add(name, await fs.readFile(full))) return false;
      }
    }
    return true;
  };

  await walk(dir);
  return { artifacts: collector.artifacts, truncated: collector.truncated };
}

/**
 * Minimal tar reader (ustar + GNU long names + pax path) for `docker cp`-style
 * archives. Only regular files are returned; the leading directory is stripped.
 */
export function extractTar(buf: Buffer, limits: ArtifactLimits, stripPrefix = 'artifacts/'): CollectedArtifacts {
  const collector = new Collector(limits);
  let offset = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;

  const field = (start: number, len: number) => buf.toString('utf8', start, start + len).replace(/\0[\s\S]*$/, '');

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const sizeField = field(offset + 124, 12).trim();
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = field(offset + 345, 155);
    let name = field(offset, 100);
    if (prefix) name = `${prefix}/${name}`;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) {
      collector.truncated = true; // archive was cut short by the size cap
      break;
    }
    const data = buf.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'x') {
      const m = data.toString('utf8').match(/\d+ path=([^\n]*)\n/);
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === 'g') continue;

    const fullName = paxPath ?? longName ?? name;
    paxPath = null;
    longName = null;
    if (type !== '0' && type !== '\0') continue; // directories, links, devices…

    const relative = fullName.startsWith(stripPrefix) ? fullName.slice(stripPrefix.length) : fullName;
    const safe = safeArtifactName(relative);
    if (!safe) continue;
    if (!collector.add(safe, Buffer.from(data))) break;
  }
  return { artifacts: collector.artifacts, truncated: collector.truncated };
}

/** Read a stream into memory, stopping (and reporting truncation) past `maxBytes`. */
export async function readStreamCapped(
  stream: NodeJS.ReadableStream,
  maxBytes: number
): Promise<{ data: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => {
      if (truncated) return;
      size += chunk.length;
      if (size > maxBytes) {
        truncated = true;
        chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
        (stream as any).destroy?.();
        resolve();
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve());
    stream.on('close', () => resolve());
    stream.on('error', (err) => (truncated ? resolve() : reject(err)));
  });
  return { data: Buffer.concat(chunks), truncated };
}
