/**
 * End-to-end tests for the project-local session store.
 *
 * Every case drives the real `SessionPersistence` seam through a real cordis
 * context: sessions are created, appended to, flushed, reopened, and listed
 * against real files on disk, and the resulting layout is asserted file by
 * file. Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

import ProjectSessionPersistence from '../src/index.js'

/** Root scratch directory for the whole suite. */
let scratch

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'project-session-store-'))
})

after(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/**
 * Build one isolated backend instance over a private central root.
 * @param {object} [options] - extra plugin configuration.
 * @param {string} [options.central] - reuse an existing central root.
 * @returns {Promise<{service: ProjectSessionPersistence, central: string, ctx: object}>}
 */
async function makeBackend(options = {}) {
  const { central = await mkdtemp(join(scratch, 'central-')), ...config } = options
  const ctx = new Context()
  // Keep diagnostics out of the test output; the plugin only needs `warn`.
  ctx.logger = { warn: () => {}, info: () => {}, error: () => {} }
  const service = new ProjectSessionPersistence(ctx, { root: central, ...config })
  await service.migrationDone
  return { service, central, ctx }
}

/**
 * Build a context carrying a minimal stand-in for the workspace registry.
 * @param {string[]} paths - project directories the registry knows about.
 * @returns {object} cordis context.
 */
function makeContext(paths) {
  const ctx = new Context()
  ctx.logger = { warn: () => {}, info: () => {}, error: () => {} }
  const workspaces = paths.map((path) => ({
    path,
    title: path.split('/').pop(),
    sessionIds: [],
    attachSession: async () => {},
  }))
  ctx.provide('workspaceRegistry', {
    list: () => workspaces,
    resolveByPath: async (path) => workspaces.find((workspace) => workspace.path === path),
    create: async (path, title) => {
      const created = { path, title: title ?? path, sessionIds: [], attachSession: async () => {} }
      workspaces.push(created)
      return created
    },
  })
  return ctx
}

/**
 * Build a valid session header.
 * @param {string} id - session id.
 * @param {string|undefined} cwd - project directory.
 * @returns {object} header.
 */
function header(id, cwd) {
  return {
    version: 4,
    id,
    createdAt: Date.now(),
    ...(cwd === undefined ? {} : { cwd }),
    isSeeded: false,
    delegationDepth: 0,
  }
}

/**
 * Build a valid contiguous batch of complete turns.
 *
 * The v4 log enforces lifecycle relationships, so `turn/start` must open the
 * expected turn and is followed by its `turn/end`. Each pair advances both the
 * sequence and the turn number by one.
 * @param {number} turns - number of complete turns to emit.
 * @param {number} [seqStart] - first sequence number.
 * @param {number} [turnStart] - first turn number.
 * @returns {object[]} events, in seq order.
 */
function events(turns, seqStart = 0, turnStart = 1) {
  const time = Date.now()
  const batch = []
  for (let index = 0; index < turns; index++) {
    const turn = turnStart + index
    batch.push({ type: 'turn/start', seq: seqStart + index * 2, time, data: { turn } })
    batch.push({ type: 'turn/end', seq: seqStart + index * 2 + 1, time, data: { turn, reason: 'completed' } })
  }
  return batch
}

describe('project-local placement', () => {
  it('stores a new session inside its project directory', async () => {
    const { service, central } = await makeBackend()
    const project = await mkdtemp(join(scratch, 'project-'))

    const handle = await service.create(header('sess-a', project))
    await handle.append(events(2))
    await handle.flush()
    await handle.close()

    const dir = join(project, '.dsh/sessions/sess-a')
    assert.ok(existsSync(join(dir, 'session.v4.jsonl.zstd')), 'artifact must exist in the project')
    assert.ok(existsSync(join(dir, 'session.lock')), 'the write lease file lives beside the log')

    // Index writes are debounced; the layout assertion waits for the barrier.
    await service.saveIndexNow()

    // The central root keeps only the pointer index, never session data.
    const centralEntries = await readdir(central)
    assert.deepEqual(centralEntries, ['index.json'], 'central root holds only the pointer index')

    const index = JSON.parse(await readFile(join(central, 'index.json'), 'utf8'))
    assert.equal(index.version, 2)
    assert.equal(index.sessions['sess-a'], join(project, '.dsh/sessions'))
  })

  it('ignores the central root layout for sessions without a cwd', async () => {
    const { service, central } = await makeBackend()
    const handle = await service.create(header('sess-no-cwd', undefined))
    await handle.append(events(1))
    await handle.flush()
    await handle.close()

    assert.ok(existsSync(join(central, '_no-cwd/sess-no-cwd/session.v4.jsonl.zstd')))
  })

  it('keeps a session in the central root when its project directory is gone', async () => {
    const { service, central } = await makeBackend()
    const gone = join(scratch, 'never-existed')
    const handle = await service.create(header('sess-gone', gone))
    await handle.append(events(1))
    await handle.flush()
    await handle.close()

    const bucket = (await readdir(central)).find((name) => name.startsWith('--'))
    assert.ok(bucket, 'a project-key bucket must exist in the central root')
    assert.ok(existsSync(join(central, bucket, 'sess-gone', 'session.v4.jsonl.zstd')))
    assert.ok(!existsSync(gone), 'the missing project directory must not be recreated')
  })
})

describe('reads, listing and resume', () => {
  it('reopens a stored session and returns the full event log', async () => {
    const { service } = await makeBackend()
    const project = await mkdtemp(join(scratch, 'project-'))

    const writer = await service.create(header('sess-b', project))
    await writer.append(events(3))
    await writer.flush()
    await writer.close()

    const reader = await service.open('sess-b', 'read')
    const result = await reader.read()
    await reader.close()
    assert.equal(result.events.length, 6)
    assert.deepEqual(result.events.map((event) => event.seq), [0, 1, 2, 3, 4, 5])
  })

  it('appends to a stored session through a write handle', async () => {
    const { service } = await makeBackend()
    const project = await mkdtemp(join(scratch, 'project-'))

    const first = await service.create(header('sess-c', project))
    await first.append(events(1))
    await first.flush()
    await first.close()

    const second = await service.open('sess-c', 'write')
    await second.append(events(1, 2, 2))
    await second.flush()
    await second.close()

    const reader = await service.open('sess-c', 'read')
    const result = await reader.read()
    await reader.close()
    assert.deepEqual(result.events.map((event) => event.seq), [0, 1, 2, 3])
  })

  it('lists sessions across several projects and reports their cwd', async () => {
    const { service } = await makeBackend()
    const projectA = await mkdtemp(join(scratch, 'project-a-'))
    const projectB = await mkdtemp(join(scratch, 'project-b-'))

    for (const [id, cwd] of [['sess-d', projectA], ['sess-e', projectB]]) {
      const handle = await service.create(header(id, cwd))
      await handle.append(events(1))
      await handle.flush()
      await handle.close()
    }

    const snapshots = await service.list()
    const byId = new Map(snapshots.map((snapshot) => [snapshot.header.id, snapshot]))
    assert.equal(byId.size, 2)
    assert.equal(byId.get('sess-d').header.cwd, projectA)
    assert.equal(byId.get('sess-e').header.cwd, projectB)

    const stat = await service.stat('sess-d')
    assert.equal(stat.header.id, 'sess-d')
    assert.ok(stat.sizeBytes > 0)
  })

  it('refuses a duplicate id in another project', async () => {
    const { service } = await makeBackend()
    const projectA = await mkdtemp(join(scratch, 'project-'))
    const projectB = await mkdtemp(join(scratch, 'project-'))

    const handle = await service.create(header('sess-dup', projectA))
    await handle.flush()
    await handle.close()

    await assert.rejects(() => service.create(header('sess-dup', projectB)), /already exists/i)
  })
})

describe('migration out of the central root', () => {
  it('moves a stock-layout session into its project on startup', async () => {
    const central = await mkdtemp(join(scratch, 'central-legacy-'))
    const project = await mkdtemp(join(scratch, 'project-legacy-'))

    // Produce a session exactly as the stock backend lays it out.
    const stockCtx = new Context()
    stockCtx.logger = { warn: () => {}, info: () => {}, error: () => {} }
    const stock = new JsonlSessionPersistence(stockCtx, { root: central })
    const handle = await stock.create(header('sess-legacy', project))
    await handle.append(events(2))
    await handle.flush()
    await handle.close()
    assert.ok(!existsSync(join(project, '.dsh/sessions/sess-legacy')), 'stock layout is central')

    // Booting the project-local backend migrates it in place.
    const ctx = new Context()
    ctx.logger = { warn: () => {}, info: () => {}, error: () => {} }
    const service = new ProjectSessionPersistence(ctx, { root: central })
    await service.migrationDone

    const artifact = join(project, '.dsh/sessions/sess-legacy/session.v4.jsonl.zstd')
    assert.ok(existsSync(artifact), 'the session moved into the project')
    const leftover = (await readdir(central)).filter((name) => name.startsWith('--'))
    assert.deepEqual(leftover, [], 'the emptied legacy bucket is pruned')

    const reader = await service.open('sess-legacy', 'read')
    const result = await reader.read()
    await reader.close()
    assert.equal(result.events.length, 4)
  })

  it('leaves a session whose project directory is gone in the central root', async () => {
    const central = await mkdtemp(join(scratch, 'central-legacy-'))
    const project = await mkdtemp(join(scratch, 'project-legacy-'))

    const stockCtx = new Context()
    stockCtx.logger = { warn: () => {}, info: () => {}, error: () => {} }
    const stock = new JsonlSessionPersistence(stockCtx, { root: central })
    const handle = await stock.create(header('sess-orphan', project))
    await handle.flush()
    await handle.close()
    await rm(project, { recursive: true, force: true })

    const ctx = new Context()
    ctx.logger = { warn: () => {}, info: () => {}, error: () => {} }
    const service = new ProjectSessionPersistence(ctx, { root: central })
    await service.migrationDone

    const reader = await service.open('sess-orphan', 'read')
    await reader.close()
    const snapshots = await service.list()
    assert.ok(snapshots.some((snapshot) => snapshot.header.id === 'sess-orphan'))
  })
})

describe('cross-machine imports', () => {
  it('finds, reads and keeps writing a session copied in from another machine', async () => {
    const first = await makeBackend()
    const sourceProject = await mkdtemp(join(scratch, 'project-source-'))

    const handle = await first.service.create(header('sess-import', sourceProject))
    await handle.append(events(1))
    await handle.flush()
    await handle.close()

    // Simulate the copy: the log moves to another project directory and the
    // original machine's directory disappears. The header still names it.
    const targetProject = await mkdtemp(join(scratch, 'project-target-'))
    await mkdir(join(targetProject, '.dsh'), { recursive: true })
    await cp(join(sourceProject, '.dsh/sessions'), join(targetProject, '.dsh/sessions'), { recursive: true })
    await rm(sourceProject, { recursive: true, force: true })

    const ctx = makeContext([targetProject])
    const service = new ProjectSessionPersistence(ctx, { root: first.central })
    await service.migrationDone

    // Discovery works off the workspace registry, not the header's foreign cwd.
    const reader = await service.open('sess-import', 'read')
    const result = await reader.read()
    assert.equal(result.events.length, 2)
    assert.equal(reader.header.cwd, targetProject, 'the exposed cwd is normalized to the real project')
    await reader.close()

    // Resuming must extend the file that exists, not create one at the stale path.
    const writer = await service.open('sess-import', 'write')
    await writer.append(events(1, 2, 2))
    await writer.flush()
    await writer.close()

    const reread = await service.open('sess-import', 'read')
    const after = await reread.read()
    await reread.close()
    assert.deepEqual(after.events.map((event) => event.seq), [0, 1, 2, 3])
    assert.ok(!existsSync(sourceProject), 'nothing is recreated at the stale cwd')
  })
})

describe('path encoding parity with the stock backend', () => {
  it('encodes session directory segments exactly like the stock layout', async () => {
    const { service } = await makeBackend()
    const id = 'weird/id:with~chars'
    const project = await mkdtemp(join(scratch, 'project-encoding-'))

    const handle = await service.create(header(id, project))
    await handle.flush()
    await handle.close()

    const entries = await readdir(join(project, '.dsh/sessions'))
    assert.deepEqual(entries, ['weird~002Fid~003Awith~007Echars'])

    const reader = await service.open(id, 'read')
    await reader.close()
  })
})

describe('index handling', () => {
  it('rebuilds a corrupt index instead of failing to start', async () => {
    const central = await mkdtemp(join(scratch, 'central-broken-'))
    await writeFile(join(central, 'index.json'), '{ this is not json')
    const { service } = await makeBackend({ central })
    const project = await mkdtemp(join(scratch, 'project-index-'))

    const handle = await service.create(header('sess-index', project))
    await handle.append(events(1))
    await handle.flush()
    await handle.close()
    await service.saveIndexNow()

    const index = JSON.parse(await readFile(join(central, 'index.json'), 'utf8'))
    assert.equal(index.sessions['sess-index'], join(project, '.dsh/sessions'))
  })

  it('reads an index written by the v1 layout', async () => {
    const central = await mkdtemp(join(scratch, 'central-v1-'))
    const project = await mkdtemp(join(scratch, 'project-v1-'))
    await writeFile(join(central, 'index.json'), JSON.stringify({ version: 1, sessions: { legacy: project } }))

    const { service } = await makeBackend({ central })
    assert.equal(service.indexSessions.get('legacy'), join(project, '.dsh/sessions'))
  })
})
