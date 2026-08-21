export type ProviderName = 'codex' | 'claude' | 'kimi' | (string & {})
export type RunMode = 'read-only' | 'workspace-write'
export type ModelEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type JsonSchema = Record<string, unknown>

export type ModelEvent = {
  at: string
  provider: string
  type: string
  [key: string]: unknown
}

export type ModelRequest = {
  provider: ProviderName
  prompt: string
  model?: string
  effort?: ModelEffort
  cwd?: string
  mode?: RunMode
  tools?: string[]
  images?: string[]
  addDirs?: string[]
  output?: { type: 'text' } | { type: 'json'; schema: JsonSchema }
  signal?: AbortSignal
  timeoutMs?: number | null
  softStallMs?: number
  killGraceMs?: number
  maxOutputBytes?: number
  maxStderrBytes?: number
  env?: Record<string, string>
  envPolicy?: 'safe' | 'inherit'
  inheritConfig?: boolean
  onEvent?: (event: ModelEvent) => void
}

export type ModelResult<T = unknown> = {
  provider: string
  model: string | null
  text: string
  data?: T
  durationMs: number
  diagnostics: string
}

export type ProviderAdapter = {
  name: string
  capabilities?: Record<string, unknown>
  prepare(request: PreparedModelRequest, tempDir: string): ProviderInvocation
}

export type ProviderDecoder = {
  feed(chunk: string): Omit<ModelEvent, 'at' | 'provider'>[]
  end(): Omit<ModelEvent, 'at' | 'provider'>[] | void
  partialText(): string
  finalText(): string
  structured?(): unknown
  error?(): string
}

export type PreparedModelRequest = ModelRequest & {
  output: NonNullable<ModelRequest['output']>
  mode: RunMode
  writeFile(path: string, contents: string): void
}

export type ProviderInvocation = {
  command: string
  args: string[]
  cwd?: string
  stdin?: string
  decoder: ProviderDecoder
  finalText?: () => string
  structured?: () => unknown
  model?: string
}

export type LockableRequestField = keyof ModelRequest

export type RuntimeOptions = {
  providers: Record<string, ProviderAdapter>
  defaults?: Partial<ModelRequest>
  /**
   * Request fields the caller may not set. A locked field always takes its value
   * from `defaults`; a request that supplies one is rejected with
   * `ModelRunError('invalid_request')`. A safe gateway configuration is
   * `locked: ['mode', 'cwd', 'envPolicy', 'inheritConfig', 'env', 'addDirs']`.
   */
  locked?: LockableRequestField[]
  /**
   * Allow the last-resort `{...}` brace scan when recovering JSON from model
   * output. Defaults to `true`. Set to `false` behind an untrusted boundary.
   */
  allowBraceScan?: boolean
  spawnFn?: (...args: any[]) => any
}

export type DefaultRuntimeOptions = Omit<RuntimeOptions, 'providers'> & {
  providers?: Record<string, ProviderAdapter>
  codex?: Record<string, unknown>
  claude?: Record<string, unknown>
  kimi?: Record<string, unknown>
}

export type ModelRuntime = {
  providers: string[]
  capabilities(provider: ProviderName): Record<string, unknown>
  run<T = unknown>(request: ModelRequest): Promise<ModelResult<T>>
}

export class ModelRunError extends Error {
  kind: string
  provider: string | null
  command: string | null
  exitCode: number | null
  signal: string | null
  stderr: string
  partialText: string
}

export function createModelRuntime(options: RuntimeOptions): ModelRuntime
export function createDefaultRuntime(options?: DefaultRuntimeOptions): ModelRuntime
export function createCodexAdapter(options?: Record<string, unknown>): ProviderAdapter
export function createClaudeAdapter(options?: Record<string, unknown>): ProviderAdapter
export function createKimiAdapter(options?: Record<string, unknown>): ProviderAdapter
export function parseJsonObject(text: string, options?: { allowBraceScan?: boolean }): unknown
