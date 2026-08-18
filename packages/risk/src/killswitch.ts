import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger, type AppConfig } from '@4gent/core';

const log = logger('risk:killswitch');

export type KillReason = 'file_flag' | 'signal' | 'programmatic';

/**
 * The last line of defence.
 *
 * Deliberately dumb: a file on disk and a process signal. An operator with SSH
 * and nothing else must be able to stop the agent, and that path must not
 * depend on the database, the RPC, or any code path the agent itself controls.
 */
export class KillSwitch {
  private engaged = false;
  private reason: KillReason | null = null;
  private readonly listeners = new Set<(reason: KillReason) => void | Promise<void>>();
  private readonly path: string;
  private poller: NodeJS.Timeout | null = null;

  constructor(config: AppConfig, cwd = process.cwd()) {
    this.path = resolve(cwd, config.killSwitchFile);
    if (existsSync(this.path)) {
      this.engaged = true;
      this.reason = 'file_flag';
      log.error({ path: this.path }, 'kill switch file present at startup — agent will not trade');
    }
  }

  get isEngaged(): boolean {
    return this.engaged;
  }

  get engagedReason(): KillReason | null {
    return this.reason;
  }

  get filePath(): string {
    return this.path;
  }

  /** Registers SIGTERM/SIGINT handlers and starts polling for the file flag. */
  install(pollMs = 2_000): void {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        log.warn({ signal }, 'termination signal received');
        void this.engage('signal');
      });
    }
    this.poller = setInterval(() => {
      if (!this.engaged && existsSync(this.path)) void this.engage('file_flag');
    }, pollMs);
    this.poller.unref();
  }

  async engage(reason: KillReason): Promise<void> {
    if (this.engaged) return;
    this.engaged = true;
    this.reason = reason;
    log.error({ reason }, 'KILL SWITCH ENGAGED — halting all trading');
    for (const listener of this.listeners) {
      try {
        await listener(reason);
      } catch (error) {
        log.error({ err: String(error) }, 'kill switch listener threw');
      }
    }
  }

  /** Listeners run on engage; use them to drain loops and cancel in-flight work. */
  onEngage(listener: (reason: KillReason) => void | Promise<void>): void {
    this.listeners.add(listener);
  }

  /** Writes the flag file, so one process can halt another on the same box. */
  static writeFlag(config: AppConfig, note: string, cwd = process.cwd()): string {
    const path = resolve(cwd, config.killSwitchFile);
    writeFileSync(path, `${new Date().toISOString()} ${note}\n`, 'utf8');
    return path;
  }

  /** Clearing is manual and never automatic. */
  static clearFlag(config: AppConfig, cwd = process.cwd()): boolean {
    const path = resolve(cwd, config.killSwitchFile);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }

  dispose(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.listeners.clear();
  }
}
