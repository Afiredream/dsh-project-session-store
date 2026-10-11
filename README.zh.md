[English](README.md) | [中文](README.zh.md)

# dsh-project-session-store

DSH（DeepSeek Harness）**2.x** 插件：把每个项目的会话日志保存在**项目目录内**，而不是全部集中到 `~/.dsh/sessions`。

默认情况下 DSH 把所有会话放在中央根目录下：

```
~/.dsh/sessions/<项目键>/<会话 id>/session.v4.jsonl.zstd
```

装上本插件后，会话数据跟着项目走：

```
<项目目录>/.dsh/sessions/<会话 id>/session.v4.jsonl.zstd
```

克隆仓库、打包归档、换一台机器——对话历史都跟着项目一起走。

## 功能一览

| 关注点 | 行为 |
| --- | --- |
| 存储布局 | `<cwd>/.dsh/sessions/<会话 id>/session.v4.jsonl.zstd`，与官方**同格式、同 zstd 帧**，任何官方读取端都能读 |
| 官方后端 | 组合树中 `@deepseek-ai/dsh-session-persistence-jsonl` 那一行被 **禁用**，由本插件提供 `ctx.sessionPersistence` |
| 历史数据 | 首次启动把中央根目录里已有的会话**一次性迁移**进各自的项目目录（按日志头里的 `cwd` 判定） |
| 无法迁移的会话 | `cwd` 已消失、没有 `cwd`、或项目目录不可写的会话留在中央根目录，仍然可读、可续写 |
| 指针索引 | 中央根目录下的 `index.json` 记录 `会话 id -> 项目会话根`，只存指针，绝不存会话数据 |
| Web 界面 | 侧边栏照常按项目分组（项目内会话 + 尚未迁移的残留合并展示） |
| 无 `cwd` 会话 | 仍放在中央根的 `_no-cwd/`，与官方语义一致 |
| 跨机器拷贝 | 整个项目目录（含 `.dsh/sessions/`）拷到别的机器后，会话能被发现、读取、继续写回**同一个文件**；对外暴露的 `cwd` 归一化为本机真实项目目录 |

## 环境要求

- DSH `0.2.0-rc.2` 及同线版本（2.x）
- Node.js ≥ 20

## 安装

```bash
# 本地路径安装（开发/自用）
dsh plugin --profile web add /绝对路径/dsh-project-session-store

# 或发布到 npm 后
dsh plugin --profile web add dsh-project-session-store
```

因为本包在 `package.json` 里声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把包名追加进该 profile 的 `dsh.profile.bundles`，行本身来自包内的 `cordis.patch.yml`。

**必须重启 `dsh web`**：组合树在启动时装配，改动不会热生效。

装好后可用以下命令确认组合结果（不会真正启动服务）：

```bash
dsh --profile web --dump-config | grep -A 2 session-persistence
# - id: session-persistence-jsonl
#   disabled: true
# - id: session-persistence-project-local
#   name: dsh-project-session-store
```

## 配置

插件行接受以下选项，全部可选：

```yaml
- id: session-persistence-project-local
  name: dsh-project-session-store
  config:
    # 中央根：旧数据回退位置 + 指针索引所在目录。默认 $DSH_HOME/sessions
    root: /your/custom/root
    # 项目内的会话子目录名。默认 .dsh/sessions
    projectDirName: .dsh/sessions
    # 物理编码：'zstd'（默认）或 'none'
    compression: zstd
    # 启动时是否把中央根的旧会话迁移进项目。默认 true
    migrateLegacy: true
    # 是否把索引里的会话挂到（或自动创建）对应工作区。默认 true
    reconcileWorkspaces: true
```

注意：patch 层里 `config` 是**整体替换**而非深合并，写 `config` 时把需要的字段写全；只写 `disabled` 才不碰原有 config。

## 2.x 适配要点

DSH 2.x 把 JSONL 后端改成了「**每个会话一个目录 + 不可变 generation 文件**」（`session.vN.jsonl[.zstd]`），并加了基于 `flock` 的**跨进程写锁**。后端里每一条路径都由一个私有 `root` 字段经模块私有函数推导，配置项无法表达「按会话分散存放」，因此本插件采用**继承官方后端 + 精准覆写路径相关方法**的方式：

| 覆写的方法 | 原因 |
| --- | --- |
| `locate`、`assertStoredIdentity` | 由 header 推导「应有的产物路径」 |
| `materialize`、`materializePosix` | 新会话的目录落在哪里 |
| `appendLines`、`repair` | 已物化会话继续写在哪里（跟随文件真实位置） |
| `acquireWriteLease`、`acquireLease` | 写锁锁住哪个目录（**必须在取锁前决定落盘位置**，因为取锁本身会创建目录） |
| `findLog`、`listProjectDirs` | 跨项目根目录的发现 |
| `readGenerationHeader`、`readStoredLog`、`decodeStoredLog`、`prepareStoredMigration` | 对外暴露的 `cwd` 归一化 |

其余全部原样继承：zstd 分帧、格式版本迁移、崩溃尾部修复、持久化屏障、句柄状态机。

### 与 1.x 参考实现的差异

本插件参照 [`@yangzhe1991/dsh-project-session-store`](https://github.com/yangzhe1991/dsh-project-session-store)（面向 DSH 1.x）的思路重写，主要差异：

| 主题 | 1.x 参考实现 | 本实现（2.x） |
| --- | --- | --- |
| 会话产物 | 单文件 `session.jsonl.zstd` | 每会话目录 + generation 文件 `session.v4.jsonl.zstd` |
| 落盘位置判定 | `materialize` 里按 `cwd` 推导 | 提前到 `acquireWriteLease`（取锁会建目录，必须先行判定） |
| 进程互斥 | 无 | 沿用官方 `flock` 写锁，锁在真实所在目录 |
| 迁移单位 | 单个日志文件 | 整个会话目录（含锁文件等会话本地产物） |
| 发现来源 | 指针索引 + 旧布局扫描 | 索引 + **工作区注册表**（`workspaceRegistry.list()`，同步调用，无启动期死锁）+ 旧布局扫描 |
| `cwd` 归一化 | 经索引反查 | 直接由**文件真实路径**推导（索引缺失也能自愈），并回写索引 |
| 父子代理迁移 | 需自行处理 | 官方 generation 层负责，`currentPath` 是目录内相对路径，天然正确 |
| 构建 | TypeScript + esbuild 打包到 `lib/` | 纯 ESM 源码直出，**无构建步骤** |
| 额外配置 | `packChunks`、`preparedSessionCacheSize`、`writeBatchMaxDelayMs` | 这些字段在 2.x 已不存在，改为 `migrateLegacy`、`reconcileWorkspaces` |

## 迁移与回滚

- **一次性迁移是尽力而为且幂等的**：失败的会话留在原处并打印警告，下次启动重试；目标已存在的会话直接跳过。
- **回滚**：在你自己 profile 的 `cordis.patch.yml` 里（用户层在各 bundle 层之后应用，优先级更高）：

  ```yaml
  - id: session-persistence-project-local
    disabled: true
  - id: session-persistence-jsonl
    disabled: false
  ```

  回滚后项目内的会话对官方后端不可见（它们不在中央根下），需要手工搬回或继续使用本插件。

## 注意事项

- **重启才生效**：组合树在启动时装配。
- **指针索引只在「跨项目发现」上不可替代**：删掉 `index.json` 后，下一次 `list()` 只能重建出中央根里那部分；项目内的会话要靠工作区注册表或再次访问该项目才能重新登记。
- **依赖策略**：本插件**不自带**任何 `@deepseek-ai/*` 包，它们都是 peer 依赖，由宿主安装体提供（2.x 的模块解析是「安装体 + profile」双锚点）。这样避免「旧的自装 `dsh-session` 撞上新的 `dsh-llm`」这类混装问题；官方 API 变更时才需要改插件。
- **版本门禁**：2.x 会校验 `peerDependencies` 里 `@deepseek-ai/dsh*` 的范围，所以这里写成有上界的 `>=0.2.0-rc.2 <0.3.0`——宿主升到 0.3.x 时会明确报不兼容，而不是悄悄跑错。

## 开发与测试

无需构建步骤，源码即产物：

```bash
# 让 test/ 能解析到宿主的 @deepseek-ai/* 包
ln -s /path/to/dsh-install/node_modules/@deepseek-ai node_modules/@deepseek-ai

npm test        # 等价于 node --test test/
```

测试用真实 cordis `Context` 驱动真实的 `SessionPersistence` 接口，覆盖：项目内落盘、`_no-cwd` 回退、项目目录消失时的回退、读写与续写、跨项目列举、重复 id 拒绝、中央根一次性迁移、跨机器拷贝后的发现/读取/续写、段编码与官方一致、损坏索引自愈、v1 索引兼容。

## 许可

MIT
