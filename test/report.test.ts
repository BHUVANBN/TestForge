import { buildReport, parseJUnit, parseTap } from '../src/jobs/report';

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="math" tests="4" failures="1" skipped="1" time="0.5">
    <testcase classname="math.add" name="adds" time="0.1"/>
    <testcase classname="math.sub" name="subtracts &amp; more" time="0.2">
      <failure message="expected 2 &lt; 3" type="AssertionError"><![CDATA[stack trace here]]></failure>
    </testcase>
    <testcase classname="math.mul" name="multiplies" time="0.15"><skipped/></testcase>
    <testcase classname="math.div" name="divides" time="0.05">
      <error>ZeroDivisionError: boom</error>
    </testcase>
  </testsuite>
</testsuites>`;

describe('parseJUnit', () => {
  it('counts results, failures and duration', () => {
    const r = parseJUnit(JUNIT, 'results.xml')!;
    expect(r).toMatchObject({ format: 'junit', total: 4, passed: 1, failed: 2, skipped: 1, durationMs: 500, sources: ['results.xml'] });
    expect(r.failures).toEqual([
      { name: 'subtracts & more', classname: 'math.sub', message: 'expected 2 < 3' },
      { name: 'divides', classname: 'math.div', message: 'ZeroDivisionError: boom' },
    ]);
  });

  it('ignores non-JUnit XML', () => {
    expect(parseJUnit('<project><dependency/></project>')).toBeNull();
  });
});

describe('parseTap', () => {
  it('parses TAP with skips, todos and diagnostics', () => {
    const r = parseTap(
      [
        'TAP version 13',
        '1..5',
        'ok 1 - starts',
        'not ok 2 - computes total',
        '  ---',
        "  message: 'expected 3, got 4'",
        '  ...',
        'ok 3 - optional # SKIP no network',
        'not ok 4 - future # TODO later',
        'ok 5',
      ].join('\n')
    )!;
    expect(r).toMatchObject({ format: 'tap', total: 5, passed: 3, failed: 1, skipped: 1 });
    expect(r.failures).toEqual([{ name: 'computes total', message: 'expected 3, got 4' }]);
  });

  it('requires a TAP header or plan', () => {
    expect(parseTap('ok so this is just a log line')).toBeNull();
  });
});

describe('buildReport', () => {
  it('prefers JUnit artifacts and merges several files', () => {
    const r = buildReport({
      stdout: 'TAP version 13\nok 1',
      artifacts: [
        { name: 'a.xml', data: Buffer.from(JUNIT) },
        { name: 'b.xml', data: Buffer.from('<testsuite><testcase name="x"/></testsuite>') },
        { name: 'notes.txt', data: Buffer.from('<testcase') },
      ],
    })!;
    expect(r).toMatchObject({ format: 'junit', total: 5, passed: 2, sources: ['a.xml', 'b.xml'] });
  });

  it('falls back to TAP on stdout, or nothing', () => {
    expect(buildReport({ stdout: '1..1\nok 1 - fine' })?.format).toBe('tap');
    expect(buildReport({ stdout: 'hello' })).toBeUndefined();
  });
});
