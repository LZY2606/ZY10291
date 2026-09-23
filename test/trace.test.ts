import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "../lib/jiti.mjs";
import type { JitiTraceEvent, TransformOptions } from "../lib/types.d.ts";

const fixturesDir = fileURLToPath(new URL("fixtures/trace", import.meta.url));

function fixture(...segments: string[]) {
  return join(fixturesDir, ...segments);
}

afterEach(() => {
  vi.restoreAllMocks();
});

function collect() {
  const events: JitiTraceEvent[] = [];
  return {
    events,
    onTrace: (event: JitiTraceEvent) => events.push({ ...event }),
  };
}

// Default (babel) transform, used to count actual transform invocations
const baseTransform = createJiti(import.meta.url, { fsCache: false }).options
  .transform!;

function countingTransform(counter: { n: number }) {
  return (opts: TransformOptions) => {
    counter.n++;
    return baseTransform(opts);
  };
}

// `.jsx` is only added to default extensions via the JITI_JSX env variable
const jsxExtensions = [
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".jsx",
];

describe("load trace", () => {
  it("traces alias chain with dependency edges", async () => {
    const { events, onTrace } = collect();
    const jiti = createJiti(fixture("alias-chain/index.ts"), {
      fsCache: false,
      alias: {
        "@lib": fixture("alias-chain/lib"),
        "@deep": fixture("alias-chain/lib/deep"),
      },
      onTrace,
    });
    const mod = await jiti.import<{ value: string }>("./index.ts");
    expect(mod.value).toBe("index+a+b");

    // One trace id for the whole top-level load
    expect(events.length).toBe(3);
    expect(new Set(events.map((e) => e.traceId)).size).toBe(1);

    // Events are emitted on load completion (children settle first)
    const byFilename = (name: string) =>
      events.find((e) => e.filename === fixture(name))!;
    const index = byFilename("alias-chain/index.ts");
    const a = byFilename("alias-chain/lib/a.ts");
    const b = byFilename("alias-chain/lib/deep/b.ts");
    // Top-level entry has no parent; nested loads point to the requester
    expect(index.specifier).toBe("./index.ts");
    expect(index.parent).toBeUndefined();
    expect(index.filename).toBe(fixture("alias-chain/index.ts"));
    expect(index.outcome).toBe("ok");

    expect(a.parent).toBe(fixture("alias-chain/index.ts"));
    expect(a.filename).toBe(fixture("alias-chain/lib/a.ts"));
    expect(a.alias?.rule).toBe("@lib");
    expect(a.alias?.to).toBe(fixture("alias-chain/lib/a"));

    expect(b.parent).toBe(fixture("alias-chain/lib/a.ts"));
    expect(b.filename).toBe(fixture("alias-chain/lib/deep/b.ts"));
    expect(b.alias?.rule).toBe("@deep");
  });

  it("traces ts/jsx transforms matching actual read and transform counts", async () => {
    const { events, onTrace } = collect();
    const transformCounter = { n: 0 };
    const readSpy = vi.spyOn(fs, "readFileSync");
    const jiti = createJiti(fixture("ts-jsx/index.ts"), {
      fsCache: false,
      jsx: true,
      extensions: jsxExtensions,
      onTrace,
      transform: countingTransform(transformCounter),
    });
    const mod = await jiti.import<{ out: string }>("./index.ts");
    expect(mod.out).toBe("hello-ts:div");

    const fixtureEvents = events.filter((e) =>
      e.filename?.startsWith(fixturesDir),
    );
    expect(fixtureEvents.map((e) => e.filename).sort()).toEqual(
      [
        fixture("ts-jsx/index.ts"),
        fixture("ts-jsx/mod.ts"),
        fixture("ts-jsx/view.jsx"),
      ].sort(),
    );
    expect(fixtureEvents.every((e) => e.strategy === "transform")).toBe(true);
    expect(fixtureEvents.every((e) => e.outcome === "ok")).toBe(true);

    // Trace matches actual transform invocations
    expect(transformCounter.n).toBe(3);
    expect(fixtureEvents).toHaveLength(transformCounter.n);

    // Trace matches actual source reads (one read per traced load)
    const sourceReads = readSpy.mock.calls.filter(
      ([p]) =>
        typeof p === "string" &&
        p.startsWith(fixturesDir) &&
        /\.(ts|jsx|tsx|mjs)$/.test(p),
    );
    expect(fixtureEvents.every((e) => typeof e.sourceHash === "string")).toBe(
      true,
    );
    expect(fixtureEvents).toHaveLength(sourceReads.length);
  });

  it("traces native import fallback to transform", async () => {
    const { events, onTrace } = collect();
    const jiti = createJiti(fixture("native-fallback/mod.mjs"), {
      fsCache: false,
      onTrace,
    });
    const mod = await jiti.import<{ mode: string }>("./mod.mjs");
    expect(mod.mode).toBe("transformed");

    const event = events.find((e) => e.specifier === "./mod.mjs")!;
    expect(event.filename).toBe(fixture("native-fallback/mod.mjs"));
    expect(event.strategy).toBe("transform");
    expect(event.nativeFallback).toBe(true);
    expect(event.outcome).toBe("ok");
  });

  it("represents circular CJS references as back-edges", () => {
    const { events, onTrace } = collect();
    const jiti = createJiti(fixture("circular-cjs/a.js"), {
      fsCache: false,
      onTrace,
    });
    jiti("./a.js");

    expect(new Set(events.map((e) => e.traceId)).size).toBe(1);
    const backEdge = events.find((e) => e.backEdge);
    expect(backEdge).toBeDefined();
    expect(backEdge!.filename).toBe(fixture("circular-cjs/a.js"));
    expect(backEdge!.parent).toBe(fixture("circular-cjs/b.js"));
    expect(backEdge!.runtimeCache).toBe("hit");
    // Non-circular loads are not marked as back-edges
    expect(events.filter((e) => !e.backEdge)).toHaveLength(2);
  });

  it("traces dynamic imports within the same trace", async () => {
    const { events, onTrace } = collect();
    const jiti = createJiti(fixture("dynamic-import/index.ts"), {
      fsCache: false,
      onTrace,
    });
    const mod = await jiti.import<{ lazy: string }>("./index.ts");
    expect(mod.lazy).toBe("lazy-value");

    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.traceId)).size).toBe(1);
    const lazy = events.find(
      (e) => e.filename === fixture("dynamic-import/lazy.ts"),
    )!;
    expect(lazy.parent).toBe(fixture("dynamic-import/index.ts"));
    expect(lazy.outcome).toBe("ok");
  });

  it("reports fs cache hit/miss with transform key and version", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "jiti-trace-")));
    try {
      const cacheDir = join(dir, "cache");
      const modFile = join(dir, "mod.ts");
      fs.writeFileSync(
        modFile,
        fs.readFileSync(fixture("fs-cache-stale/mod.ts"), "utf8"),
      );

      const transformCounter = { n: 0 };
      const runs: JitiTraceEvent[][] = [];
      const load = async () => {
        const { events, onTrace } = collect();
        const jiti = createJiti(modFile, {
          fsCache: cacheDir,
          moduleCache: false,
          onTrace,
          transform: countingTransform(transformCounter),
        });
        const mod = await jiti.import<{ version: string }>("./mod.ts");
        runs.push(events);
        return mod;
      };

      // Cold cache: miss + transform
      const first = await load();
      expect(first.version).toBe("v1");
      expect(transformCounter.n).toBe(1);
      const cold = runs[0]!.find((e) => e.filename === modFile)!;
      expect(cold.fsCache).toBe("miss");
      expect(cold.transformKey).toBeTruthy();
      expect(cold.transformVersion).toMatch(/^v\d+$/);

      // Warm cache: hit, no re-transform, key/version still visible
      const second = await load();
      expect(second.version).toBe("v1");
      expect(transformCounter.n).toBe(1);
      const warm = runs[1]!.find((e) => e.filename === modFile)!;
      expect(warm.fsCache).toBe("hit");
      expect(warm.transformKey).toBe(cold.transformKey);
      expect(warm.transformVersion).toBe(cold.transformVersion);

      // Stale cache (source changed): miss + re-transform
      fs.writeFileSync(modFile, 'export const version = "v2";\n');
      const third = await load();
      expect(third.version).toBe("v2");
      expect(transformCounter.n).toBe(2);
      const stale = runs[2]!.find((e) => e.filename === modFile)!;
      expect(stale.fsCache).toBe("miss");
      expect(stale.sourceHash).not.toBe(cold.sourceHash);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("traces transform errors without polluting the module cache", async () => {
    const { events, onTrace } = collect();
    const readSpy = vi.spyOn(fs, "readFileSync");
    const jiti = createJiti(fixture("transform-error/bad.ts"), {
      fsCache: false,
      onTrace,
    });
    await expect(jiti.import("./bad.ts")).rejects.toThrow();

    const event = events.find((e) => e.specifier === "./bad.ts")!;
    expect(event.outcome).toBe("error");
    expect(event.strategy).toBe("transform");
    expect(event.error).toBeTruthy();
    expect(event.filename).toBe(fixture("transform-error/bad.ts"));

    // Failed module is not served from cache: retry re-reads and re-fails
    await expect(jiti.import("./bad.ts")).rejects.toThrow();
    const reads = readSpy.mock.calls.filter(
      ([p]) => p === fixture("transform-error/bad.ts"),
    );
    expect(reads).toHaveLength(2);
    expect(events.filter((e) => e.specifier === "./bad.ts")).toHaveLength(2);
    expect(events[0]!.traceId).not.toBe(events[1]!.traceId);
  });

  it("swallows onTrace callback errors without polluting the module cache", async () => {
    let calls = 0;
    const jiti = createJiti(fixture("ts-jsx/mod.ts"), {
      fsCache: false,
      onTrace: () => {
        calls++;
        throw new Error("callback boom");
      },
    });
    const mod1 = await jiti.import<{ msg: string }>("./mod.ts");
    expect(mod1.msg).toBe("hello-ts");
    // Second load is served from the (intact) runtime module cache
    const mod2 = await jiti.import<{ msg: string }>("./mod.ts");
    expect(mod2.msg).toBe("hello-ts");
    expect(calls).toBe(2);
  });

  it("behaves identically when tracing is off", async () => {
    const { events, onTrace } = collect();
    const options = {
      fsCache: false,
      jsx: true,
      extensions: jsxExtensions,
    } as const;
    const withTrace = createJiti(fixture("ts-jsx/index.ts"), {
      ...options,
      onTrace,
    });
    const withoutTrace = createJiti(fixture("ts-jsx/index.ts"), options);
    const [traced, plain] = await Promise.all([
      withTrace.import<{ out: string }>("./index.ts"),
      withoutTrace.import<{ out: string }>("./index.ts"),
    ]);
    expect(traced.out).toBe(plain.out);
    expect(events.length).toBeGreaterThan(0);
  });

  it("isolates trace state between parallel jiti instances", async () => {
    const runA = collect();
    const runB = collect();
    const jitiA = createJiti(fixture("alias-chain/index.ts"), {
      fsCache: false,
      alias: {
        "@lib": fixture("alias-chain/lib"),
        "@deep": fixture("alias-chain/lib/deep"),
      },
      onTrace: runA.onTrace,
    });
    const jitiB = createJiti(fixture("ts-jsx/index.ts"), {
      fsCache: false,
      jsx: true,
      extensions: jsxExtensions,
      onTrace: runB.onTrace,
    });
    const [modA, modB] = await Promise.all([
      jitiA.import<{ value: string }>("./index.ts"),
      jitiB.import<{ out: string }>("./index.ts"),
    ]);
    expect(modA.value).toBe("index+a+b");
    expect(modB.out).toBe("hello-ts:div");

    // Each instance only received its own events
    expect(
      runA.events.every(
        (e) => !e.filename || e.filename.includes("alias-chain"),
      ),
    ).toBe(true);
    expect(
      runB.events.every((e) => !e.filename || e.filename.includes("ts-jsx")),
    ).toBe(true);

    // Trace ids are per-instance and shared by nested loads of one entry
    expect(runA.events[0]!.traceId).toBe("t1");
    expect(runB.events[0]!.traceId).toBe("t1");
    expect(new Set(runA.events.map((e) => e.traceId)).size).toBe(1);

    // A second top-level load on the same instance starts a new trace
    await jitiA.import("./lib/a.ts");
    const secondRun = runA.events.filter((e) => e.traceId !== "t1");
    expect(secondRun).toHaveLength(1);
    expect(secondRun[0]!.runtimeCache).toBe("hit");
  });
});
