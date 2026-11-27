/**
 * Supported script runtimes.
 *
 * `interpreter` is the argv prefix used to run a script file; the script path is
 * appended. The same definition drives the local executor and the Docker sandbox.
 */
export const LANGUAGES = ['bash', 'sh', 'node', 'python', 'ruby', 'php', 'go', 'java'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface RuntimeDefinition {
  /** argv used to execute a script file (file path is appended). */
  interpreter: string[];
  /** File name the script is written to (some toolchains care about the extension). */
  fileName: string;
}

export const RUNTIMES: Record<Language, RuntimeDefinition> = {
  bash: { interpreter: ['bash'], fileName: 'script.sh' },
  sh: { interpreter: ['sh'], fileName: 'script.sh' },
  node: { interpreter: ['node'], fileName: 'script.js' },
  python: { interpreter: ['python3'], fileName: 'script.py' },
  ruby: { interpreter: ['ruby'], fileName: 'script.rb' },
  php: { interpreter: ['php'], fileName: 'script.php' },
  go: { interpreter: ['go', 'run'], fileName: 'main.go' },
  java: { interpreter: ['java'], fileName: 'Main.java' },
};

/** Which runtime image a bare command needs when no language is given. */
const COMMAND_LANGUAGE: Record<string, Language> = {
  node: 'node',
  npm: 'node',
  npx: 'node',
  python: 'python',
  python3: 'python',
  pip: 'python',
  pip3: 'python',
  ruby: 'ruby',
  gem: 'ruby',
  bundle: 'ruby',
  php: 'php',
  go: 'go',
  java: 'java',
  javac: 'java',
  bash: 'bash',
};

export function languageForCommand(command: string): Language {
  return COMMAND_LANGUAGE[command] ?? 'sh';
}

/**
 * Environment variables a job may not set. They either let a job hijack the
 * interpreter/loader of the runner, or are owned by TestForge itself.
 */
const RESERVED_ENV = /^(LD_|DYLD_|TESTFORGE_)|^(PATH|HOME|SHELL|USER|IFS|ENV|BASH_ENV|NODE_OPTIONS|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|RUBYOPT|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|GOFLAGS)$/;

export function isReservedEnvName(name: string): boolean {
  return RESERVED_ENV.test(name);
}
