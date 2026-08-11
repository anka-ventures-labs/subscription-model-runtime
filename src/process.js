import { spawn } from 'node:child_process'

import { classifyProcessFailure, ModelRunError } from './errors.js'

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_STDERR_BYTES = 1024 * 1024

export function runProcess({
  command,
  args,
  cwd,
  env,
  stdin,
  provider,
  decoder,
  signal,
  timeoutMs = null,
  softStallMs = 120_000,
  killGraceMs = 5_000,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
  onEvent = () => {},
  spawnFn = spawn,
}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let stderr = ''
    let stdoutBytes = 0
    let settled = false
    let aborted = false
    let timedOut = false
    let outputExceeded = false
    let stalled = false
    let lastActivityAt = startedAt
    let forceKillTimer
    let killRequested = false

    const publish = (event) => {
      try { onEvent({ at: new Date().toISOString(), provider, ...event }) } catch {}
    }
    const activity = () => {
      lastActivityAt = Date.now()
      if (stalled) {
        stalled = false
        publish({ type: 'resumed' })
      }
    }

    const child = spawnFn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const killOnParentExit = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {}
    }
    process.once('exit', killOnParentExit)

    const finish = (callback) => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (stallTimer) clearInterval(stallTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      signal?.removeEventListener('abort', abortHandler)
      process.removeListener('exit', killOnParentExit)
      callback()
    }
    const kill = () => {
      if (killRequested || child.exitCode !== null || child.signalCode !== null) return
      killRequested = true
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch {}
      forceKillTimer = setTimeout(() => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch {}
      }, killGraceMs)
      forceKillTimer.unref()
    }
    const abortHandler = () => {
      aborted = true
      publish({ type: 'cancelling' })
      kill()
    }

    if (signal?.aborted) abortHandler()
    else signal?.addEventListener('abort', abortHandler, { once: true })

    const timeoutTimer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          publish({ type: 'timeout', timeoutMs })
          kill()
        }, timeoutMs)
      : null
    timeoutTimer?.unref()

    const stallTimer = Number.isFinite(softStallMs) && softStallMs > 0
      ? setInterval(() => {
          const quietMs = Date.now() - lastActivityAt
          if (!stalled && quietMs >= softStallMs) {
            stalled = true
            publish({ type: 'possibly_stalled', quietMs })
          }
        }, Math.max(50, Math.min(1_000, Math.floor(softStallMs / 2))))
      : null
    stallTimer?.unref()

    publish({ type: 'started', command, pid: child.pid ?? null })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      activity()
      if (outputExceeded) return
      stdoutBytes += Buffer.byteLength(chunk)
      if (stdoutBytes > maxOutputBytes) {
        outputExceeded = true
        publish({ type: 'output_limit', maxOutputBytes })
        kill()
        return
      }
      for (const event of decoder.feed(chunk)) publish(event)
    })
    child.stderr.on('data', (chunk) => {
      activity()
      stderr = appendBoundedUtf8(stderr, chunk, maxStderrBytes)
      publish({ type: 'stderr_activity', bytes: Buffer.byteLength(chunk) })
    })
    child.on('error', (cause) => finish(() => reject(new ModelRunError('spawn', cause.message, {
      cause,
      provider,
      command,
      stderr,
      partialText: decoder.partialText(),
    }))))
    child.stdin.on('error', () => {})
    child.on('close', (exitCode, exitSignal) => {
      for (const event of decoder.end?.() ?? []) publish(event)
      const durationMs = Date.now() - startedAt
      if (exitCode === 0 && !aborted && !timedOut && !outputExceeded) {
        finish(() => {
          publish({ type: 'completed', exitCode, durationMs })
          resolve({ stderr, exitCode, signal: exitSignal, durationMs })
        })
        return
      }
      const kind = classifyProcessFailure({ aborted, timedOut, outputExceeded, exitCode, stderr })
      finish(() => reject(new ModelRunError(kind, `${provider} CLI failed (${kind})`, {
        provider,
        command,
        exitCode,
        signal: exitSignal,
        stderr,
        partialText: decoder.partialText(),
      })))
    })

    child.stdin.end(stdin)
  })
}

function appendBoundedUtf8(existing, chunk, maxBytes) {
  const combined = Buffer.concat([Buffer.from(existing), Buffer.from(chunk)])
  if (combined.length <= maxBytes) return combined.toString('utf8')
  return combined.subarray(combined.length - maxBytes).toString('utf8').replace(/^\uFFFD/, '')
}
