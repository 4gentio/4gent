import pino, { type Logger } from 'pino';

const REDACT_PATHS = [
  'privateKey',
  'WALLET_PRIVATE_KEY',
  'anthropicApiKey',
  'ANTHROPIC_API_KEY',
  'telegramBotToken',
  'TELEGRAM_BOT_TOKEN',
  '*.privateKey',
  '*.anthropicApiKey',
  'headers.authorization',
  'headers["x-api-key"]',
];

let root: Logger | null = null;

export function initLogger(opts: { level: string; pretty: boolean }): Logger {
  root = pino({
    level: opts.level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: '4gent' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(opts.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });
  return root;
}

/** Namespaced child logger. Safe to call before initLogger during module load. */
export function logger(namespace: string): Logger {
  if (!root) root = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: '4gent' } });
  return root.child({ ns: namespace });
}
