import { Artifact, TestFailure, TestReport } from '../utils/types';

const MAX_FAILURES = 50;
const MAX_MESSAGE = 2000;
const MAX_PARSE_BYTES = 5 * 1024 * 1024;

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[m[1]] = decodeXml(m[3] ?? m[4] ?? '');
  }
  return out;
}

const clip = (s: string | undefined) => {
  if (!s) return undefined;
  const t = s.trim();
  return t.length > MAX_MESSAGE ? `${t.slice(0, MAX_MESSAGE)}…` : t || undefined;
};

/** Parse JUnit/xUnit XML (pytest, Jest-junit, Maven Surefire, Go's go-junit-report, …). */
export function parseJUnit(xml: string, source = 'junit.xml'): TestReport | null {
  if (xml.length > MAX_PARSE_BYTES || !/<testcase\b/.test(xml)) return null;
  const report: TestReport = { format: 'junit', total: 0, passed: 0, failed: 0, skipped: 0, failures: [], sources: [source] };
  let seconds = 0;

  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase\s*>)/g)) {
    const a = attrs(m[1]);
    const body = m[2] ?? '';
    report.total++;
    if (a.time && Number.isFinite(Number(a.time))) seconds += Number(a.time);

    const failure = body.match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/);
    if (failure) {
      report.failed++;
      if (report.failures.length < MAX_FAILURES) {
        const fa = attrs(failure[2]);
        const f: TestFailure = { name: a.name ?? '(unnamed)' };
        if (a.classname) f.classname = a.classname;
        const message = clip(fa.message ?? decodeXml(failure[3] ?? ''));
        if (message) f.message = message;
        report.failures.push(f);
      }
    } else if (/<skipped\b/.test(body)) {
      report.skipped++;
    } else {
      report.passed++;
    }
  }
  if (report.total === 0) return null;
  if (seconds > 0) report.durationMs = Math.round(seconds * 1000);
  return report;
}

/** Parse TAP (Test Anything Protocol) from a job's stdout. */
export function parseTap(text: string): TestReport | null {
  if (text.length > MAX_PARSE_BYTES) return null;
  const lines = text.split(/\r?\n/);
  const hasHeader = lines.some((l) => /^TAP version \d+/.test(l) || /^1\.\.\d+/.test(l.trim()));
  if (!hasHeader) return null;

  const report: TestReport = { format: 'tap', total: 0, passed: 0, failed: 0, skipped: 0, failures: [], sources: ['stdout'] };
  for (let i = 0; i < lines.length; i++) {
    // Only top-level test points (indented lines are subtests in TAP 13/14).
    const m = lines[i].match(/^(not )?ok\b(?:\s+(\d+))?(?:\s*-)?\s*([^#]*?)\s*(?:#\s*(SKIP|TODO)\b(.*))?$/i);
    if (!m) continue;
    report.total++;
    const directive = m[4]?.toUpperCase();
    const name = m[3]?.trim() || `test ${m[2] ?? report.total}`;
    if (directive === 'SKIP') report.skipped++;
    else if (m[1] && directive !== 'TODO') {
      report.failed++;
      if (report.failures.length < MAX_FAILURES) {
        // Use an indented YAML diagnostic block's "message:" if present.
        let message: string | undefined;
        for (let j = i + 1; j < lines.length && /^\s+/.test(lines[j]); j++) {
          const mm = lines[j].match(/^\s+message:\s*['"]?(.*?)['"]?\s*$/);
          if (mm) {
            message = clip(mm[1]);
            break;
          }
        }
        report.failures.push(message ? { name, message } : { name });
      }
    } else report.passed++;
  }
  return report.total > 0 ? report : null;
}

function merge(reports: TestReport[]): TestReport {
  const [first, ...rest] = reports;
  const out: TestReport = { ...first, failures: [...first.failures], sources: [...first.sources] };
  for (const r of rest) {
    out.total += r.total;
    out.passed += r.passed;
    out.failed += r.failed;
    out.skipped += r.skipped;
    if (r.durationMs !== undefined) out.durationMs = (out.durationMs ?? 0) + r.durationMs;
    out.failures.push(...r.failures.slice(0, MAX_FAILURES - out.failures.length));
    out.sources.push(...r.sources);
  }
  return out;
}

/** JUnit XML from artifacts wins; otherwise fall back to TAP on stdout. */
export function buildReport(input: { stdout: string; artifacts?: Artifact[] }): TestReport | undefined {
  const junit = (input.artifacts ?? [])
    .filter((a) => a.name.toLowerCase().endsWith('.xml'))
    .map((a) => parseJUnit(a.data.toString('utf8'), a.name))
    .filter((r): r is TestReport => r !== null);
  if (junit.length) return merge(junit);
  return parseTap(input.stdout) ?? undefined;
}
