type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS: Record<Level, string> = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

function currentLevel(): Level {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return raw in ORDER ? (raw as Level) : 'info';
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  const write = (level: Level, msg: string, meta?: unknown) => {
    if (ORDER[level] < ORDER[currentLevel()]) return;
    const ts = new Date().toISOString().slice(11, 23);
    let line = `${COLORS[level]}${ts} ${level.toUpperCase().padEnd(5)}${RESET} [${scope}] ${msg}`;
    if (meta !== undefined) {
      line += ' ' + (meta instanceof Error ? meta.stack ?? meta.message : JSON.stringify(meta));
    }
    (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  };
  return {
    debug: (m, x) => write('debug', m, x),
    info: (m, x) => write('info', m, x),
    warn: (m, x) => write('warn', m, x),
    error: (m, x) => write('error', m, x),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
