// Simple logger utility for Cine Colombia CLI
//
// Everything goes to stderr so that stdout stays clean for piping command
// output into other tools (jq, grep, etc.).

import pc from 'picocolors';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

class Logger {
  private level: LogLevel = LogLevel.INFO;
  private quiet = false;

  setLevel(level: LogLevel) {
    this.level = level;
  }

  setQuiet(quiet: boolean) {
    this.quiet = quiet;
  }

  debug(...args: unknown[]) {
    if (this.quiet || this.level > LogLevel.DEBUG) return;
    console.error(pc.gray('[debug]'), ...args);
  }

  info(...args: unknown[]) {
    if (this.quiet || this.level > LogLevel.INFO) return;
    console.error(pc.blue('·'), ...args);
  }

  success(...args: unknown[]) {
    if (this.quiet) return;
    console.error(pc.green('✓'), ...args);
  }

  warn(...args: unknown[]) {
    if (this.quiet || this.level > LogLevel.WARN) return;
    console.error(pc.yellow('!'), ...args);
  }

  error(...args: unknown[]) {
    if (this.level > LogLevel.ERROR) return;
    console.error(pc.red('✗'), ...args);
  }
}

export const logger = new Logger();
