# dsh-rea — REA 逆向能力接入 DSH

把 [REA (Reverse Engineer Anything)](https://github.com/morluto/rea) 的 **170 个 MCP 工具**接进 DSH，
并且**内建 Android/Termux 的 `process.execPath` 修复**。

```
模型 → rea_tools（找工具）→ rea_call（调工具）→ REA MCP 服务器（常驻 stdio）→ 本地分析
```

## 为什么不把 170 个工具直接注册进来

`rea mcp` 的 `tools/list` 全量载荷实测 **1,955,253 字节 ≈ 55.8 万 token**（170 个工具，描述 59 KB，
JSON Schema 366 KB）。任何「全量注册」的做法都会在第一次请求就把上下文窗口吃掉。
所以本插件只注册 **4 个闸门工具**，需要哪个现查现调，其余能力一个不少。

杜绝对照：DSH 自带的 `@deepseek-ai/dsh-mcp-client` 也能接 MCP 服务器（工具名 `mcp__rea__<tool>`），
但它是全量注册 —— 想用就得承受上面那 55.8 万 token。本插件是给手机/长会话准备的那条路。

## 四个工具

| 工具 | 作用 |
|---|---|
| `rea_tools` | 检索 170 个工具：`query` 关键词过滤，命中时给一句话说明 + 入参字段名（`*` = 必填） |
| `rea_call` | 按原始工具名调用任意 REA MCP 工具，返回 Evidence JSON（可带 `timeoutMs` / `maxBytes`） |
| `rea_cli` | 直接跑 REA CLI：`decode-android-resources`、`analyze-javascript-application`、`doctor`、`capabilities`、`setup --dry-run` 等 |
| `rea_status` | 安装/版本/真 node 路径/execPath 补丁覆盖率/（可选）`doctor` 就绪摘要 |

### REA 是会话制的，调用顺序有讲究

REA 的多数工具（`inspect_artifact`、`list_architectures`、`list_procedures`、`list_strings`、
`analyze_function` …）**不接受路径**，只作用于「当前打开的目标」：

```
rea_call open_binary {"path":"/abs/target"}   → 打开目标
rea_call inspect_artifact {}                   → 分析当前目标
rea_call close_binary {}                       → 收尾
```

本插件的 MCP 连接在整个 DSH 会话里常驻，`open_binary` 的状态跨多次 `rea_call` 保持。
带 `input_path` 的分析器（如 `analyze_javascript_application`）不需要先 `open_binary`。

## 安装

```sh
# 1) 装 REA 到插件自己的 vendor 目录（不污染全局 npm），并打 Android 补丁
node <插件目录>/setup.mjs

# 2) 装进 profile（会自动把插件加进 dsh.profile.bundles）
dsh plugin --profile web add file:<插件目录>

# 3) 重启 DSH
```

自检（不需要 DSH 在跑，用假 ctx 直接驱动插件）：

```sh
node <插件目录>/tests/smoke.mjs
```

## Android / Termux 适配

安卓上 Node 的 `process.execPath` 指向 **`/apex/com.android.runtime/bin/linker64`**
（bionic 的 `/proc/self/exe` 指向动态链接器，而不是可执行文件本身）。REA 有 10 处
`spawn(process.execPath, …)` 的 worker 会因此炸掉：

| 现象 | 出处 |
|---|---|
| `error: "…/rea.mjs" has bad ELF magic` | `rea mcp doctor` |
| `error: expected absolute path: "--max-old-space-size=1024"` | JS 分析 worker |

本插件的三层处理：

1. **拉起 REA 时用真 node 路径**（`resolveNodeExecPath`：config → `DSH_REA_NODE` → `REA_NODE_EXEC_PATH`
   → PATH 上的 `node` → 最后才退回 `process.execPath`）；
2. **向子进程传 `REA_NODE_EXEC_PATH`**，并把真 node 目录塞进 PATH 最前；
3. **给自己的 vendor 副本打幂等补丁**：把 10 个文件里的 `process.execPath` 换成
   `(process.env.REA_NODE_EXEC_PATH ?? process.execPath)`。

> 补丁**只动插件 vendor 目录里的 REA**。要改外部/全局安装的 REA，必须显式设
> `config.allowPatchOutsideVendor: true`。`rea_status` 会报告补丁覆盖率。

### 安卓上哪些链路真的可用（实测）

| 可用 | 说明 |
|---|---|
| `open_binary` / `inspect_artifact` / `close_binary` | 产物结构、digest、Evidence |
| `analyze_javascript_application` | 打完补丁后真跑通（`parsed_javascript_files: 1`、17 个图节点、无 error） |
| `decode_android_resources`（走 `rea_cli`） | apktool + JDK 17 `java -jar` 解真 APK 的 manifest/资源 |
| `.NET` managed 静态、keyed archive、dylib 解析 | 纯 JS，`capabilities` 报 available |

| 不可用 | 原因 |
|---|---|
| `inspect_android_*`（JADX 类反编译） | REA 硬门禁：`unsupported_host`（只允许 linux/darwin/win32-x64）。patch 掉门禁后要求自备 `REA_JADX_MCP_JAR`（jadx-headless-mcp 0.7.1） |
| `capture-process` | `@lydell/node-pty` 无 `android-arm64` 构建 |
| 浏览器/网站链路 | 上游 `playwright-core` 报 `Unsupported platform: android` |
| 原生反编译（Hopper/IDA） | Hopper 仅 macOS；IDA 无安卓版（Ghidra 见下文「Ghidra」一节：**已在本机自编 arm64 版并跑通**） |
| ELF 布局 / EVM interface | REA 门禁「Linux x64 only」 |

## 配置项（`cordis.patch.yml`）

```yaml
- insert:
    - id: dsh-rea
      name: 'dsh-rea'
      config:
        enabled: true
        reaEntry: ''                      # 空 = 自动解析（vendor → 环境变量 → PATH 上的 rea）
        nodeExecPath: ''                  # 空 = 自动解析（环境变量 → PATH 上的 node）
        callTimeoutMs: 300000             # rea_call 默认超时
        maxResultBytes: 80000             # 结果截断上限
        allowPatchOutsideVendor: false    # 是否允许给外部 REA 打 execPath 补丁
        log: false                        # 打印 spawn/重连日志
```

## 全量模式（不推荐，除非你知道自己在干什么）

想要 `mcp__rea__*` 形式的 170 个原生工具，加一段 bundle patch：

```yaml
- insert:
    - id: mcp-rea
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: rea
        transport: stdio
        command: /data/data/com.dsharnessmobile.shell/files/usr/bin/node
        args:
          - <插件目录>/vendor/node_modules/rea-agents/scripts/rea.mjs
          - mcp
        env:
          REA_NODE_EXEC_PATH: /data/data/com.dsharnessmobile.shell/files/usr/bin/node
        toolCallTimeoutMs: 300000
```

代价：**每次请求多约 55.8 万 token 的工具清单**。手机/长会话基本别碰。
`command` 必须是**真 node 路径**，`env.REA_NODE_EXEC_PATH` 也必须有（MCP client 会洗掉环境变量，
所以必须在 config 里显式传）。

## 排障

| 症状 | 处理 |
|---|---|
| `REA 未安装或入口未解析` | 跑 `node setup.mjs`，或设 `config.reaEntry` |
| `rea_call` 报连接错误 | `rea_status` 看 `mcpConnected`；把 `log: true` 打开看 spawn/重连日志；stderr 尾部会附在错误里 |
| 工具调用超时 | 先看报的是哪一层（见下节）。冷启动/大目标要调大 `ghidraStartupTimeoutMs`，不要只调 `rea_call` 的 `timeoutMs` |
| 结果被截断 | 调大 `maxBytes`，或改用 `rea_cli` 落盘后再读文件 |
| 补丁没生效 | `rea_status` 的 `androidExecPathPatch.complete` 必须是 true；外部安装需 `allowPatchOutsideVendor: true` |

### `batch_decompile` 为什么老超时

**不是批量太大。** 实测（265 KB 的 `libjsoncpp.so`，Ghidra 已热）：

```
open_binary        189 ms
list_procedures  28447 ms   ← Ghidra 冷启动 + 分析全在这里
batch_decompile       62 ms   （1 个地址）
batch_decompile       65 ms   （8 个地址，≈8 ms/地址）
```

真正的成本是 **Ghidra 冷启动**（265 KB 约 28 s，16.8 MB 的 `.so` 实测 508 s），而
`batch_decompile` 常常就是 `open_binary` 之后**第一个取数的调用**，于是它一个人背下了
整个冷启动 —— 看起来就像「批量反编译老是超时」。

两层超时，都要给够：

| 层 | 默认 | 谁报的错 | 怎么抬 |
|---|---|---|---|
| 插件工具层 | `max(callTimeoutMs, ghidraStartupTimeoutMs)`，下限 **330 s** | `rea: tools/call timed out after …` | 配置 `callTimeoutMs` / `ghidraStartupTimeoutMs`，或单次传 `timeoutMs` |
| REA 内部 | Ghidra 启动/分析绝对时限 **330 s** | `provider_timeout`，`timeout_ms: 330000` | 配置 `ghidraStartupTimeoutMs`（大目标建议 `10800000` = 3 小时） |

> 工具层的下限就是对齐 REA 那个 330 s 的。**以前它写死 300 s，比 REA 自己还紧**，
> 所以冷启动的批量反编译在 300 s 被插件先掐断，你只能看到一句没有信息量的
> `rea: tools/call timed out`，永远等不到 REA 的结论（成功或 `provider_timeout`）。
> 现在两个值联动：抬 `ghidraStartupTimeoutMs`，工具层跟着抬。

另外注意 `list_procedures` 在 850 个函数的 `.so` 上输出 **278 KB**，超过默认
`maxBytes: 80000` 会被截断——想按函数清单批量反编译，记得同时调大 `maxBytes`。

## 踩过的三个坑（都是实测踩出来的）

### 1. 工具 `parameters` 必须是**完整 JSON Schema**（最致命）

DSH 的 `defineTool()` 接受「属性表简写」并在内部编译成 JSON Schema；但用**裸对象**
`ctx.tools.register({...})` 注册时，`parameters` 会被**原样**发给模型 API。写成简写就会：

```
dsh: INVALID_REQUEST: Invalid schema for function 'rea_call':
schema must be a JSON Schema of 'type: "object"', got 'type: null'.
```

症状极具迷惑性：**插件能正常挂载、DSH 能启动，但一对话就报错**。正确写法：

```js
parameters: {
  type: "object",
  properties: { query: { type: "string", description: "…" } },
  required: ["query"],
  additionalProperties: false,
}
```

### 2. 插件入口只能导出 `name` / `inject` / `apply`

DSH 的 cordis loader 会扫描插件模块的函数导出。辅助函数一律放 `lib/paths.mjs`，
入口文件保持与 `fujiang-armor` / `dsh-undo-savepoint` 一致的三个导出。
（实测：多导出**不会**导致 boot 失败，但保持干净是稳妥做法。）

### 3. pnpm 不会把 `vendor/` 拷进 profile

`dsh plugin add` 只拷 `package.json` 的 `files` 白名单（嵌套 `node_modules` 必被排除），
所以 profile 里那份代码**没有 REA**。因此插件按**规范安装位置**解析 REA：

```
$DSH_HOME/plugins/dsh-rea/vendor/node_modules/rea-agents/scripts/rea.mjs
```

而不是按「代码被拷到哪儿」。结论：插件必须装在 `$DSH_HOME/plugins/dsh-rea`。

## 验证（不需要动你正在用的 profile）

本机 DSH 的 CLI 必须用 `--expose-internals` 启动（App 就是这么拉的：
`linker64 <node> --expose-internals .../dsh/lib/bin.js web --port 3080 --no-open`），
否则报 `Cannot find module 'internal/modules/esm/loader'`：

```sh
node --expose-internals $PREFIX/lib/node_modules/@deepseek-ai/dsh/lib/bin.js <profile> "<任务>"
```

建一个一次性验证 profile（base + headless + dsh-rea），实测全部通过：

```sh
P=$DSH_HOME/profiles/reatest
mkdir -p "$P" && cat > "$P/package.json" <<'JSON'
{
  "name": "dsh-profile-reatest", "private": true,
  "dependencies": { "dsh-rea": "file:$DSH_HOME/plugins/dsh-rea" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless","dsh-rea"] } }
}
JSON
dsh plugin --profile reatest install
node --expose-internals $PREFIX/lib/node_modules/@deepseek-ai/dsh/lib/bin.js reatest "调用 rea_status 并报告版本"
```

实测输出（agent 真的调了工具）：

```
版本: 6.4.0
补丁: 10/10 applied
rea.entry: $DSH_HOME/plugins/dsh-rea/vendor/node_modules/rea-agents/scripts/rea.mjs
```

```
命中 9 / 共 170
inspect_android_package
```

启动时 `otel` / `session-telemetry-otel` 两条未激活的警告是**本机原有**现象，与本插件无关。

## JADX：APK 类/方法反编译（安卓上也能跑）

装上 `jadx-headless-mcp 0.7.1` 后，这四个工具就能反编译 APK：

| REA 工具（走 `rea_call`） | 作用 |
|---|---|
| `search_android_classes` | 按子串搜类名（空 query = 列出全部类） |
| `inspect_android_class` | 一个类的成员清单（方法/字段/内部类） |
| `inspect_android_method` | **一个方法的 Java 源码**（或 smali 兜底） |
| `trace_android_references` | 追某个类/方法的静态引用 |

CLI 等价形式（走 `rea_cli`）：

```sh
rea search-android-classes <apk> <query>
rea inspect-android-class <apk> <fully.qualified.ClassName>
rea inspect-android-method <apk> <ClassName> <methodName> [--overload-index N]
rea trace-android-references <apk> <ClassName> [--method-name X]
```

### 安装引擎

```sh
node <插件目录>/setup.mjs --with-jadx
```

它会按 **REA 自己声明的地址**下载并校验 sha256，落到
`<插件目录>/vendor/jadx/jadx-headless-mcp-0.7.1-all.jar`：

```
version : 0.7.1
revision: 5844800a486d2248fa949b74c9896285f5b54de2
sha256  : 6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75
url     : https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar
```

> 注意：真实上游是 **`1013503897/jadx-headless-mcp`**（`Samael-Z/...` 是镜像）；
> **v0.7.1 只存在于 GitHub release**，npm 上最高 0.7.0；仓库后来主推的 v2 产物与 REA 不兼容。
> REA 会校验 jar 里必须有这 5 个类：`com/atxx/jhmcp/JadxSession`、`com/atxx/jhmcp/SessionHolder`、
> `jadx/api/JadxDecompiler`、`com/google/gson/Gson`、`io/modelcontextprotocol/kotlin/sdk/server/Server`。

### 安卓上的两个坑（插件已自动处理）

**1. JADX 宿主门禁。** REA 的 `requireSupportedHost()` 只认 linux / darwin / win32-x64，
而安卓上 `process.platform === "android"`，于是 APK 反编译被误判 `unsupported_host`。
插件会自动放行这一行（幂等，`rea_status` 里看 `jadx.hostGatePatched`）。

**2. JVM 的 `java.io.tmpdir` 指向不存在的路径。** 本机 JDK 是 Termux 构建，
`java.io.tmpdir` 硬编码为 `/data/data/com.termux/files/usr/tmp/`，而本机 prefix 是
`com.dsharnessmobile.shell` —— **那个路径不存在**，且这个 JDK 连 `TMPDIR` 环境变量都不认。
jadx 一建临时目录就抛 `ExceptionInInitializerError`（其 message 为 **null**），REA 只能如实报成
`load failed: null`，非常难查。插件会自动挑一个真实可写的目录并注入
`JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=...`（`rea_status` 里看 `jadx.javaTmpDir`）。

### 实测

在 50 MB / 加固 / 单 dex 7.67 MB 的真实 APK 上：

```
state: LOADED   class_count: 6060   resource_count: 757   load_duration_ms: 4629
engine: jadx 0.7.1   java: 17.0.20   max_heap: 2.98 GB   8 cores
```

### 配置

```yaml
jadxMcpJar: ''   # 留空自动解析：REA_JADX_MCP_JAR → <规范位置>/vendor/jadx/... → 代码目录下同名路径
javaTmpDir: ''   # 留空自动挑可写目录
```

`rea_status` 里的 `jadx.ready` 为 `true` 表示链路就绪。**改完配置/代码需重启 DSH**，
因为环境变量是在拉 REA 子进程时注入的。

### 限制

- **native 方法拿不到 Java 体**：返回 `// method exists but has no decompiled body (native/abstract)`。
  遇到 VMP（如 `qohka.qnrg(methodId, class, args)` 这种派发）或 `native` 声明时，真逻辑在 .so 里，
  改用下面的 **Ghidra** 链路读原生实现。
- 静态观察不证明运行时行为；APK 不会被执行。

## Ghidra：原生反编译（aarch64 自编译）

上面那条「本机没有 linux-aarch64 版原生反编译器」的限制**已经解决**：本插件支持在设备上从源码
构建 Ghidra 12.1.4 的 arm64 原生反编译器，之后 `rea_call` 可直接对 ELF/.so 做反编译。

### 为什么要自己编

1. 官方 Ghidra 发布包**不含** linux/arm64 原生件（[issue #9364](https://github.com/NationalSecurityAgency/ghidra/issues/9364) 证实）；
2. 它自带的 `Makefile` 没有 arm64 分支，会掉进 `else ARCH_TYPE=-m32` 直接编挂；
3. 社区预编译仓（如 `bolo73/ghidra-aarch64-natives`）的版本与目录名都对不上 REA 的要求（REA 按
   `<platform>_<arch>` 推目录，即 `linux_arm_64`）。

### 一键构建

```sh
bash tools/build-ghidra-arm64.sh   # 默认装到 $DSH_HOME/plugins/dsh-rea/vendor/ghidra
```

脚本固化了这一路的坑：`SHELL` 覆盖（本机 `make` 的默认 SHELL 被烙成不存在的 `com.termux` 路径）、
`ARCH_TYPE=` 置空绕开 `-m32`、bison/flex 从镜像抓 `.deb` 手工解包（本机 apt/dpkg 前缀同样被写死，
装不了东西）、8 连接分片下载 543MB 包并按字节数校验。

手工等价命令：

```sh
cd Ghidra/Features/Decompiler/src/decompile/cpp
make -j8 ghidra_opt SHELL=$PREFIX/bin/sh ARCH_TYPE= OSDIR=linux_arm_64
mkdir -p ../../os/linux_arm_64 && cp ghidra_opt ../../os/linux_arm_64/decompile
```

### 安卓平台放行（插件启动时自动做）

REA 的 Ghidra provider 把「平台→原生工具目录」和「平台→可执行格式」写死在两张表里，两张都没有
android，于是 `rea doctor` 报三条红：`ghidra-platform`、`ghidra-architecture`、
`ghidra-native_decompiler`。插件启动时会幂等补两行（`lib/paths.mjs` 的 `applyGhidraPatch`），
让 android 映射到 `linux_arm_64` —— 被校验的二进制仍然是我们本机自己编的那份。

### 配置

```yaml
ghidraInstallDir: ''   # 留空自动解析：DSH_REA_GHIDRA_DIR / GHIDRA_INSTALL_DIR
                       # → $DSH_HOME/plugins/dsh-rea/vendor/ghidra/ghidra_12.1.4_PUBLIC → 代码目录下同名路径
javaHome: ''           # 留空自动解析：DSH_REA_JAVA_HOME → $PREFIX/lib/jvm/java-21-openjdk → JAVA_HOME
```

**JDK 21+ 是硬要求**（本机 PATH 上的 `java` 是 17，不够），插件会把 `JAVA_HOME` 与
`GHIDRA_INSTALL_DIR` 注入 REA 子进程；`rea_status` 的 `ghidra.ready` 为 `true` 即链路就绪。

### 会话模型与超时（重要）

`open_binary` 是**懒加载**，几乎不花时间；真正的 Ghidra 分析发生在**第一次取数据**时。实测：

```
open_binary       0.3s
list_strings    508.9s  → 16.8MB 的 arm64 检测引擎：6299 个函数 / 583 条字符串
同会话后续查询     0.1s  （毫秒级）
```

默认启动超时只有 330 秒，大目标会 `provider_timeout`，需要抬高：

```sh
REA_GHIDRA_STARTUP_TIMEOUT_MS=10800000 JAVA_TOOL_OPTIONS='-Xmx6g' \
  node <REA>/scripts/rea.mjs analyze <目标.so> --format json
```

### 分析太慢？关掉两个分析器，省 2.5×

那 508 秒 / 312 秒不是 I/O、不是 JVM，**就是 Ghidra 默认分析器集合**。Ghidra 自己在
`ghidra.log` 里把每一秒都记着，同一个目标（6.9 MB 的 `payload.so`）实测：

| Analyzer | 默认 | 说明 |
|---|---|---|
| **Stack** | 101.1 s | 预先算栈变量引用，喂给反编译器 |
| **Basic Constant Reference Analyzer** | 91.3 s | 常量传播出来的引用 |
| Decompiler Switch Analysis | 40.8 s | 跳表恢复（**别关**，REA 的 `jump_table_evidence` 靠它） |
| GCC Exception Handlers | 21.5 s | |
| Disassemble Entry Points | 20.9 s | |
| 其余 23 个 | ≈36 s | |
| **合计** | **305 s** | |

前两个加起来占 63%，而它们只让伪代码**更好读**（栈变量类型、常量传播），不产出结论。
关掉的实测效果（同一目标、同一 JVM 参数，只改这一项）：

| 配置 | 分析耗时 | 加速 |
|---|---|---|
| 默认 | 305 s | — |
| `Stack` + `Basic Constant Reference Analyzer` | **121 s** | **2.5×** |
| 再关 `Decompiler Switch Analysis` | 79 s | 3.9× |

```yaml
ghidraTrimAnalyzers: 'Stack,Basic Constant Reference Analyzer'
```

**默认是空的**（Ghidra 默认集合，行为一字不变）——因为这会让伪代码的注释变少，
该不该吃这个亏由你定。`rea_status` 的 `ghidra.trimAnalyzers` 会显示当前实际关掉了哪些。

#### 按次调整（不用改配置、不用重启 DSH）

`rea_call` 多了一个顶层参数 `trimAnalyzers`（**不是** REA 工具的入参，不会转给 REA）：

```
rea_call { tool: "open_binary", arguments: { path: "<大目标>" },
           trimAnalyzers: "Stack,Basic Constant Reference Analyzer" }
rea_call { tool: "open_binary", arguments: { path: "<小目标>" }, trimAnalyzers: "" }   # 恢复默认
```

- 与当前值**相同**时什么都不做（不会白白重启）；
- 与当前值**不同**时，插件会**重启 REA 子进程**再继续这次调用，返回里会带一行说明。

**为什么必须重启**：REA 的 `GhidraLauncher` 是在**子进程内部**读 `process.env` 拼 Ghidra 命令行的，
env 在 spawn 那一刻就固定了，常驻进程里改不动。所以按次调整只能换进程 —— **代价是当前打开的目标
及其分析结果一起丢**（反正换目标也要重新分析）。要避免这个代价就在 `open_binary` 之前设。

> 只走 `rea_cli` 的场景不需要这个参数：`rea_cli` 每次都是新进程，直接用
> `extraEnv: { "REA_GHIDRA_TRIM_ANALYZERS": "Stack,Basic Constant Reference Analyzer" }` 即可。

机制：插件把 `bridge/ReaGhidraTrimAnalyzers.java` 投放到 REA 的 `bridge/ghidra/`（那个目录
本来就在 `-scriptPath` 上），并给 REA 的 `GhidraLauncher` 插一个 `-preScript`；脚本在
「导入之后、自动分析之前」把 `Program.ANALYSIS_PROPERTIES` 里对应的开关置 false。
没配裁剪时命令行与原来逐字节相同。

> 分析器名字必须**一字不差**（`Stack`、`Basic Constant Reference Analyzer`）。
> 写错的后果是静默不生效——去 `$HOME/tmp/rea-ghidra-*/ghidra.log` 里搜 `REA analyzer trim` 确认。

### 剥符号的库怎么定位逻辑

符号被剥光时（通常只剩 `JNI_OnLoad`），按**字符串 → 交叉引用 → 批量反编译**走：

1. `search_strings`（如 `magisk`、`/proc/self/mountinfo`、`XposedBridge`）拿到地址；
2. `xrefs {address}` 反查引用它的函数入口；
3. `batch_decompile {addresses}` 一次出多份伪代码。

### 限制

- 分析只发生在内存里（`import_mode: ephemeral-source-immutable`），**不改原文件**，也不证明运行时行为。
- 混淆/加密代码会有大量 `Failed to disassemble`，属正常。
- VMP 类库大部分字节是压缩字节码（如 `libz` + `inflateInit2_`），可反编译的函数数会远小于体积。

## 许可

本插件 MIT，全文见 [LICENSE](LICENSE)。REA 自身 MIT；其中的第三方工具（IDA/Hopper/JEB 等）各自授权，本插件不提供任何授权。

> **合规提示**：REA 仅用于你拥有或已获授权分析的软件（研究、教育、互操作性、软件保存）。
> 使用前请阅读上游 [DISCLAIMER.md](https://github.com/morluto/rea/blob/main/DISCLAIMER.md)。
