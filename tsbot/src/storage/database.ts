import { Database as BunDatabase } from "bun:sqlite";
import {
  recordSqliteContention,
  recordSqliteOperationalEvent,
  type SqliteOperation,
  type TransactionMode,
} from "./telemetry.js";

export interface DatabaseOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  timeout?: number;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface DatabaseStatement {
  run(...parameters: unknown[]): RunResult;
  get(...parameters: unknown[]): unknown | undefined;
  all(...parameters: unknown[]): unknown[];
}

export type DatabaseTransaction<F extends (...parameters: never[]) => unknown> =
  F & {
    default: F;
    deferred: F;
    immediate: F;
    exclusive: F;
  };

export interface DatabaseConnection {
  readonly inTransaction: boolean;
  readonly memory: boolean;
  readonly name: string;
  readonly readonly: boolean;
  readonly open: boolean;
  prepare(source: string): DatabaseStatement;
  transaction<F extends (...parameters: never[]) => unknown>(
    callback: F,
  ): DatabaseTransaction<F>;
  exec(source: string): this;
  pragma(source: string): unknown[];
  vacuumInto(destinationFile: string): void;
  close(): this;
}

interface NativeStatement {
  run(...parameters: unknown[]): RunResult;
  get(...parameters: unknown[]): unknown | null;
  all(...parameters: unknown[]): unknown[];
}

interface NativeTransaction {
  (...parameters: unknown[]): unknown;
  deferred(...parameters: unknown[]): unknown;
  immediate(...parameters: unknown[]): unknown;
  exclusive(...parameters: unknown[]): unknown;
}

/**
 * The application's intentionally small SQLite surface.
 *
 * `query()` keeps a bounded native statement cache owned by Bun. Closing the
 * connection finalizes that cache, so callers do not need to retain or manually
 * finalize short-lived statement wrappers.
 */
export default class Database implements DatabaseConnection {
  public readonly memory: boolean;
  public readonly name: string;
  public readonly readonly: boolean;
  public open = true;

  private readonly native: BunDatabase;

  public constructor(fileName = ":memory:", options: DatabaseOptions = {}) {
    const normalizedName = fileName || ":memory:";
    const timeout = options.timeout ?? 5_000;
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 2_147_483_647) {
      throw new TypeError(
        "Expected the timeout option to be an integer from 0 through 2147483647",
      );
    }

    this.memory = normalizedName === ":memory:";
    this.name = normalizedName;
    this.readonly = options.readonly === true;
    this.native = new BunDatabase(normalizedName, {
      create: !this.readonly && options.fileMustExist !== true,
      readonly: this.readonly,
      readwrite: !this.readonly,
      safeIntegers: false,
      strict: true,
    });

    try {
      this.native.run(`PRAGMA busy_timeout = ${timeout}`);
    } catch (error) {
      this.native.close(true);
      this.open = false;
      throw error;
    }
  }

  public get inTransaction(): boolean {
    return this.open && this.native.inTransaction;
  }

  public prepare(source: string): DatabaseStatement {
    this.assertOpen();
    const native = this.withContention(
      "prepare",
      () => this.native.query(source) as unknown as NativeStatement,
    );
    return {
      run: (...parameters: unknown[]): RunResult =>
        this.withContention("statement-run", () => native.run(...parameters)),
      get: (...parameters: unknown[]): unknown | undefined =>
        this.withContention(
          "statement-get",
          () => native.get(...parameters) ?? undefined,
        ),
      all: (...parameters: unknown[]): unknown[] =>
        this.withContention("statement-all", () => native.all(...parameters)),
    };
  }

  public transaction<F extends (...parameters: never[]) => unknown>(
    callback: F,
  ): DatabaseTransaction<F> {
    this.assertOpen();
    if (callback.constructor.name === "AsyncFunction") {
      throw new TypeError(
        "SQLite transaction callbacks must be synchronous; async functions are not supported",
      );
    }
    const native = this.native.transaction((...parameters: unknown[]) => {
      const result = callback(...(parameters as Parameters<F>));
      if (isThenable(result)) {
        throw new TypeError(
          "SQLite transaction callbacks must be synchronous; async work would escape the transaction boundary",
        );
      }
      return result;
    }) as unknown as NativeTransaction;

    const invoke = this.transactionInvoker<F>("default", (...parameters) =>
      native(...parameters),
    );
    const deferred = this.transactionInvoker<F>("deferred", (...parameters) =>
      native.deferred(...parameters),
    );
    const immediate = this.transactionInvoker<F>("immediate", (...parameters) =>
      native.immediate(...parameters),
    );
    const exclusive = this.transactionInvoker<F>("exclusive", (...parameters) =>
      native.exclusive(...parameters),
    );

    return Object.assign(invoke, {
      default: invoke,
      deferred,
      immediate,
      exclusive,
    }) as DatabaseTransaction<F>;
  }

  public exec(source: string): this {
    this.assertOpen();
    this.withContention("exec", () => this.native.exec(source));
    return this;
  }

  public pragma(source: string): unknown[] {
    this.assertOpen();
    return this.withContention("pragma", () =>
      (
        this.native.query(`PRAGMA ${source}`) as unknown as NativeStatement
      ).all(),
    );
  }

  public vacuumInto(destinationFile: string): void {
    this.assertOpen();
    this.withContention("vacuum-into", () =>
      (this.native.query("VACUUM INTO ?") as unknown as NativeStatement).run(
        destinationFile,
      ),
    );
  }

  public close(): this {
    if (!this.open) return this;
    try {
      this.native.close(true);
      this.open = false;
    } catch (error) {
      recordSqliteContention(error, "close");
      recordSqliteOperationalEvent({
        event: "database-close",
        outcome: "failed",
      });
      throw error;
    }
    return this;
  }

  private transactionInvoker<F extends (...parameters: never[]) => unknown>(
    mode: TransactionMode,
    invoke: (...parameters: Parameters<F>) => unknown,
  ): F {
    return ((...parameters: Parameters<F>): ReturnType<F> => {
      const startedAt = performance.now();
      try {
        const result = invoke(...parameters) as ReturnType<F>;
        recordSqliteOperationalEvent({
          event: "transaction",
          mode,
          outcome: "committed",
          durationMs: performance.now() - startedAt,
        });
        return result;
      } catch (error) {
        recordSqliteContention(error, "transaction");
        recordSqliteOperationalEvent({
          event: "transaction",
          mode,
          outcome: "rolled-back",
          durationMs: performance.now() - startedAt,
        });
        throw error;
      }
    }) as F;
  }

  private withContention<T>(operation: SqliteOperation, run: () => T): T {
    try {
      return run();
    } catch (error) {
      recordSqliteContention(error, operation);
      throw error;
    }
  }

  private assertOpen(): void {
    if (!this.open) {
      throw new TypeError("The database connection is not open");
    }
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
