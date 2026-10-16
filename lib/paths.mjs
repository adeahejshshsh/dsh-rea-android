/**
 * dsh-rea 内部工具模块（路径解析 + Android execPath 补丁）。
 *
 * ⚠️ 这个文件**不能**被当作插件入口。DSH/cordis 的 loader 会把插件模块里的
 * 每一个函数导出当成一个插件去挂载，所以插件入口 index.js 只允许导出
 * `name` / `inject` / `apply` 三个符号，其余辅助函数一律放在这里。
 * 放在子目录且不被 index.js 之外的任何东西引用为入口，就不会被 loader 扫描到。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, isAbsolute, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

/** 插件根目录（lib/ 的上一级）。 */
export const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** DSH home（$DSH_HOME，缺省 ~/.dsh）。 */
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");

/**
 * 插件的**规范安装位置**：$DSH_HOME/plugins/dsh-rea。
 *
 * 关键：pnpm 把插件装进 profile 时只拷 package.json 的 `files` 白名单，
 * 96MB 的 vendor/（含 REA 本体）不在其中，所以 profile 里那份代码是**没有 REA 的**。
 * 因此 REA 一律按这个规范位置解析，而不是按「代码被拷到哪儿」解析。
 */
export const CANONICAL_PLUGIN_DIR = join(DSH_HOME, "plugins", "dsh-rea");

/** 规范位置下的 REA 入口（setup.mjs 就装在这里）。 */
export const CANONICAL_REA_ENTRY = join(
  CANONICAL_PLUGIN_DIR,
  "vendor",
  "node_modules",
  "rea-agents",
  "scripts",
  "rea.mjs",
);

/** 自带 vendor 里的 REA 入口（按代码所在位置算，可能是 profile 里的拷贝件）。 */
export const VENDOR_REA_ENTRY = join(
  PLUGIN_DIR,
  "vendor",
  "node_modules",
  "rea-agents",
  "scripts",
  "rea.mjs",
);

// ---------------------------------------------------------------- JADX 引擎

/** REA 要求的 jadx-headless-mcp 版本与产物名。 */
export const JADX_JAR_FILENAME = "jadx-headless-mcp-0.7.1-all.jar";

/**
 * 上游发布地址与校验值：直接抄自 REA 源码 `src/android/JadxRelease.ts` 的 JADX_RELEASE。
 * 注意所有者是 1013503897（`Samael-Z/jadx-headless-mcp` 是镜像）；v0.7.1 只在 GitHub
 * release 里，npm 上最高 0.7.0，仓库后来主推的 v2 产物与 REA 不兼容。
 */
export const JADX_RELEASE_URL =
  "https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar";
export const JADX_RELEASE_SHA256 =
  "6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75";
export const JADX_RELEASE_REVISION = "5844800a486d2248fa949b74c9896285f5b54de2";

/** jar 的规范位置（setup.mjs --with-jadx 就装这里）。 */
export const CANONICAL_JADX_JAR = join(CANONICAL_PLUGIN_DIR, "vendor", "jadx", JADX_JAR_FILENAME);
/** 按代码所在位置算的 jar 位置。 */
export const LOCAL_JADX_JAR = join(PLUGIN_DIR, "vendor", "jadx", JADX_JAR_FILENAME);

/** 解析 jadx-headless-mcp 的 fat jar；找不到返回空串（该链路自动不可用）。 */
export const resolveJadxJar = (config = {}) => {
  const candidates = [
    config.jadxMcpJar,
    process.env.REA_JADX_MCP_JAR,
    CANONICAL_JADX_JAR,
    LOCAL_JADX_JAR,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "" && isAbsolute(candidate) && isFile(candidate)) {
      return candidate;
    }
  }
  return "";
};

/** 确保目录存在；返回是否可用。 */
const ensureDir = (p) => {
  if (typeof p !== "string" || p === "" || !isAbsolute(p)) return false;
  try {
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * 解析给 JVM 用的临时目录（会被塞进 `-Djava.io.tmpdir=`）。
 *
 * 为什么必须显式指定：本机 JDK 是 Termux 构建，`java.io.tmpdir` 硬编码为
 * `/data/data/com.termux/files/usr/tmp/`，而本机 prefix 是
 * `com.dsharnessmobile.shell` —— 那个路径**根本不存在**。jadx 一建临时目录就抛
 * `ExceptionInInitializerError`（其 message 为 null），REA 只能报成 `load failed: null`。
 * 顺带一提：这个 JDK 连 `TMPDIR` 环境变量都不认。
 */
export const resolveJavaTmpDir = (config = {}) => {
  const candidates = [
    config.javaTmpDir,
    process.env.DSH_REA_JAVA_TMP,
    process.env.TMPDIR,
    process.env.PREFIX === undefined ? undefined : join(process.env.PREFIX, "tmp"),
    join(DSH_HOME, "..", "tmp"),
    join(CANONICAL_PLUGIN_DIR, "tmp"),
  ];
  for (const candidate of candidates) if (ensureDir(candidate)) return candidate;
  return "";
};

// ------------------------------------------------------- JADX 宿主门禁补丁

/** REA 里做 JADX 宿主白名单判断的文件（相对 REA 包根的 dist/）。 */
export const JADX_HOST_GATE_FILE = "android/JadxConfiguration.js";
const JADX_GATE_NEEDLE = 'if (process.platform === "linux" || process.platform === "darwin")';
const JADX_GATE_REPLACEMENT =
  'if (process.platform === "linux" || process.platform === "darwin" || process.platform === "android")';

/** 报告 JADX 宿主门禁是否已放行。 */
export const jadxGateState = (reaEntry) => {
  const root = reaRootOf(reaEntry);
  if (root === "") return { present: false, patched: false };
  const file = join(root, "dist", JADX_HOST_GATE_FILE);
  if (!isFile(file)) return { present: false, patched: false };
  try {
    return { present: true, patched: readFileSync(file, "utf8").includes(JADX_GATE_REPLACEMENT) };
  } catch {
    return { present: true, patched: false };
  }
};

/**
 * 幂等地放行 REA 的 JADX 宿主门禁。
 *
 * 为什么需要：REA 的 requireSupportedHost() 只认 linux / darwin / win32-x64，
 * 而安卓上 `process.platform === "android"`，于是 JADX 链路（APK 类/方法反编译）
 * 直接被判 unsupported_host。底层 JDK 与 jadx 本身在本机是能跑的（已验证：
 * 6060 个类 / 4.6 秒加载完成），所以这一行是纯粹的宿主白名单限制。
 */
export const applyJadxHostGatePatch = (reaEntry, { allowOutsideVendor = false } = {}) => {
  const root = reaRootOf(reaEntry);
  if (root === "") return { ok: false, reason: "rea-entry-unresolved", root };
  const insideVendor = root.startsWith(PLUGIN_DIR) || root.startsWith(CANONICAL_PLUGIN_DIR);
  if (!insideVendor && !allowOutsideVendor) {
    return { ok: false, reason: "outside-vendor-denied", root };
  }
  const file = join(root, "dist", JADX_HOST_GATE_FILE);
  if (!isFile(file)) return { ok: false, reason: "file-missing", root };
  try {
    const source = readFileSync(file, "utf8");
    if (source.includes(JADX_GATE_REPLACEMENT)) return { ok: true, root, changed: false };
    if (!source.includes(JADX_GATE_NEEDLE)) return { ok: false, reason: "needle-missing", root };
    writeFileSync(file, source.replace(JADX_GATE_NEEDLE, JADX_GATE_REPLACEMENT));
    return { ok: true, root, changed: true };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error), root };
  }
};

/** REA 中会被 Android execPath 问题打断的文件（相对 REA 包根的 dist/）。 */
export const EXEC_PATH_PATCH_FILES = [
  "application/ClientRegistrationIdentity.js",
  "application/ClientRegistrationStatus.js",
  "application/SetupHost.js",
  "application/UpdateMaintenance.js",
  "application/UpdateRuntime.js",
  "browser/history/HarCaptureAdapter.js",
  "javascript/sourceMaps/SourceMapCommand.js",
  "javascript/analysis/JavaScriptAnalysisWorker.js",
  "evm/EvmoleInterfaceProvider.js",
  "mcpDoctor.js",
];

export const PATCH_NEEDLE = "process.execPath";
export const PATCH_REPLACEMENT = "(process.env.REA_NODE_EXEC_PATH ?? process.execPath)";

const isFile = (p) => {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
};

/** 在 PATH 里找一个可执行的绝对路径。 */
export const findOnPath = (bin) => {
  const paths = String(process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of paths) {
    const candidate = join(dir, bin);
    if (isFile(candidate)) return candidate;
  }
  return "";
};

/**
 * 解析真 node 可执行文件。
 * Android 上 `process.execPath` 是 `/apex/com.android.runtime/bin/linker64`
 * （bionic 的 /proc/self/exe 指向解释器），拿它当 node 用必然失败，所以最后才回退。
 */
export const resolveNodeExecPath = (config = {}) => {
  const candidates = [
    config.nodeExecPath,
    process.env.DSH_REA_NODE,
    process.env.REA_NODE_EXEC_PATH,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "" && isAbsolute(candidate) && isFile(candidate)) {
      return candidate;
    }
  }
  const fromPath = findOnPath("node");
  if (fromPath !== "") return fromPath;
  const execPath = process.execPath;
  if (isAbsolute(execPath) && !/linker64$/u.test(execPath) && isFile(execPath)) return execPath;
  return "node";
};

/** 解析 REA 的 CLI 入口（scripts/rea.mjs）。 */
export const resolveReaEntry = (config = {}) => {
  const candidates = [
    config.reaEntry,
    process.env.DSH_REA_ENTRY,
    process.env.REA_ENTRY,
    CANONICAL_REA_ENTRY, // 规范安装位置优先于「代码被拷到哪儿」
    VENDOR_REA_ENTRY,
    findOnPath("rea"),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "" && isAbsolute(candidate) && isFile(candidate)) {
      return candidate;
    }
  }
  return "";
};

/** REA 包根目录（含 dist/ 与 package.json）。 */
export const reaRootOf = (reaEntry) => {
  if (reaEntry === "") return "";
  return dirname(dirname(reaEntry));
};

/** 报告 execPath 补丁覆盖率。 */
export const patchState = (reaEntry) => {
  const root = reaRootOf(reaEntry);
  if (root === "") return { root: "", patched: 0, total: EXEC_PATH_PATCH_FILES.length, present: false };
  const dist = join(root, "dist");
  let patched = 0;
  let present = 0;
  for (const rel of EXEC_PATH_PATCH_FILES) {
    const file = join(dist, rel);
    if (!isFile(file)) continue;
    present += 1;
    try {
      if (readFileSync(file, "utf8").includes("REA_NODE_EXEC_PATH")) patched += 1;
    } catch {
      /* 读不了就当没打 */
    }
  }
  return { root, patched, total: EXEC_PATH_PATCH_FILES.length, present };
};

/**
 * 幂等地把 `process.execPath` 换成可覆盖表达式。
 * 默认只允许改插件自己 vendor 目录下的 REA；外部安装需要显式 allowOutsideVendor。
 */
export const applyExecPathPatch = (reaEntry, { allowOutsideVendor = false } = {}) => {
  const root = reaRootOf(reaEntry);
  if (root === "") return { ok: false, reason: "rea-entry-unresolved", changed: [] };
  // 允许改：① 插件代码所在目录下的 vendor；② 规范安装目录 $DSH_HOME/plugins/dsh-rea 下的 vendor。
  const insideVendor = root.startsWith(PLUGIN_DIR) || root.startsWith(CANONICAL_PLUGIN_DIR);
  if (!insideVendor && !allowOutsideVendor) {
    return { ok: false, reason: "outside-vendor-denied", root, changed: [] };
  }
  const changed = [];
  const skipped = [];
  for (const rel of EXEC_PATH_PATCH_FILES) {
    const file = join(root, "dist", rel);
    if (!isFile(file)) {
      skipped.push(rel);
      continue;
    }
    try {
      const source = readFileSync(file, "utf8");
      if (source.includes("REA_NODE_EXEC_PATH")) continue;
      if (!source.includes(PATCH_NEEDLE)) {
        skipped.push(rel);
        continue;
      }
      writeFileSync(file, source.split(PATCH_NEEDLE).join(PATCH_REPLACEMENT));
      changed.push(rel);
    } catch (error) {
      skipped.push(`${rel} (${String(error?.message ?? error)})`);
    }
  }
  return { ok: true, root, changed, skipped };
};

// ---------------------------------------------------------------- Ghidra 引擎

/**
 * Ghidra 版本目录名。
 *
 * REA 的 ghidra provider 只认 12.1.x。官方发布包**不含** linux/arm64 原生反编译器
 * （ghidra issue #9364 证实），而它自带的 Makefile 又没有 arm64 分支（会掉进
 * `else ARCH_TYPE=-m32` 编挂），所以 aarch64 上这份 decompile 必须自己编：
 *
 *   cd Ghidra/Features/Decompiler/src/decompile/cpp
 *   make -j8 ghidra_opt ARCH_TYPE= OSDIR=linux_arm_64     # ARCH_TYPE 置空以绕开 -m32 误判
 *   mkdir -p ../../os/linux_arm_64 && cp ghidra_opt ../../os/linux_arm_64/decompile
 */
export const GHIDRA_DIRNAME = "ghidra_12.1.4_PUBLIC";

/** REA 按 `<platform>_<arch>` 推原生工具目录；android+arm64 放行后落在 linux_arm_64。 */
export const GHIDRA_NATIVE_DIRNAME = "linux_arm_64";

/** 规范安装位置下的 Ghidra 根（含 Ghidra/application.properties）。 */
export const CANONICAL_GHIDRA_DIR = join(CANONICAL_PLUGIN_DIR, "vendor", "ghidra", GHIDRA_DIRNAME);

/** 按代码所在位置算的 Ghidra 根（可能是 profile 里的拷贝件）。 */
export const LOCAL_GHIDRA_DIR = join(PLUGIN_DIR, "vendor", "ghidra", GHIDRA_DIRNAME);

/** 一个目录像不像 Ghidra 安装根。 */
const looksLikeGhidra = (dir) =>
  typeof dir === "string" &&
  dir !== "" &&
  isAbsolute(dir) &&
  isFile(join(dir, "Ghidra", "application.properties"));

/**
 * 解析 Ghidra 安装根（要作为 GHIDRA_INSTALL_DIR 传给 REA）。
 * 顺序：显式配置 → 环境变量 → 规范安装位置 → 本代码目录下的 vendor。
 */
export const resolveGhidraInstallDir = (config = {}) => {
  const candidates = [
    config.ghidraInstallDir,
    process.env.DSH_REA_GHIDRA_DIR,
    process.env.GHIDRA_INSTALL_DIR,
    CANONICAL_GHIDRA_DIR,
    LOCAL_GHIDRA_DIR,
  ];
  for (const candidate of candidates) {
    if (looksLikeGhidra(candidate)) return candidate;
  }
  return "";
};

/**
 * 解析 JAVA_HOME。
 *
 * 关键：本机 PATH 上的 `java` 是 17，而 Ghidra 12.1.4 硬要求 **JDK 21+**，
 * 所以必须显式指定 21 那套，否则 headless 起不来（rea doctor 的 ghidra-java 会红）。
 */
export const resolveJavaHome = (config = {}) => {
  const prefix = process.env.PREFIX ?? "/data/data/com.dsharnessmobile.shell/files/usr";
  const candidates = [
    config.javaHome,
    process.env.DSH_REA_JAVA_HOME,
    join(prefix, "lib", "jvm", "java-21-openjdk"),
    "/usr/lib/jvm/java-21-openjdk",
    process.env.JAVA_HOME,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate === "" || !isAbsolute(candidate)) continue;
    if (isFile(join(candidate, "bin", "java"))) return candidate;
  }
  return "";
};

/** 原生反编译器是否就位（REA 会按自身可执行头校验它，编错平台会报 incompatible）。 */
export const ghidraNativeState = (installDir) => {
  const decompile =
    installDir === ""
      ? ""
      : join(installDir, "Ghidra", "Features", "Decompiler", "os", GHIDRA_NATIVE_DIRNAME, "decompile");
  return { path: decompile, present: isFile(decompile) };
};

// ------------------------------------------------- Ghidra 的 android 平台放行

/**
 * REA 的 Ghidra provider 把「平台 → 原生工具目录」和「平台 → 可执行格式」写死在两张表里，
 * 表里都没有 android，于是 `rea doctor` 报三条红：
 *
 *   ghidra-platform             unsupported_host android
 *   ghidra-architecture         unsupported_host arm64
 *   ghidra-native_decompiler    Matching native decompiler for android/arm64 was not found
 *
 * Android 的原生二进制就是 ELF，aarch64 与 linux_arm_64 同构，所以只要在两张表里
 * 各补一行 android 指向 linux_*，三条检查会同时转绿 —— 而原生件仍然是我们**本机自己编的**那一份。
 */
export const GHIDRA_PATCH_FILE = join("dist", "ghidra", "GhidraInstallation.js");

/** 放行标记：这一行是补丁插进去的，用它判断幂等。 */
export const GHIDRA_PATCH_MARK = 'android: { x64: "linux_x86_64", arm64: "linux_arm_64" },';

const GHIDRA_PATCH_EDITS = [
  {
    needle: 'const NATIVE_PLATFORMS = {\n    linux: { x64: "linux_x86_64", arm64: "linux_arm_64" },',
    replacement:
      'const NATIVE_PLATFORMS = {\n    android: { x64: "linux_x86_64", arm64: "linux_arm_64" },\n    linux: { x64: "linux_x86_64", arm64: "linux_arm_64" },',
  },
  {
    needle: 'const NATIVE_TOOL_FORMATS = {\n    linux: "elf",',
    replacement: 'const NATIVE_TOOL_FORMATS = {\n    android: "elf",\n    linux: "elf",',
  },
];

/** 报告 Ghidra 平台补丁状态。 */
export const ghidraPatchState = (reaEntry) => {
  const root = reaRootOf(reaEntry);
  if (root === "") return { root: "", patched: false, present: false };
  const file = join(root, GHIDRA_PATCH_FILE);
  if (!isFile(file)) return { root, patched: false, present: false };
  try {
    return { root, patched: readFileSync(file, "utf8").includes(GHIDRA_PATCH_MARK), present: true };
  } catch {
    return { root, patched: false, present: true };
  }
};

/** 幂等地给 Ghidra provider 放行 android（外部安装需 allowOutsideVendor）。 */
export const applyGhidraPatch = (reaEntry, { allowOutsideVendor = false } = {}) => {
  const root = reaRootOf(reaEntry);
  if (root === "") return { ok: false, reason: "rea-entry-unresolved", changed: [] };
  const insideVendor = root.startsWith(PLUGIN_DIR) || root.startsWith(CANONICAL_PLUGIN_DIR);
  if (!insideVendor && !allowOutsideVendor) {
    return { ok: false, reason: "outside-vendor-denied", root, changed: [] };
  }
  const file = join(root, GHIDRA_PATCH_FILE);
  if (!isFile(file)) return { ok: false, reason: "patch-file-missing", root, changed: [] };
  try {
    let source = readFileSync(file, "utf8");
    if (source.includes(GHIDRA_PATCH_MARK)) return { ok: true, root, changed: [] };
    const changed = [];
    for (const { needle, replacement } of GHIDRA_PATCH_EDITS) {
      if (!source.includes(needle)) continue;
      source = source.split(needle).join(replacement);
      changed.push(needle.slice(0, 44));
    }
    if (changed.length === 0) return { ok: false, reason: "needle-not-found", root, changed: [] };
    writeFileSync(file, source);
    return { ok: true, root, changed };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error), root, changed: [] };
  }
};
