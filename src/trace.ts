import type { Context, JitiTraceEvent } from "./types";
import { debug } from "./utils";

/**
 * Begin a new load trace record.
 *
 * Each top-level load starts a new trace session (with a fresh trace id).
 * Nested loads (triggered from within an evaluated module) reuse the session
 * propagated through the (nested) jiti context, so all records of one
 * top-level load share the same `traceId`.
 *
 * Returns `undefined` when tracing is disabled (`opts.onTrace` not set).
 */
export function beginTrace(
  ctx: Context,
  specifier: string,
): { session: { id: string }; record: JitiTraceEvent } | undefined {
  if (typeof ctx.opts.onTrace !== "function") {
    return;
  }
  let session = ctx.traceSession;
  if (!session) {
    const seq = (ctx.traceSeq ||= { n: 0 });
    session = { id: `t${++seq.n}` };
  }
  const record: JitiTraceEvent = {
    traceId: session.id,
    specifier,
    outcome: "ok",
  };
  if (ctx.traceSession) {
    // Nested load: the dependency edge points to the requesting module
    record.parent = ctx.filename;
  }
  return { session, record };
}

/**
 * Annotate the in-flight trace record (if any) with additional fields.
 */
export function noteTrace(ctx: Context, fields: Partial<JitiTraceEvent>): void {
  const record = ctx.traceRecord;
  if (record) {
    Object.assign(record, fields);
  }
}

/**
 * Emit the trace record once a load settled, preserving the original result.
 */
export function settleTrace<T>(
  ctx: Context,
  trace: { record: JitiTraceEvent } | undefined,
  result: T,
): T {
  if (!trace) {
    return result;
  }
  const { record } = trace;
  if (result && typeof (result as any).then === "function") {
    return (result as any).then(
      (value: any) => {
        emitTrace(ctx, record);
        return value;
      },
      (error: any) => {
        record.outcome = "error";
        record.error = traceErrorMessage(error);
        emitTrace(ctx, record);
        throw error;
      },
    );
  }
  emitTrace(ctx, record);
  return result;
}

/**
 * Emit the trace record for a load that failed synchronously.
 */
export function failTrace(
  ctx: Context,
  trace: { record: JitiTraceEvent } | undefined,
  error: unknown,
): void {
  if (!trace) {
    return;
  }
  trace.record.outcome = "error";
  trace.record.error = traceErrorMessage(error);
  emitTrace(ctx, trace.record);
}

/**
 * Deliver a finished trace record to the user callback.
 *
 * Callback errors are swallowed (and reported via debug logging) so they can
 * never corrupt the module cache or interrupt module evaluation.
 */
export function emitTrace(ctx: Context, record: JitiTraceEvent): void {
  const onTrace = ctx.opts.onTrace;
  if (typeof onTrace !== "function") {
    return;
  }
  try {
    onTrace(record);
  } catch (error) {
    debug(ctx, "[trace] onTrace callback error:", error);
  }
}

/**
 * Find the alias rule (key of `opts.alias`) matching a specifier.
 *
 * Mirrors the matching semantics of `resolveAlias` from `pathe/utils`.
 */
export function matchAliasRule(
  specifier: string,
  alias: Record<string, string>,
): string | undefined {
  for (const rule of Object.keys(alias)) {
    const key = rule.endsWith("/") ? rule.slice(0, -1) : rule;
    if (specifier === key || specifier.startsWith(key + "/")) {
      return rule;
    }
  }
}

// Keep only the first line of error messages: parser errors can embed
// source code frames in later lines and traces must not expose source code.
function traceErrorMessage(error: any): string {
  const message = String(error?.message || error);
  return message.split("\n")[0]!.slice(0, 200);
}
