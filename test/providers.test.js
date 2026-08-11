import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createClaudeAdapter, createCodexAdapter, createKimiAdapter } from '../src/index.js'

const base = {
  prompt: 'hello',
  mode: 'read-only',
  output: { type: 'text' },
  writeFile(path, contents) { writeFileSync(path, contents) },
}

test('provider drivers pass caller aliases through without baked release names', () => {
  const temp = mkdtempSync(join(tmpdir(), 'provider-test-'))
  try {
    const codex = createCodexAdapter({ aliases: { fast: 'configured-codex-model' } }).prepare({ ...base, model: 'fast' }, temp)
    const claude = createClaudeAdapter().prepare({ ...base, model: 'opus' }, temp)
    const kimi = createKimiAdapter().prepare({ ...base, model: 'k3' }, temp)

    assert.deepEqual(codex.args.slice(codex.args.indexOf('--model'), codex.args.indexOf('--model') + 2), ['--model', 'configured-codex-model'])
    assert.deepEqual(claude.args.slice(claude.args.indexOf('--model'), claude.args.indexOf('--model') + 2), ['--model', 'opus'])
    assert.deepEqual(kimi.args.slice(kimi.args.indexOf('--model'), kimi.args.indexOf('--model') + 2), ['--model', 'k3'])
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('providers omit model selection when no model or configured default is supplied', () => {
  const temp = mkdtempSync(join(tmpdir(), 'provider-test-'))
  try {
    assert.equal(createCodexAdapter().prepare(base, temp).args.includes('--model'), false)
    assert.equal(createClaudeAdapter().prepare(base, temp).args.includes('--model'), false)
    assert.equal(createKimiAdapter().prepare(base, temp).args.includes('--model'), false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('configured defaults pass through the same caller-owned alias map', () => {
  const temp = mkdtempSync(join(tmpdir(), 'provider-test-'))
  try {
    const claude = createClaudeAdapter({ defaultModel: 'best', aliases: { best: 'configured-claude-model' } }).prepare(base, temp)
    const kimi = createKimiAdapter({ defaultModel: 'best', aliases: { best: 'configured-kimi-model' } }).prepare(base, temp)

    assert.ok(claude.args.includes('configured-claude-model'))
    assert.ok(kimi.args.includes('configured-kimi-model'))
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('read-only and structured output become provider-native flags', () => {
  const temp = mkdtempSync(join(tmpdir(), 'provider-test-'))
  const request = { ...base, output: { type: 'json', schema: { type: 'object' } } }
  try {
    const codex = createCodexAdapter().prepare(request, temp)
    const claude = createClaudeAdapter().prepare(request, temp)
    const kimi = createKimiAdapter().prepare(request, temp)

    assert.ok(codex.args.includes('--output-schema'))
    assert.ok(codex.args.includes('read-only'))
    assert.ok(claude.args.includes('--json-schema'))
    assert.ok(claude.args.includes('plan'))
    assert.equal(kimi.args.includes('--plan'), false)
    assert.ok(kimi.args.includes('--agent-file'))
    assert.match(kimi.args[kimi.args.indexOf('--prompt') + 1], /JSON Schema/)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('provider configuration and MCP inheritance are opt-in', () => {
  const temp = mkdtempSync(join(tmpdir(), 'provider-test-'))
  try {
    const isolatedCodex = createCodexAdapter().prepare(base, temp)
    const inheritedCodex = createCodexAdapter().prepare({ ...base, inheritConfig: true }, temp)
    const isolatedClaude = createClaudeAdapter().prepare(base, temp)
    const inheritedClaude = createClaudeAdapter().prepare({ ...base, inheritConfig: true }, temp)

    assert.ok(isolatedCodex.args.includes('--ignore-user-config'))
    assert.equal(inheritedCodex.args.includes('--ignore-user-config'), false)
    assert.ok(isolatedClaude.args.includes('--strict-mcp-config'))
    assert.equal(inheritedClaude.args.includes('--strict-mcp-config'), false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('Claude defaults to its tool set but honors an explicit empty tool list', () => {
  const temp = mkdtempSync(join(tmpdir(), 'provider-test-'))
  try {
    const defaults = createClaudeAdapter().prepare(base, temp)
    const disabled = createClaudeAdapter().prepare({ ...base, tools: [] }, temp)
    assert.equal(defaults.args[defaults.args.indexOf('--tools') + 1], 'default')
    assert.equal(disabled.args[disabled.args.indexOf('--tools') + 1], '')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('Kimi prompt mode is unattended while retaining advisory read-only policy', () => {
  const temp = mkdtempSync(join(tmpdir(), 'provider-test-'))
  try {
    const invocation = createKimiAdapter().prepare(base, temp)
    assert.equal(invocation.args.includes('--auto'), false)
    assert.equal(invocation.args.includes('--yolo'), false)
    assert.ok(invocation.args.includes('--agent-file'))
    const agentPath = invocation.args[invocation.args.indexOf('--agent-file') + 1]
    assert.match(readFileSync(agentPath, 'utf8'), /^---\nname: subscription-model-runtime-read-only\n/)
    assert.notEqual(invocation.args[invocation.args.indexOf('--skills-dir') + 1], temp)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('capability metadata states where provider parity is impossible', () => {
  assert.equal(createCodexAdapter().capabilities.sandbox, 'enforced')
  assert.equal(createClaudeAdapter().capabilities.ephemeral, true)
  assert.deepEqual(createKimiAdapter().capabilities, {
    sandbox: 'advisory',
    ephemeral: false,
    promptTransport: 'argv',
    nativeJsonSchema: false,
  })
})
