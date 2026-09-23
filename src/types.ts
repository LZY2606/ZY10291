import type { JitiOptions, ModuleCache } from "../lib/types";
export type {
  JitiOptions,
  ModuleCache,
  EvalModuleOptions,
  Jiti,
  TransformOptions,
  TransformResult,
  JitiResolveOptions,
  JitiTraceEvent,
} from "../lib/types";
import type { JitiTraceEvent } from "../lib/types";

export interface Context {
  filename: string;
  url: string;
  parentModule?: NodeModule;
  parentCache?: ModuleCache;
  nativeImport?: (id: string) => Promise<any>;
  onError?: (error: Error) => void;
  opts: JitiOptions;
  nativeModules: string[];
  transformModules: string[];
  isNativeRe: RegExp;
  isTransformRe: RegExp;
  alias?: Record<string, string>;
  resolveTsConfigPaths?: (specifier: string) => string[];
  additionalExts: string[];
  nativeRequire: NodeRequire;
  createRequire: (typeof import("node:module"))["createRequire"];
  /** @internal Sequence generator for top-level load trace ids */
  traceSeq?: { n: number };
  /** @internal Active load trace session (shared with nested jiti instances) */
  traceSession?: { id: string };
  /** @internal In-flight load trace record (not propagated to nested loads) */
  traceRecord?: JitiTraceEvent;
}
