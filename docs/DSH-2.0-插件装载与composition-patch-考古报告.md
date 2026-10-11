# DSH 2.0 插件装载与 composition patch 机制考古报告

> 对象：已发布的 npm 包 `@deepseek-ai/*`（CLI 包 `@deepseek-ai/dsh` 版本 **0.2.0-rc.2**，cordis **4.0.4**）。
> 方法：只读编译产物（`lib/*.js`、`lib/types/*.d.ts`），辅以随包发布的 `src/`（cordis、cordis-plugin-loader、cordis-plugin-include 三个包带源码）与随包发布的官方 skill 文档。
> 未修改任何文件。

## 路径简写

| 简写 | 实际路径 |
|---|---|
| `$D` | `/home/软件/软件仓库/DeepseekHarness/软件/node_modules/@deepseek-ai` |
| `$PROF` | `/home/软件/软件仓库/DeepseekHarness/数据/.dsh/profiles/web`（本机 `$DSH_HOME` = `/home/软件/软件仓库/DeepseekHarness/数据/.dsh`） |
| `$SKILL` | `$D/dsh-agent-preset/skills`（官方随包 skill：`cordis-plugin-development` / `cordis-composition-reference` / `editing-cordis-compositions`） |
| `$REF` | `/home/dsh友好工作区/.tmp-ref/package`（本机已有的第三方 bundle 样本 `@yangzhe1991/dsh-project-session-store`，正好就是"替换官方 JSONL 行"的实例） |

---

## 0. 结论速览

1. **`dsh.bundle.patch` 在 2.0 里完全有效，而且是 bundle 的唯一声明方式**：读取点在 `@deepseek-ai/dsh-app-boot`（`$D/dsh-app-boot/lib/index.js:495-509`、`:920-947`），支持**一个文件或有序文件列表**，文件缺失即启动报错。
2. **patch 文件 = 顶层 YAML 数组**，元素是 `PatchOptions`：`{id?, name?, insert?, config?, disabled?, group?, inject?, intercept?, isolate?, ...}`；语义实现只有一处 —— `applyEntryPatches()`（`$D/cordis-plugin-include/lib/index.js:56-105`）。`insert` 无 `id` 追加到顶层、有 `id` 追加进 `group: true` 的行；非 insert 补丁按 `id` 定位、逐字段覆盖（**`config` 整体替换**），`name` 只用于断言。
3. **官方 base 里的会话持久化行 id 就是 `session-persistence-jsonl`，2.0 依然存在**：`$D/dsh-base/cordis.patch.yml:130-133`，`config.root: !!js dshHomePath('sessions')`（即 `$DSH_HOME/sessions`）。另有相关行 `session`（dsh-session）、`session-log-deepseek`、`session-query-sqlite`、`session-projection-cache` 等。**注意**：`dsh-sdk-minimal` 这个 bundle 里同一个后端用的 id 是 `sessions`（`$D/dsh-sdk-minimal/cordis.patch.yml:154-157`），写补丁时按 profile 实际组合树来。
4. **`dsh plugin --profile <name> add <pkg>` = 在 profile 目录里跑 pnpm + 自动把"新装的、声明了 `dsh.bundle` 的依赖"追加进 `dsh.profile.bundles`**；**插件行不是 CLI 写进去的，而是由该 bundle 自己的 `cordis.patch.yml` 的 `insert` 提供**。profile 目录 = `$DSH_HOME/profiles/<name>/`（`package.json` + `cordis.patch.yml` + `cordis.yml`（空数组根）+ `pnpm-workspace.yaml` + `node_modules/`）。
5. **后端插件入口 = Service 子类的 default export**（三个官方后端一致），也接受 `export function apply(ctx, config)` 形式。按 `name` 加载 = Loader `import()` 该 specifier → `unwrapExports` 取 `default ?? namespace` → `registry.plugin(plugin, config)`；profile 装的包从 `$PROF/node_modules` 解析，官方包从 dsh 安装体解析。
6. **Service/Context API 与 1.x（0.1.x 线）在"类插件"这一层几乎没变**（1.x 的 `@deepseek-ai/cordis` 已是 4.0.1，`Service` 构造函数签名、`static Config`(schemastery)、`static inject` 完全一致）；**变的是组合/装载层**（1.5 的 link backend 投影 → 2.0 的 pnpm + `dsh.profile.bundles` + 版本兼容门禁）**以及各 Service 自己的契约**（例：`ctx.sessionPersistence` 从 meta/event 接口变成 handle 接口，并新增 `identity` 符号）。

---

## 1. 第三方插件如何声明 composition patch：`dsh.bundle.patch`

**结论：2.0 仍然支持，形状不变**（字符串或字符串数组）。

### 1.1 官方 bundle 自己就这么写

`$D/dsh-base/package.json`：

```json
"exports": { ".": {...}, "./cordis.patch.yml": "./cordis.patch.yml", "./package.json": "./package.json" },
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

`$PROF/node_modules/dsh-cost-meter/package.json`（真实第三方）：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" }, ... }
```

### 1.2 读取该字段的代码路径（完整链路）

1. **CLI 启动** `$D/dsh/lib/profile-boot-BZ2ZjNWi.js`
   - `:185-191 prepareProfile()` → `loadProfile("dsh", name, INSTALL_ANCHOR, ...)`，并把 profile 根配置 `cordis.yml` 重写为 `[]`（注释见 `:121-125`、`:171-178`：整棵树都是"在空数组上叠 patch"）。
   - `:205-216 composeProfile()` → `createRuntimeResolution({installAnchor, profile})` + `loadOverlayPatches(...)`（`--patch`）。
   - `:271-281 boot(NAME, rootConfig, readProfilePatches(NAME, profileContext, composed.profile), ...)`。
2. **patch 层顺序** `$D/dsh-app-boot/lib/index.js:1023-1035 readProfilePatches()`
   ```js
   const patches = structuredClone([
     ...profile.layers.flatMap((layer) => layer.patches),   // ← 各 bundle 的 dsh.bundle.patch
     ...initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? [],  // profile 的 cordis.patch.yml
     ...loadOptionalPatches(binName, join(context.home, "cordis.patch.yml")) ?? [],        // $DSH_HOME/cordis.patch.yml
     ...context.overlays                                                                   // --patch
   ]);
   ```
   （另加 telemetry 开关补丁 `:1017-1021 resolveTelemetryPatch`，用于把 `session-telemetry-otel` 行 `disabled: true`。）
3. **bundle 声明解析** `$D/dsh-app-boot/lib/index.js:488-509`
   ```js
   function bundlePatchFiles(bundle) {
     const declared = typeof bundle.patch === "string" ? [bundle.patch] : bundle.patch;
     if (!Array.isArray(declared) || !declared.every((file) => typeof file === "string"))
       throw new Error("dsh.bundle.patch must be a file path or a list of file paths");
     return declared;
   }
   function bundlePatchPaths(packageDir, bundle) { return bundlePatchFiles(bundle).map((file) => join(packageDir, file)); }
   ```
4. **装配各 bundle 层** `$D/dsh-app-boot/lib/index.js:920-947 loadProfileDirectory()`
   ```js
   const bundles = readProfileManifest(binName, dir).dsh?.profile?.bundles ?? [];   // :921
   for (const packageName of bundles) try {
     const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir); // :926 安装体优先、其次 profile
     const bundle = bundleManifest.dsh?.bundle;                                    // :928
     if (bundle === void 0) throw new Error(`... declares no dsh.bundle in its package.json`); // :929
     const patchPaths = bundlePatchPaths(packageDir, bundle);                      // :932
     const patches = patchPaths.flatMap((patchPath) => loadOverlayPatches(binName, patchPath)); // :933
     layers.push({ packageName, packageDir, patchPaths, patches });
   } catch (error) { skippedBundles.push({ packageName, reason: String(error) }); }  // 坏 bundle = 跳过并发警告
   ```
5. **文件读取/解析** `$D/dsh-app-boot/lib/index.js:3518-3571`
   - `loadOverlayPatches()`：**文件不存在 → 抛错**（bundle 自己声明的补丁是"必需文件"）；`--patch`/profile 的 `cordis.patch.yml` 走 `loadOptionalPatches()`（缺文件 = 无该层）。
   - `parsePatchList()`：`yaml.load(content, { schema: userPatchesSchema })`，其中 `userPatchesSchema = entryListSchema`（`:3460`）；**必须是顶层数组**，每个元素必须是 mapping，否则抛错（`:3566-3569`）。
   - `anchorInsertedPluginNames()`（`:3536-3545`）：`insert` 里以 `./`、`../` 或绝对路径写的 `name` 会被改写成"相对该 patch 文件"的 `file://` URL。
6. **运行时装配**：`$D/dsh/lib/profile-boot-BZ2ZjNWi.js:275` 挂载 `PluginPackages`（提供运行期模块解析），`:271` `boot()` 内 `mountRootInclude()`（`$D/dsh-app-boot/lib/index.js:3691-3719`）把整棵树作为 root include 的 `config.patches` 挂上，由 `@deepseek-ai/cordis-plugin-include` 的 `applyEntryPatches()` 一次性应用。

### 1.3 顺手可得的事实

- **bundle 必须被列进 `dsh.profile.bundles`**（profile 的 `package.json`）才会生效；顺序即层顺序，后面的层压前面的。
- **坏的/不兼容的 bundle 不炸整机**：进 `skippedBundles`，启动时 `reportSkippedBundles()` 打警告（`$D/dsh/lib/profile-boot-BZ2ZjNWi.js:188`、`$D/dsh-app-boot/lib/index.js:515-517`）。
- **安装期就会预校验补丁文件可解析**：`$D/dsh-plugin-manager/lib/types/operations.js:206-235 bundleComponentManifests()` 会 `loadOverlayPatches()` 每个 patch 文件，坏补丁直接让 `dsh plugin add` 失败。

---

## 2. `cordis.patch.yml` 的 YAML 语法与支持的字段全集

### 2.1 语义实现（唯一权威）

`$D/cordis-plugin-include/lib/index.js:56-105`：

```js
function applyEntryPatches(data, patches, warn) {
  if (!patches?.length) return [...data];
  data = structuredClone(data);                       // 不改输入
  const entryMap = new Map();
  const buildMap = (entries) => { for (const entry of entries) {
      if (entry.id) entryMap.set(entry.id, entry);
      if (entry.group && Array.isArray(entry.config)) buildMap(entry.config);  // 组内行也建索引
  } };
  buildMap(data);
  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch;
    if (insert) {
      if (id) {
        const target = entryMap.get(id);
        if (!target)          { warn("patch insert: entry %C not found", id); continue; }
        if (!target.group)    { warn("patch insert: entry %C is not a group", id); continue; }
        if (!Array.isArray(target.config)) target.config = [];
        target.config.push(...insert);                 // 插进组
      } else data.push(...insert);                     // 插到顶层
      buildMap(insert);                                // 同层后续补丁可以命中新插入的 id
      continue;
    }
    if (!id) { warn("patch: id is required for non-insert patches"); continue; }
    const target = entryMap.get(id);
    if (!target) { warn("patch: entry %C not found", id); continue; }
    if (name && name !== target.name) { warn("patch: name mismatch for %C ...", ...); continue; }
    for (const [key, value] of Object.entries(overrides)) target[key] = value;   // 逐字段覆盖
  }
  return data;
}
```

关键推论：

- **`disabled: true` 是"非 insert 补丁 + id"**，不是独立语法：`- id: session-persistence-jsonl` + `disabled: true`。
- **`config` 是整体替换，不是深合并**（`:99-102` 直接赋值）；只写 `disabled` 的补丁不会碰到 `config`。
- **`name` 是断言**（`:95-98`）：写错名字会 warn + 跳过，不会改名。
- **匹配不到的行只 warn，不抛错**（`:86-94`）——所以一份 overlay 可以跨多个 profile 复用。
- **插入顺序敏感**：`buildMap(insert)` 让同一条补丁列表里后面的补丁能命中前面刚插入的 id（`:83`）。

### 2.2 字段全集

`PatchOptions`（`$D/cordis-plugin-include/lib/types/index.d.ts:23-33`）：

```ts
export interface PatchOptions {
    id?: string;
    insert?: EntryOptions[];
    name?: string;
    config?: any;
    group?: boolean | null;
    disabled?: boolean | null;
    inject?: any;
    intercept?: any;
    isolate?: any;
    [key: string]: any;      // 其余键直接写进目标行
}
```

`EntryOptions`（**行**的形状，`$D/cordis-plugin-loader/src/config/entry.ts:10-24`，注释原文）：

```ts
export interface EntryOptions {
  id: string                 // Stable id inside the containing entry tree.
  name: string               // Module specifier imported by the entry tree.
  config?: any               // Config passed to the plugin.
  group?: boolean | null     // Marks this entry as a nested group.
  disabled?: boolean | null  // Prevents this entry and descendants from running.
  inject?: Inject | null     // Required services or service intercept config for this entry.
}
```

官方 skill 对同一方言的权威描述（`$SKILL/cordis-composition-reference/SKILL.md:12-25`，中文要点）：

- `insert: [rows]` 追加行；配 `id` 指到一个 `group: true` 的行则插进该行 `config` 列表里。
- 有 `id` 无 `insert` = 覆盖该行；**`config` 整体替换，必须把该行需要的字段全部重述**；truthy 的 `name` 是断言而非改名。
- 非 insert 补丁缺 `id`、或目标不存在 → 警告并跳过。
- 行字段：`id`、`name`（插件包 specifier；插入时的相对路径按 patch 文件所在目录锚定）、可选 `config`、`disabled`、`inject`、`intercept`、`isolate`。
- `group: true` + `name: cordis:group` 让 `config` 成为嵌套 entry list；`cordis:include` 从 `config.path` 加载字面 YAML/JSON。
- `disabled` 接受布尔、`null` 或 `!!js` 表达式；**被禁用的行会省略 required `config`**（除非 `group: true` 强制激活）。
- `isolate` 把服务名映射到 `true` 或一个 realm 标签（provider 与消费者一起隔离）。

### 2.3 `!!js` 表达式（注意是双感叹号）

- 注册自定义 tag：`$D/cordis-plugin-include/lib/index.js:15-27`
  ```js
  const JsExpr = new yaml.Type("tag:yaml.org,2002:js", {
    kind: "scalar", resolve: (data) => typeof data === "string",
    construct: (data) => ({ __jsExpr: data }), predicate: isJsExpr, represent: (data) => data["__jsExpr"] });
  const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr);
  ```
- 求值：`$D/cordis-plugin-loader/src/config/utils.ts:5-9`
  ```js
  export const evaluate = new Function('ctx', 'expr', `with (ctx) { return eval(expr) }`)
  ```
- 求值时机：**行激活时、以该行自己的 ctx 为作用域**（`$D/cordis-plugin-loader/lib/index.js:600-609`，`internal/config` waterfall 里 `interpolate(this.ctx, config)`），所以 `ctx.get('profileContext')`、服务属性、以及 root 上 provide 的 `dshHomePath` 都能用。
- `dshHomePath` 的来源：`$D/dsh-app-boot/lib/index.js:4071` `ctx.provide("dshHomePath", dshHomePath)`；实现 `$D/dsh-home-paths/lib/index.js:82-84` = `join(resolveDshHome(), ...segments)`。
- 本机实测（只读，用已安装的 cordis 起一个空 Context）：
  ```
  dshHomePath('sessions') => "/DSH/sessions"
  !ctx.get('profileContext') => false
  ctx.profileContext.name => "web"
  ```
- 注意 skill 的提醒：**`!!js`，不是 `!js`**；`config` 里的 `!!js` 在注入之后求值，行元数据（`id`/`name`/`disabled` 之外的字段）保持字面量。

### 2.4 一个真实的 patch 文件长什么样

`$PROF/node_modules/dsh-cost-meter/cordis.patch.yml`（第三方 bundle，逐字）：

```yaml
# dsh-cost-meter bundle patch: one host row over the Web or Desktop profile.
# The row name resolves from the profile's own node_modules where
# `dsh plugin --profile <profile> add <path>` installed this package.
- insert:
    - id: cost-meter
      name: dsh-cost-meter
```

`$D/dsh-base/cordis.patch.yml:1-22`（官方 base：一次大 insert）与 `:130-133`（带 `!!js` 的 config）。

---

## 3. 官方 base 组合树里"会话持久化"那一行

**id：`session-persistence-jsonl`（2.0 仍存在）**

`$D/dsh-base/cordis.patch.yml:128-133`：

```yaml
    - id: session-persistence-jsonl
      name: '@deepseek-ai/dsh-session-persistence-jsonl'
      config:
        root: !!js dshHomePath('sessions')
```

- `root` = `$DSH_HOME/sessions`（`dshHomePath()` 实现见 `$D/dsh-home-paths/lib/index.js:82-84`；本机实际存在 `/home/软件/软件仓库/DeepseekHarness/数据/.dsh/sessions`）。
- 后端要求 `root` 必填、无默认：`$D/dsh-session-persistence-jsonl/lib/index.js:2374-2377`
  ```js
  static Config = z.object({ root: z.string().required(), compression: JsonlCompressionSchema });
  ```
  d.ts 注释（`$D/dsh-session-persistence-jsonl/lib/types/index.d.ts`）："Required (no default): a default of `process.cwd()` would scatter session files…"。
- **同一个后端在另一个 bundle 里换了 id**：`$D/dsh-sdk-minimal/cordis.patch.yml:154-157`
  ```yaml
      - id: sessions
        name: '@deepseek-ai/dsh-session-persistence-jsonl'
        config:
          root: !!js dshHomePath('sessions')
  ```

### 3.1 其它相关行（base 内，同文件）

| 行 id | 包 | 位置 |
|---|---|---|
| `session` | `@deepseek-ai/dsh-session`（事件源会话本体） | `dsh-base/cordis.patch.yml:40-41` |
| `session-log-deepseek` | `@deepseek-ai/dsh-session-log-deepseek`（请求侧日志扩展） | `:43-44` |
| `session-title` / `session-title-llm` | `dsh-session-title` / `…-first-prompt-llm` | `:55-69` |
| `session-query-sqlite` | `dsh-session-query-sqlite`（全文检索，默认 `path: ':memory:'`、`openAt: never`） | `:149-153` |
| `session-projection` / `session-projection-cache` | 投影与持久化投影缓存 | `:158-186` |
| `session-telemetry-otel` | 反馈授权的日志上报（`DSH_TELEMETRY_DISABLED` 时被启动器置 `disabled`） | `:204-218`，开关实现 `dsh-app-boot/lib/index.js:1017-1021` |
| `session-checkpoint-policy` | 每回合前的持久化检查点 | `:413-414` |
| `attachment-local` | 图片等附件字节（与会话日志分离） | `:138-139` |

Web bundle 另外插入 `session-log-download`（`$D/dsh-web-app/cordis.patch.yml:75-76`）并 patch `session-query-sqlite`（`:27`）。

### 3.2 本机真实组合树已经有一个"替换该行"的实例

`$PROF/cordis.patch.yml`（用户层）：

```yaml
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: session-persistence-project-local
  disabled: false
```

即第三方 bundle 插入的行 id 是 `session-persistence-project-local`（见 `$REF/cordis.patch.yml`），用户层再把它显式打开。

---

## 4. `dsh plugin add` 与 profile 目录结构

### 4.1 目录结构

`$D/dsh-app-boot/lib/index.js:524-527`：`resolveProfileDir(name) = $DSH_HOME/profiles/<name>`（名字里不允许 `/`、`\`、`.`、`..`、`node_modules`）。
`$D/dsh-app-boot/lib/index.js:576-592 initProfile()` 首次创建三个文件：

```js
const manifest = { name: `dsh-profile-${basename(dir)}`, private: true, dependencies: {},
                   dsh: { profile: { bundles: [...bundles] } } };
writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, void 0, 2) + "\n");
// cordis.patch.yml ← PROFILE_PATCH_TEMPLATE（空数组 + 注释）
// pnpm-workspace.yaml ← "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n"
```

`cordis.yml` 由启动器**每次启动重写为空数组**（`$D/dsh/lib/profile-boot-BZ2ZjNWi.js:121-125`、`:189`、`:207`），注释明说"编辑 `cordis.patch.yml`，不要编辑这个文件"。

本机实例 `$PROF/`：

```
package.json          # dsh.profile.bundles: [dsh-base, dsh-web-app, dsh-default-workspace, dshmarket, @deepseek-harness-tui/dsh-tui, dsh-connect-workbuddy, dsh-cost-meter] + dependencies
cordis.patch.yml      # 用户层补丁（上面那份）
cordis.yml            # []（启动器重写的空根）
pnpm-workspace.yaml   # packages: [.] / nodeLinker: hoisted / autoInstallPeers: false (+ minimumReleaseAgeExclude)
pnpm-lock.yaml
node_modules/         # 第三方 bundle 装在这里（含 dsh-cost-meter、dshmarket…）
.plugin-manager/      # 运行记录与 pnpm 日志
.dsh-market/
```

### 4.2 CLI 到 pnpm 的链路

1. `$D/dsh/lib/bin.js:118-129`：`dsh plugin --profile <name> <pnpm args...>` 子命令，`--profile` 必填，其余参数**原样转发**；`plugin` 是唯一不是 `--profile <name>` 缩写的入口（`HELP_EXAMPLES` 见 `:37-46`）。
2. `$D/dsh/lib/plugin-BGnVfe_D.js:63-99 runPlugin()`：
   - 先截获 DSH 自己的 `allow-version` / `revoke-version` / `version-exemptions`（`:14-56`）；
   - 组装 `context = { profile, dir: resolveProfileDir(profile), installAnchor: INSTALL_ANCHOR, cwd: process.cwd() }`（`:74-79`）；
   - 调 `runPluginCommand(context, args, options)`（`:93`），`execution: "cli"` 表示继承终端与认证环境变量。
3. `$D/dsh-plugin-manager/lib/types/operations.js:526-537 runPluginCommand()`：
   ```js
   const dir = context.dir ?? resolveProfileDir(context.profile, context.home);
   await mkdir(dir, { recursive: true });
   return withFileLock(join(dir, 'package.json'), async () => {
     if (!existsSync(join(dir, 'package.json'))) {
       initProfile(dir, PROFILE_TEMPLATES[context.profile]?.bundles ?? DEFAULT_PROFILE_BUNDLES);
       options.onOutput?.(`dsh: initialized profile ${context.profile} at ${dir}\n`, 'stderr');
     }
     return runProfilePnpm(context, args, options);
   }, ...);
   ```
4. `runProfilePnpm()`（`:246-519`）：
   - 记录"正在运行的 pnpm"（`.plugin-manager/logs/run-*.json`）防止并发改写；
   - **安装前预检**：对 `add/install/i` 的具名 spec 读 manifest 并跑 `evaluatePluginCompatibility()`（`:300-319`），不兼容直接拒绝、什么都不装（`namedSpecManifest` 对 registry spec 用 `pnpm view … peerDependencies --json`，`:123-133`）；
   - 本地相对路径 spec 按**调用者 cwd** 锚定（`anchorPathSpec`，`:19-24`），不是在 profile 目录里解析；
   - `execa(pnpm, args, { cwd: dir, ... })` 真正执行；退出码 0 且未被 stall 时才做安装后校验与激活；
   - **安装后**：再次校验新装的直接依赖及其 bundle 组件的兼容性（`:443-479`），不通过则回滚 `package.json`/`pnpm-lock.yaml` 并重装（`:480-502`）；通过则 `reconcile(before, dir, installAnchor, options)`（`:503-505`）。
5. `reconcile()`（`:44-72`，**这就是"插件行如何被加入组合树"的机制答案**）：
   ```js
   const dependencies = Object.keys(after.dependencies ?? {});
   const beforeDeps = new Set(Object.keys(before.dependencies ?? {}));
   const previous = after.dsh?.profile?.bundles ?? [];
   const bundles = previous.filter((name) => {                       // 被删掉/失去 bundle 声明的条目清出
     if (!beforeDeps.has(name) && !dependencies.includes(name)) return true;
     return dependencies.includes(name) && bundleManifest(name, dir, anchor) !== undefined;
   });
   for (const name of dependencies) {
     if (beforeDeps.has(name)) continue;                             // 老依赖不重新激活
     const metadata = bundleManifest(name, dir, anchor);             // :31-35 读 dsh.bundle.patch
     if (metadata?.dsh?.bundle === undefined) {
       options.onOutput?.(`dsh: warning: ${name} declares no dsh.bundle — installed as a plain dependency, not a profile layer\n`, 'stderr');
       continue;
     }
     for (const file of bundlePatchPaths(resolveBundleDir('dsh', name, anchor, dir), metadata.dsh.bundle))
       loadOverlayPatches('dsh', file);                              // 坏补丁 → 安装失败
     if (!bundles.includes(name)) bundles.push(name);
   }
   after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles } };
   await saveManifest(dir, after);                                   // 原子写回 profile/package.json
   ```
   → **`dsh plugin add` 只做两件事：装包 + 把包名追加进 `dsh.profile.bundles`。真正的"行"由该 bundle 的 `cordis.patch.yml` 里的 `insert` 提供。**

### 4.3 组合树的增删开关

- 单行开关（Web 插件管理器 / `plugin_manager` 工具走这里）：`$D/dsh-plugin-manager/lib/types/patch.js:13-49 writePluginEnabled()`
  - 用 `yaml.parseDocument` 保留注释，找**最后一个** `id` 相同、无 `insert` 的补丁（`name` 若写了要匹配），把 `disabled: !enabled` 写进去；找不到就追加 `- id: <id>\n  disabled: true`。
  - 写前用 `loadOptionalPatches('dsh', filename)` 复验文件可解析。
- bundle 级开关：改 `dsh.profile.bundles`（`$D/dsh-plugin-manager` 服务与 `plugin_manager` 工具；`set_bundle` 报 `overridden` 表示被更高优先层压住）。
- 运行中生效：profile patch 文件由 `dsh-hmr` 监视后重合成（`$D/dsh/README.md` Profiles 段）；bundle 列表变化通常要重启。
- 1.x 遗留清理：`$D/dsh-app-boot/lib/index.js:593-611` 会删掉 dsh **0.1.5** 时代 link backend 投影在 profile 里的 `.dsh-module-fallback` 符号链接——**这正是 1.x → 2.0 装载方式变化的直接证据**。

---

## 5. 插件包的入口导出约定（三个官方后端对比）

### 5.1 Loader 侧规则

- 行 `name` 就是"被 entry tree import 的模块 specifier"（`$D/cordis-plugin-loader/src/config/entry.ts:15-16`）。
- `$D/cordis-plugin-loader/src/config/entry.ts:221-235`：`exports = await parent.tree.import(options.name, …)` → `loader.unwrapExports(exports)` → `ctx.registry.plugin(plugin, options.config)`。
- `unwrapExports`（`$D/cordis-plugin-loader/src/index.ts:200-208`）：**`exports.default ?? exports`**，并处理 esbuild CJS interop。
- 类插件实例化（`$D/cordis/src/fiber.ts:251-261`）：
  ```js
  if (isConstructor(runtime.callback)) {
    const instance = new runtime.callback(this.ctx, this.config)
    for (const hook of instance?.[symbols.initHooks] ?? []) hook()
    return instance?.[symbols.init]?.()
  } else { return runtime.callback(this.ctx, this.config) }
  ```
  → **类 = `new Plugin(ctx, config)`；函数/对象 = `apply(ctx, config)`**；类还可以声明静态 `[Service.init]` 生成器做异步初始化（`Include` 就是这么做的，见 `$D/cordis-plugin-include/lib/types/index.d.ts:70`）。
- 官方 skill（`$SKILL/cordis-plugin-development/references/host-plugin.md:47-54`）明确的两种导出形态，**不要混用**：
  1. `export function apply(ctx, config) {}`，可选 `export const inject = ['tools']`、`export const Config`；
  2. **a service class as the default export**。

### 5.2 三个官方后端逐字对比

| | 会话持久化 | 文件系统 | bash 执行器 |
|---|---|---|---|
| 包 | `dsh-session-persistence-jsonl` | `dsh-fs-local` | `dsh-bash-local` |
| 导出 | `export { JsonlCompressionSchema, JsonlSessionPersistence as default }` | `export { LocalFileSystem, LocalFileSystem as default }` | `export { ENV_OVERRIDES, LocalBashExecutor, LocalBashExecutor as default, assertServiceableBashConfig }` |
| 基类 | `class extends SessionPersistence`（`:2372`） | `class extends FileSystem`（`:725`） | `class LocalBashExecutor extends ShellExecutor`（`:66`） |
| Config | `static Config = z.object({ root: z.string().required(), compression: JsonlCompressionSchema })`（`:2374`） | `static Config = z.object({ cwd: z.string().default(process.cwd()), diffBasisMaxBytes: z.number().default(…) })`（`:751`） | `static Config = z.object({ cwd: z.string().volatile(), timeoutMs: z.number().default(12e4).volatile(), … })`（`:69`；支持 volatile 热更新） |
| inject | 无 | 无 | `static inject = ["subprocess"]`（`:68`） |
| 构造 | `constructor(ctx, config) { super(ctx); … }`（`:2395`） | `constructor(ctx, config) { super(ctx); … }`（`:763`） | `constructor(ctx, config) { super(ctx); … }`（`:77`） |
| 服务名 | d.ts：**"Load as a plugin; it registers as `ctx.sessionPersistence`"**；并额外 `readonly name = "session-persistence-jsonl"` 只作诊断标签（`:2378-2379`，不改服务键） | 注册 `ctx.fs`（decoration 描述 "Host-filesystem implementation of `ctx.fs`"） | 注册 `ShellExecutor` 的服务键（executor seam） |

对照：`$D/dsh-session-persistence/lib/index.js:262-266`

```js
var SessionPersistence = class extends Service {
	/** Process-local instance identity, stable through Context proxies and distinct after service replacement. */
	identity = Symbol("sessionPersistence");
	constructor(ctx) { super(ctx, "sessionPersistence"); }
};
```

**结论（"能被组合树按 name 加载的后端插件"最小写法）**：

1. package.json：`"type": "module"` + `exports` 的 `"."` 指向 `lib/index.js`（或 `main`）+（想当 bundle 的话）`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`；包名必须是能被 profile `node_modules` 或 dsh 安装体解析到的 npm 名。
2. `lib/index.js`：**类 + `static Config`(schemastery) + `constructor(ctx, config)` + `export default 类`**；在构造函数里 `super(ctx, …)` 注册服务。
3. 只实现能力接口本身，其余交给 Loader：配置校验/default（`resolveConfig`）、注入（`static inject`）、卸载（服务随 fiber 注销）、`!!js` 求值。
4. 走"函数式"也可以：`export function apply(ctx, config)` + `export const Config` / `export const inject`，`ctx.effect()/ctx.on()` 里注册资源并返回清理函数（skill 原话）。

---

## 6. 2.0 的 Service/Context API 与 1.x（0.1.x 线）的差异

> 说明：本机没有独立的"cordis 1.x"产物；能拿到的 1.x 侧证据是 `@deepseek-ai/dsh-*@0.1.0-rc.6`（完整一套，位于 `/home/软件/软件仓库/DshTui/代码/vendor/dsh-std/node_modules/.pnpm/`）与 `@deepseek-ai/dsh-session-persistence@0.1.1-rc.2`、`@deepseek-ai/cordis@4.0.1`（`/home/软件/软件仓库/DshTui/代码/node_modules/.pnpm/`）。也就是说 **0.1.x 用的已经是 cordis 4.0.1**，2.0 是 cordis 4.0.4。

### 6.1 没变的部分（有 0.1.x 产物对照）

| 项 | 1.x（0.1.0-rc.6 / 0.1.1-rc.2） | 2.0（0.2.0-rc.2） |
|---|---|---|
| `Service` 构造 | `@deepseek-ai/cordis@4.0.1` `src/service.ts:42` `constructor(protected ctx: Context, name: string)`，`ctx.reflect.provide(name, self, this[Service.check])` | `@deepseek-ai/cordis@4.0.4` `src/service.ts:42-59` **逐字相同** |
| 服务注册方式 | `class X extends Service { constructor(ctx){ super(ctx, "name") } }`（如 `dsh-storage@0.1.0-rc.6` `lib/index.js:104-109` → `super(ctx,"storage")`） | 同理（`dsh-session-persistence/lib/index.js:265` `super(ctx,"sessionPersistence")`） |
| `static Config` + schemastery | `dsh-tools@0.1.0-rc.6/lib/index.js:2546-2548`：`static inject = ["systemPrompt"]; static Config = z.object({…})`，构造 `constructor(ctx, config = {}) { super(ctx, "tools") … }` | 三个后端全部 `static Config = z.object({…})`（见 §5.2） |
| 配置校验 | cordis `resolveConfig`（下） | 同 |
| 类/函数两种插件形态 | 有 | 有 |
| `ctx.sessionPersistence` 注册 | `dsh-session-persistence@0.1.1-rc.2` `lib/index.js:1349-1352`：`class extends Service { constructor(ctx){ super(ctx,"sessionPersistence") } }` | 同名服务键，`super(ctx,"sessionPersistence")` |

配置校验（两代一致）`$D/cordis/src/fiber.ts:50-62`：

```js
export function resolveConfig(runtime: Plugin.Runtime, config: any) {
  if (!runtime.Config) return config
  const result = runtime.Config['~standard'].validate(config)      // schemastery 的标准 schema 协议
  if ('then' in result) throw new TypeError('Async config validation is not supported')
  if (result.issues) throw new ValidationError(result.issues)     // 报错形态：invalid config:\n - msg (at path)
  else return result.value                                        // 默认值在这里被填上
}
```

`ctx.get(...)` / `ctx.provide(...)` / `ctx.inject` / `ctx.effect` 都来自 cordis 的 ReflectService/Registry 混入（`$D/cordis/src/context.ts:25-31`，`:74` `new Proxy(this, ReflectService.handler)`；`registry.ts:107-108` 里函数式插件的 `provide?: string | string[]`）。

### 6.2 变了的（明显变化）

1. **组合/装载层换代（最实质的变化）**
   - 1.x：profile 由 **link backend** 把 bundle 携带的包投影进 profile（残留目录正好叫 `.dsh-module-fallback`，2.0 启动时会清理它——`$D/dsh-app-boot/lib/index.js:593-611`；第三方 README 也描述了 "$DSH_HOME/profiles/node_modules, maintained by the harness" 的 peer 解析）。
   - 2.0：profile 是一个真正的 pnpm 项目 + **`dsh.profile.bundles` 有序层列表** + **`dsh.bundle.patch`**；解析优先级"安装体 → profile 的 `node_modules`"，并由 `PluginPackages` 做进程内运行期拦截（`$D/dsh/lib/profile-boot-BZ2ZjNWi.js:275`；`$D/dsh-app-boot/lib/index.js:731-… createRuntimeResolution`、`:3208-… class PluginPackages`）。
   - 2.0 新增**版本兼容门禁**：`peerDependencies` 里所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 都会被比对运行版本（`$D/dsh-app-boot/lib/index.js:286-313 evaluatePluginCompatibility`，预发布版也参与 range，`workspace:^` 视为"当前运行版本"），不满足就必须 `dsh plugin allow-version <pkg@ver> --dsh-version <ver> --accept-risk` 逐版本豁免。
2. **`ctx.sessionPersistence` 的契约重写**（同一个服务键，不同接口）
   - 0.1.1-rc.2（`.../dsh-session-persistence@0.1.1-rc.2/.../lib/types/index.d.ts:60-98`）：`create(meta)`、`locate(meta)`、readRaw/supportsRawArtifacts、`list()` 等"header/事件"风格接口；主包还导出 `PersistenceCoordinator`、`DEFAULT_PREPARED_SESSION_CACHE_SIZE`。
   - 0.2.0-rc.2：**handle 化**——`create/open` 返回 per-session `SessionHandle`，`stat/list` 返回 `SessionPersistenceSnapshot`，新增 `SessionAlreadyExistsError`/`SessionAlreadyOwnedError`/`SessionHandleClosedError`/`SessionReadOnlyError` 等；类上新增 `identity` 符号；`DEFAULT_PREPARED_SESSION_CACHE_SIZE` 等导出消失（对比两者 `export { … }` 尾行）。
   - 依赖声明也收紧了：0.1.1 是 `"@deepseek-ai/cordis": "^4.0.1"` + 一批 `^0.1.1-rc.2` peer；0.2.0 变成 `"@deepseek-ai/cordis": "~4.0.4"` + 精确 `0.2.0-rc.2` peer。**第三方插件若写 `^0.1.1-rc.2` 这类 range，在 2.0 上会被判为不兼容**（`^0.1.1-rc.2` 不含 `0.2.0-rc.2`）。
3. **`!!js` 可用符号更丰富**：2.0 在 root ctx 上 provide 了 `dshHomePath`（`$D/dsh-app-boot/lib/index.js:4071`），官方补丁大量用它（`dsh-base:133`、`:171`）。
4. cordis 依赖从 `^4.0.1` 收紧到 `~4.0.4`；插件行的 Config 描述可在运行时经 `Config.listConfigs` 查询（skill 与 `--dump-config-schema`）。

---

## 7. 可直接使用的成品：写一个替换官方 JSONL 行的第三方插件

> 最省力的正路是**继承官方 `JsonlSessionPersistence`，只改路径/索引/迁移**（本机样本 `$REF` 就是这么做的：`$REF/lib/index.js:73` `class ProjectSessionPersistence extends JsonlSessionPersistence`、`:95 static Config`、`:108 super(ctx, { ...config, root })`、`:779 export default`；README 明说"Subclasses the official `JsonlSessionPersistence`, reusing its coordinator, zstd encoding, crash repair, and durability guarantees"）。从零实现抽象基类要自己补齐全部 handle 语义，不建议。

### 7.1 `package.json`

```json
{
  "name": "dsh-session-store-project-local",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/dsh-session-persistence": ">=0.2.0-rc.2 <0.3.0",
    "@deepseek-ai/dsh-session-persistence-jsonl": ">=0.2.0-rc.2 <0.3.0"
  }
}
```

要点：
- `dsh.bundle.patch` 是"成为 bundle"的开关；`./cordis.patch.yml` 建议同时在 `exports` 里导出（官方与第三方都这么做，便于工具读取）。
- **`peerDependencies` 里凡是 `@deepseek-ai/dsh*` 都会被当成 DSH 版本门禁**（`evaluatePluginCompatibility`）。要么写能覆盖 `0.2.0-rc.2` 的 range（如上），要么干脆不声明（不声明就不校验）。官方包由安装体提供，**不要**把它们写进 `dependencies` 去装第二份。
- 若还要跑 pnpm 安装本地目录：`dsh plugin --profile web add /abs/path/to/pkg`。

### 7.2 `cordis.patch.yml`

```yaml
# ① 按 id 关掉官方 base 的集中式 JSONL 后端行
- id: session-persistence-jsonl
  disabled: true

# ② 插入自己的后端行（顶层 insert，无 id）
- insert:
    - id: session-store-project-local
      name: 'dsh-session-store-project-local'
      config:
        root: !!js dshHomePath('sessions')      # 或换成你要的目录；config 整体替换，需按自己的 Config 重述
```

要点：
- 覆盖官方行**只需 `id` + `disabled`，不要写 `config`**（写 `config` 会整段替换掉 base 的 `root: dshHomePath('sessions')`）。
- 新插入的行**不会继承** base 行的 config；`root` 之类的必填项要么在这里给，要么在自己的 `static Config` 里给默认值。
- `!!js` 是双感叹号；`dshHomePath` 在 2.0 的 root ctx 上可用。
- 想插进某个 `group: true` 的行，用 `- id: <group-id>` + `insert: [...]`。
- 该文件既可放在 bundle 包里（层顺序 = `dsh.profile.bundles` 顺序），也可以把同样内容写进用户层 `$DSH_HOME/profiles/<name>/cordis.patch.yml`（用户层永远压在所有 bundle 之上，且 `$DSH_HOME/cordis.patch.yml` 再压 profile 层）。

### 7.3 `lib/index.js` 骨架

```js
// 依赖来自 dsh 安装体（或 profile 的 node_modules）——运行期解析由 PluginPackages 提供
import z from '@deepseek-ai/schemastery'
import { JsonlSessionPersistence, JsonlCompressionSchema } from '@deepseek-ai/dsh-session-persistence-jsonl'

export class ProjectLocalSessionPersistence extends JsonlSessionPersistence {
  static Config = z.object({
    root: z.string().required(),                 // 必填；行 config.root 必须给
    compression: JsonlCompressionSchema,         // 复用官方编码 schema
    // …自己的可选参数
  })

  constructor(ctx, config) {
    super(ctx, config)                            // 官方签名就是 (ctx, config)
    // this.ctx 可用；需要别的服务时用 this.ctx.get('workspaceRegistry')（样本 :226）
  }

  // 覆写路径解析 / list / 迁移等；写盘、崩溃修复、zstd 编码直接复用父类
}

export default ProjectLocalSessionPersistence        // ← Loader 取的就是 default
```

### 7.4 安装与验证

```sh
dsh plugin --profile web add /abs/path/to/dsh-session-store-project-local   # 本地目录
# 或 dsh plugin --profile web add dsh-session-store-project-local           # npm 名
# 组合树在 boot 时装配 → 重启 `dsh web`

dsh --profile web --dump-config | grep -n 'session-persistence'   # 看合成后的树（官方行 disabled、你的行在）
dsh --profile web --dump-config-schema                             # 看你的 Config JSON Schema 是否被识别
```

`--dump-config` / `--dump-default-config` / `--dump-config-schema` 由启动器实现（选项定义 `$D/dsh/lib/bin.js:105`、参数解析 `:59-90 resolveBoot`；渲染实现 `$D/dsh-app-boot/lib/index.js:3604-3649 renderConfigDump`，逐层标注"哪一层 patch 了这一行"）。

---

## 8. 陷阱清单

1. **补丁合并语义**：`config` 整体替换（`include/lib/index.js:99-102`）——只写 `disabled` 才安全；要改 `config` 就重述全部字段。
2. **`name` 是断言**：`- id: x` + `name: 错的包名` → 警告 + 跳过（`:95-98`）。
3. **`insert` 的名字锚定**：`./`、`../` 开头的 `name` 会被改成"相对 patch 文件"的 file URL（`app-boot:3536-3545`）；从 profile 安装的 bundle 用**裸包名**（如 `dsh-cost-meter`）。
4. **bundle 补丁文件缺失 = 启动失败**（`loadOverlayPatches` 对 bundle/`--patch` 是必需文件），profile / home 层的 `cordis.patch.yml` 缺失则视为"没有这一层"。
5. **patch 文件顶层必须是数组**，元素必须是 mapping（`app-boot:3566-3569`）。
6. **兼容门禁会拦住装老 range 的插件**：`@deepseek-ai/dsh-session-persistence-jsonl: ">=0.1.1-rc.2"` 这种"宽上限"没问题，但 `^0.1.x` 在 0.2.0 上不成立 → 需要逐版本豁免。
7. **`dsh.compatibility` / `dshCompatibility` 不是 2.0 的运行时字段**：`app-boot` 与 `plugin-manager` 里搜不到读取点（只读 `peerDependencies`）；它们只是插件市场/展示元数据。
8. **bundle 必须被列进 `dsh.profile.bundles`**：`dsh plugin add` 会自动追加，手工安装则要自己写（`$D/dsh-app-boot/lib/index.js:1106-1125 reconcileProfilePlugins` 是等价逻辑，`writeProfileBundles` 在 `:1085-1098`）。
9. **`group: true` 的行永远不被 disabled 传染**（`entry.ts:74-83`：group 自身恒 enabled；但子行会继承父的 disabled）。
10. **改 `cordis.yml` 没用**：启动器每次启动重写为 `[]`（`profile-boot:121-125`、`:189`）。

---

## 9. 证据索引（关键文件行号）

| 主题 | 位置 |
|---|---|
| bundle 声明解析（字符串/数组） | `$D/dsh-app-boot/lib/index.js:488-509` |
| profile 装载 bundle 层 | `$D/dsh-app-boot/lib/index.js:920-947` |
| patch 层顺序（bundle → profile → home → --patch → telemetry） | `$D/dsh-app-boot/lib/index.js:1017-1035` |
| patch 文件读取/解析/相对名锚定 | `$D/dsh-app-boot/lib/index.js:3508-3571` |
| patch 应用语义（insert/id/name/覆盖） | `$D/cordis-plugin-include/lib/index.js:56-105` |
| `PatchOptions` 字段全集 | `$D/cordis-plugin-include/lib/types/index.d.ts:23-33` |
| `EntryOptions`（行字段） | `$D/cordis-plugin-loader/src/config/entry.ts:10-24` |
| `!!js` tag 与 schema | `$D/cordis-plugin-include/lib/index.js:15-27` |
| `!!js` 求值作用域 | `$D/cordis-plugin-loader/src/config/utils.ts:5-9`；`$D/cordis-plugin-loader/lib/index.js:600-609` |
| 官方持久化行 | `$D/dsh-base/cordis.patch.yml:130-133`（另见 `:40-44`、`:149-153`、`:158-186`、`:204-218`、`:413-414`） |
| sdk-minimal 的同后端不同 id | `$D/dsh-sdk-minimal/cordis.patch.yml:154-157` |
| CLI `plugin` 子命令 | `$D/dsh/lib/bin.js:37-46`、`:118-129` |
| `runPlugin` / `runPluginCommand` / `runProfilePnpm` / `reconcile` | `$D/dsh/lib/plugin-BGnVfe_D.js:63-99`；`$D/dsh-plugin-manager/lib/types/operations.js:526-537`、`:246-519`、`:44-72` |
| profile 初始化与目录 | `$D/dsh-app-boot/lib/index.js:524-527`、`:576-592` |
| 单行开关写 patch | `$D/dsh-plugin-manager/lib/types/patch.js:13-49` |
| 1.x link backend 残留清理 | `$D/dsh-app-boot/lib/index.js:593-611` |
| 导出形态归一化 | `$D/cordis-plugin-loader/src/index.ts:200-208`；实例化 `$D/cordis/src/fiber.ts:251-261` |
| Service 基类 | `$D/cordis/src/service.ts:11-59`（1.x 对照：`…/cordis@4.0.1/src/service.ts:42-57`） |
| 配置校验 | `$D/cordis/src/fiber.ts:50-62` |
| 兼容门禁 | `$D/dsh-app-boot/lib/index.js:286-323` |
| 官方插件作者文档 | `$SKILL/cordis-plugin-development/references/host-plugin.md:1-58`；`$SKILL/cordis-composition-reference/SKILL.md:10-25` |
| 可加载插件包清单（生成物） | `$SKILL/cordis-composition-reference/references/packages.md` |
| 现成第三方实例 | `$REF/package.json`、`$REF/cordis.patch.yml`、`$REF/lib/index.js`、`$REF/README.md` |

## 10. 未验证 / 局限

- **没有独立的 "cordis 1.x / 2.x" 包**：本机 1.x 侧对照物是 `dsh-*@0.1.0-rc.6` 与 `@deepseek-ai/dsh-session-persistence@0.1.1-rc.2`（cordis 4.0.1）。若你指的 "1.x" 是更早的 DSH 0.1.0 之前、或另一套 cordis 3.x API，本报告 §6.1 的"未变"结论不适用（需另找产物）。
- 本机样本 `$REF`（`@yangzhe1991/dsh-project-session-store@0.1.5`）声明的 peer 下限是 `>=0.1.1-rc.2`，说明它的作者把 0.1.x 与 0.2.x 视为同一 API 家族；但它的 README 里"$DSH_HOME/profiles/node_modules 由 harness 维护"那句描述的是 1.x 的 link backend，2.0 已改为 profile 自带 pnpm 树 + 运行期解析拦截。
- `!!js` 里可用的符号集合（`dshHomePath` 之类）以 root ctx 上 `ctx.provide()` 的内容为准；没有逐一枚举全部可用名。
