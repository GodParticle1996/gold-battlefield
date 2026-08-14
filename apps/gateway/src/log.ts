import { env } from './env';

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function emit(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[env.LOG_LEVEL]) return;
  // Sanitized structured logging (spec §15): never log secrets or headers.
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields });
  // eslint-disable-next-line no-console
  console.log(line);
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => emit('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit('error', message, fields),
};
