/**
 * Top-level API server config (NestJS host/port, logging, CORS).
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly allowedOrigins: readonly string[];
  readonly usWatchSource: 'yfinance' | 'akshare';
}

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  host: '127.0.0.1',
  port: 3001,
  logLevel: 'INFO',
  allowedOrigins: [],
  usWatchSource: 'yfinance',
};

export function serverConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { ...DEFAULT_SERVER_CONFIG, ...overrides };
}
