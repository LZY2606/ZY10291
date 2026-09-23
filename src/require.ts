import type { Context, JitiResolveOptions } from "./types";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { extname } from "pathe";
import { resolveAlias } from "pathe/utils";
import { jitiInteropDefault, normalizeWindowsImportId, hash } from "./utils";
import { debug } from "./utils";
import { jitiResolve } from "./resolve";
import { evalModule } from "./eval";
import {
  beginTrace,
  settleTrace,
  failTrace,
  noteTrace,
  matchAliasRule,
} from "./trace";

export function jitiRequire(
  ctx: Context,
  id: string,
  opts: JitiResolveOptions & { async: boolean },
) {
  // Start a structured load trace (no-op unless `opts.onTrace` is set).
  // A fresh trace session (id) is created per top-level load; nested loads
  // inherit the session propagated through the (nested) jiti context.
  const trace = beginTrace(ctx, id);
  if (trace) {
    ctx = { ...ctx, traceSession: trace.session, traceRecord: trace.record };
  }
  try {
    const result = jitiRequireInner(ctx, id, opts);
    return settleTrace(ctx, trace, result);
  } catch (error) {
    failTrace(ctx, trace, error);
    throw error;
  }
}

function jitiRequireInner(
  ctx: Context,
  id: string,
  opts: JitiResolveOptions & { async: boolean },
): any {
  const cache = ctx.parentCache || {};

  // Check for node:, file:, and data: protocols
  if (id.startsWith("node:")) {
    noteTrace(ctx, { strategy: "builtin", filename: id });
    return nativeImportOrRequire(ctx, id, opts.async);
  } else if (id.startsWith("file:")) {
    id = fileURLToPath(id);
  } else if (id.startsWith("data:")) {
    if (!opts.async) {
      throw new Error(
        "`data:` URLs are only supported in ESM context. Use `import` or `jiti.import` instead.",
      );
    }
    noteTrace(ctx, { strategy: "data" });
    debug(ctx, "[native]", "[data]", "[import]", id);
    return nativeImportOrRequire(ctx, id, true);
  }

  // Check for builtin node module like fs
  if (builtinModules.includes(id) || id === ".pnp.js" /* #24 */) {
    noteTrace(ctx, { strategy: "builtin", filename: id });
    return nativeImportOrRequire(ctx, id, opts.async);
  }

  // Check for virtual modules (e.g., bundled modules in compiled Bun binaries)
  if (ctx.opts.virtualModules && id in ctx.opts.virtualModules) {
    noteTrace(ctx, { strategy: "virtual" });
    debug(ctx, "[virtual]", id);
    const mod = ctx.opts.virtualModules[id];
    return opts.async
      ? Promise.resolve(jitiInteropDefault(ctx, mod))
      : jitiInteropDefault(ctx, mod);
  }

  // Experimental Bun support
  if (ctx.opts.tryNative && !ctx.opts.transformOptions) {
    try {
      id = jitiResolve(ctx, id, opts);
      if (!id && opts.try) {
        return undefined;
      }
      noteTrace(ctx, { strategy: "native", filename: id });
      debug(
        ctx,
        "[try-native]",
        opts.async && ctx.nativeImport ? "[import]" : "[require]",
        id,
      );
      if (opts.async && ctx.nativeImport) {
        return ctx
          .nativeImport(id)
          .then((m: any) => {
            if (ctx.opts.moduleCache === false) {
              delete ctx.nativeRequire.cache[id];
            }
            return jitiInteropDefault(ctx, m);
          })
          .catch((error) => {
            debug(
              ctx,
              `[try-native] Using fallback for ${id} because of an error:`,
              error,
            );
            noteTrace(ctx, { nativeFallback: true });
            return jitiRequireInner(
              // Try again without native
              { ...ctx, opts: { ...ctx.opts, tryNative: false } },
              id,
              opts,
            );
          });
      } else {
        const _mod = ctx.nativeRequire(id);
        if (ctx.opts.moduleCache === false) {
          delete ctx.nativeRequire.cache[id];
        }
        return jitiInteropDefault(ctx, _mod);
      }
    } catch (error: any) {
      noteTrace(ctx, { nativeFallback: true });
      debug(
        ctx,
        `[try-native] Using fallback for ${id} because of an error:`,
        error,
      );
    }
  }

  // Track applied alias rule
  if (ctx.alias) {
    const aliased = resolveAlias(id, ctx.alias);
    if (aliased !== id) {
      noteTrace(ctx, {
        alias: { rule: matchAliasRule(id, ctx.alias)!, to: aliased },
      });
    }
  }

  // Resolve path
  const filename = jitiResolve(ctx, id, opts);
  if (!filename && opts.try) {
    return undefined;
  }
  noteTrace(ctx, { filename });
  const ext = extname(filename);

  // Check for .json modules
  if (ext === ".json") {
    noteTrace(ctx, { strategy: "json" });
    debug(ctx, "[json]", filename);
    const jsonModule = ctx.nativeRequire(filename);
    if (jsonModule && !("default" in jsonModule)) {
      Object.defineProperty(jsonModule, "default", {
        value: jsonModule,
        enumerable: false,
      });
    }
    return jsonModule;
  }

  // Unknown format
  if (ext && !ctx.opts.extensions!.includes(ext)) {
    noteTrace(ctx, { strategy: "native" });
    debug(
      ctx,
      "[native]",
      "[unknown]",
      opts.async ? "[import]" : "[require]",
      filename,
    );
    return nativeImportOrRequire(ctx, filename, opts.async);
  }

  // Force native modules
  if (ctx.isNativeRe.test(filename)) {
    noteTrace(ctx, { strategy: "native" });
    debug(ctx, "[native]", opts.async ? "[import]" : "[require]", filename);
    return nativeImportOrRequire(ctx, filename, opts.async);
  }

  // Check for runtime cache
  if (cache[filename]) {
    noteTrace(ctx, { runtimeCache: "hit" });
    if (cache[filename]?.loaded === false) {
      // Circular reference: module is requested again while being evaluated
      noteTrace(ctx, { backEdge: true });
    }
    return jitiInteropDefault(ctx, cache[filename]?.exports);
  }
  if (ctx.opts.moduleCache) {
    const cacheEntry = ctx.nativeRequire.cache[filename];
    if (cacheEntry?.loaded) {
      noteTrace(ctx, { runtimeCache: "hit" });
      return jitiInteropDefault(ctx, cacheEntry.exports);
    }
  }

  // Read source
  const source = readFileSync(filename, "utf8");
  noteTrace(ctx, { runtimeCache: "miss", sourceHash: hash(source) });

  // Evaluate module
  return evalModule(ctx, source, {
    id,
    filename,
    ext,
    cache,
    async: opts.async,
  });
}

export function nativeImportOrRequire(
  ctx: Context,
  id: string,
  async?: boolean,
) {
  return async && ctx.nativeImport
    ? ctx
        .nativeImport(normalizeWindowsImportId(id))
        .then((m: any) => jitiInteropDefault(ctx, m))
    : jitiInteropDefault(ctx, ctx.nativeRequire(id));
}
