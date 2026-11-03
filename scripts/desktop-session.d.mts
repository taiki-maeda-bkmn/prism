import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';

export function superviseDesktopChild(child: ChildProcess, options: {
  token: string;
  startupTimeoutMs?: number;
  terminateGraceMs?: number;
  processGroup?: boolean;
  signalSource?: EventEmitter;
  signalGroup?: (pid: number, signal: NodeJS.Signals) => unknown;
  writeStdout?: (chunk: Buffer) => unknown;
  reportError?: (message: string) => unknown;
}): Promise<{ exitCode: number; ready: boolean; timedOut: boolean }>;
