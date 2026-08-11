import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))

test('smr CLI accepts stdin JSON and returns a machine-readable request error', async () => {
  const result = await runCli('{}')
  assert.equal(result.code, 1)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.kind, 'invalid_request')
  assert.match(payload.error.message, /requires provider/)
})

test('smr CLI terminates its provider process when the wrapper receives SIGTERM', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'smr-cli-signal-'))
  const binary = join(temp, 'codex')
  const pidFile = join(temp, 'provider.pid')
  writeFileSync(binary, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.SMR_CHILD_PID_FILE, String(process.pid))
setInterval(() => {}, 1000)
`)
  chmodSync(binary, 0o755)

  try {
    const child = spawn(process.execPath, [cli], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stdin.end(JSON.stringify({
      provider: 'codex',
      prompt: 'wait',
      env: { PATH: `${temp}:${process.env.PATH}`, SMR_CHILD_PID_FILE: pidFile },
    }))

    await waitUntil(() => readOptional(pidFile), 2_000)
    const providerPid = Number(readFileSync(pidFile, 'utf8'))
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('close', resolve))
    await waitUntil(() => !isAlive(providerPid), 2_000)

    assert.equal(isAlive(providerPid), false)
    assert.equal(JSON.parse(stdout).error.kind, 'cancelled')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

function runCli(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

function readOptional(path) {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
