import { openSync, appendFileSync, closeSync } from "node:fs";
import type { LogEvent } from "./types.js";

/**
 * Append-only JSONL session logger. Each log event is written as a single
 * JSON line. Uses sync writes to guarantee ordering and avoid lost events
 * on crash (Invariant 3).
 */
export class SessionLogger {
  private fd: number;
  private closed = false;

  constructor(logFile: string) {
    this.fd = openSync(logFile, "a");
  }

  log(event: LogEvent): void {
    if (this.closed) return;
    appendFileSync(this.fd, JSON.stringify(event) + "\n");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}
