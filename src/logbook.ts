/**
 * A bounded, in-memory record of what the service decided and why.
 *
 * This is not a second logger. pino writes to the container's stdout, which is
 * where an operator looks; this is the same events rendered as plain text and
 * served over HTTP, which is where a CONTROLLER looks -- someone who wants to
 * know why the flight in front of them got 7201 instead of 1000 and has no
 * shell on the box.
 *
 * That audience decides the content: every line names a callsign and a decision,
 * and a decision that withheld Mode S conspicuity always carries its reason.
 */

/** Widest category name, so the columns line up without a formatter. */
const CATEGORY_WIDTH = 6;

export type Category = "status" | "tick" | "auto" | "manual" | "config";

/**
 * Lines kept before the oldest is overwritten.
 *
 * A cold start writes one line per flight already in scope -- around 300 at a
 * busy hour -- so the buffer has to swallow that burst and still leave hours of
 * ordinary traffic behind it.
 */
const DEFAULT_CAPACITY = 4000;

/**
 * The actor column: the controller who asked, or a dash when nobody did -- the
 * reconciliation loop, a test, a script.
 */
export function by(controller: string | null): string {
  return (controller ?? "-").padEnd(10);
}

export class Logbook {
  private readonly buffer: (string | undefined)[];
  private next = 0;
  private wrapped = false;

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {
    this.buffer = new Array<string | undefined>(capacity);
  }

  record(category: Category, message: string): void {
    const at = new Date().toISOString().slice(11, 19); // HH:MM:SS, UTC
    this.buffer[this.next] = `${at} ${category.padEnd(CATEGORY_WIDTH)} ${message}`;
    this.next = (this.next + 1) % this.capacity;
    if (this.next === 0) this.wrapped = true;
  }

  /** Oldest first, which is how a log is read. */
  lines(): string[] {
    if (!this.wrapped) return this.buffer.slice(0, this.next) as string[];
    return [
      ...(this.buffer.slice(this.next) as string[]),
      ...(this.buffer.slice(0, this.next) as string[]),
    ];
  }

  /**
   * Plain text, oldest first.
   *
   * `q` filters to lines containing it, case-insensitively -- a callsign, an
   * airport, a category, or "denied 1000" to see only the Mode S refusals.
   * `limit` then keeps the most recent matches, so the two compose the way
   * `grep | tail` does.
   */
  render(options: { limit?: number; q?: string } = {}): string {
    let lines = this.lines();

    if (options.q) {
      const needle = options.q.toLowerCase();
      lines = lines.filter((line) => line.toLowerCase().includes(needle));
    }
    if (options.limit !== undefined && lines.length > options.limit) {
      lines = lines.slice(-options.limit);
    }

    return lines.length > 0 ? lines.join("\n") + "\n" : "";
  }

  get size(): number {
    return this.wrapped ? this.capacity : this.next;
  }
}

/**
 * The process-wide logbook.
 *
 * A singleton on purpose: it is a diagnostic sink like the logger itself, and
 * threading one through the engine, the store and every route handler would add
 * a parameter to each for no gain.
 */
export const logbook = new Logbook();
