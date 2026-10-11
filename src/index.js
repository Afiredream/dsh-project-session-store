// src/index.js
const path = require('path')
const fs = require('fs/promises')

export const name = 'project-session-store'

// 不注入 sessionPersistence（我们是去替换它的）
export const inject = []

export function apply(ctx) {
  // 替换官方持久化服务
  ctx.set('sessionPersistence', createProjectLocalBackend(ctx))
}

function createProjectLocalBackend(ctx) {
  const dshHome = ctx.env.get('DSH_HOME') || path.join(process.env.HOME || '~', '.dsh')
  const globalSessionsRoot = path.join(dshHome, 'sessions')
  const indexFile = path.join(globalSessionsRoot, 'index.json')

  // 启动时执行一次性迁移
  const migration = migrateLegacySessions(ctx, globalSessionsRoot)

  return {
    // 核心：计算会话文件的真实路径
    locate(meta) {
      const cwd = meta.cwd
      if (!cwd) {
        // 无 cwd 的会话：留在全局目录的 _no-cwd/ 下[citation:1]
        const dir = path.join(globalSessionsRoot, '_no-cwd', meta.id)
        return { kind: 'jsonl', path: path.join(dir, 'session.jsonl.zstd') }
      }
      const dir = path.join(cwd, '.dsh', 'sessions', meta.id)
      return { kind: 'jsonl', path: path.join(dir, 'session.jsonl.zstd') }
    },

    // 创建时注册指针
    async create(meta) {
      const loc = this.locate(meta)
      await fs.mkdir(path.dirname(loc.path), { recursive: true })
      if (meta.cwd) {
        await updateIndex(indexFile, meta.id, meta.cwd)
      }
      return { id: meta.id }
    },

    // 读取：如果全局没有，查指针
    async load(id) {
      // 先尝试从 index 找到项目目录
      const projectDir = await lookupIndex(indexFile, id)
      if (projectDir) {
        const file = path.join(projectDir, '.dsh', 'sessions', id, 'session.jsonl.zstd')
        if (await fileExists(file)) {
          return readSessionFile(file)
        }
      }
      // 回退：全局目录（含 _no-cwd）
      const globalFile = path.join(globalSessionsRoot, id, 'session.jsonl.zstd')
      if (await fileExists(globalFile)) {
        return readSessionFile(globalFile)
      }
      throw new Error(`Session ${id} not found`)
    },

    // 列出：合并项目本地 + 全局残留
    async list() {
      const headers = []
      // 扫 index 里的项目会话
      const index = await readIndex(indexFile)
      for (const [id, dir] of Object.entries(index)) {
        const file = path.join(dir, '.dsh', 'sessions', id, 'session.jsonl.zstd')
        if (await fileExists(file)) {
          headers.push(await readHeader(file))
        }
      }
      // 扫全局残留
      const entries = await fs.readdir(globalSessionsRoot, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (e.isDirectory() && e.name !== '_no-cwd' && !index[e.name]) {
          const file = path.join(globalSessionsRoot, e.name, 'session.jsonl.zstd')
          if (await fileExists(file)) {
            headers.push(await readHeader(file))
          }
        }
      }
      return headers
    },

    async append(id, events) { /* 复用官方写入逻辑，或委托给一个内部 JSONL 实例 */ },
    async ensureMaterialized(session) { /* 同上 */ },
    async flush(id) { /* 同上 */ },
    async close() { await migration },
  }
}

// --- 辅助函数 ---

async function migrateLegacySessions(ctx, globalRoot) {
  const index = await readIndex(indexFile)
  const entries = await fs.readdir(globalRoot, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '_no-cwd') continue
    const sessionDir = path.join(globalRoot, e.name)
    const file = path.join(sessionDir, 'session.jsonl.zstd')
    if (!await fileExists(file)) continue
    try {
      const header = await readHeader(file)
      if (!header.cwd || !await dirWritable(header.cwd)) continue
      const targetDir = path.join(header.cwd, '.dsh', 'sessions', e.name)
      await fs.mkdir(targetDir, { recursive: true })
      await fs.rename(sessionDir, targetDir)
      await updateIndex(indexFile, e.name, header.cwd)
      ctx.logger.info(`Migrated session ${e.name} to ${header.cwd}`)
    } catch (err) {
      ctx.logger.warn(`Failed to migrate ${e.name}: ${err.message}`)
    }
  }
}

async function readHeader(file) {
  // 读取 zstd 第一帧（header 行）
  const content = await fs.readFile(file)
  // 实际需要 zstd 解压，这里示意
  return { id: '...', cwd: '...' }
}