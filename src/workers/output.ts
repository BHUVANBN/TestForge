import { StringDecoder } from 'string_decoder';
import { OutputListener } from '../utils/types';

const TRUNCATION_NOTICE = '\n[testforge] output truncated: limit reached\n';

/**
 * Collects stdout/stderr up to a byte budget shared by both streams,
 * decoding UTF-8 safely across chunk boundaries.
 */
export class OutputCollector {
  private readonly chunks = { stdout: [] as string[], stderr: [] as string[] };
  private readonly decoders = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };
  private bytes = 0;
  private _truncated = false;

  constructor(
    private readonly maxBytes: number,
    private readonly listener?: OutputListener
  ) {}

  push(stream: 'stdout' | 'stderr', data: Buffer | string): void {
    if (this._truncated) return;
    let buf = typeof data === 'string' ? Buffer.from(data) : data;
    const remaining = this.maxBytes - this.bytes;
    if (buf.length > remaining) {
      buf = buf.subarray(0, Math.max(0, remaining));
      this._truncated = true;
    }
    this.bytes += buf.length;
    let text = this.decoders[stream].write(buf);
    if (this._truncated) text += this.decoders[stream].end() + TRUNCATION_NOTICE;
    if (text) {
      this.chunks[stream].push(text);
      this.listener?.(stream, text);
    }
  }

  /** Flush any partial multi-byte sequences. Call once the process has exited. */
  finish(): void {
    if (this._truncated) return;
    for (const stream of ['stdout', 'stderr'] as const) {
      const rest = this.decoders[stream].end();
      if (rest) this.chunks[stream].push(rest);
    }
  }

  get truncated(): boolean {
    return this._truncated;
  }

  get stdout(): string {
    return this.chunks.stdout.join('');
  }

  get stderr(): string {
    return this.chunks.stderr.join('');
  }
}
