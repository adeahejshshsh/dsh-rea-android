/**
 * dsh-rea 安装器：
 *   1. 把 rea-agents 装进 <插件目录>/vendor（自带一份，不污染全局 npm）
 *   2. 给这份 REA 打 Android execPath 补丁 + 放行 JADX 宿主门禁（幂等）
 *   3. 可选：下载并校验 jadx-headless-mcp 0.7.1 的 fat jar（--with-jadx）
 *   4. 打印解析出来的 node / REA / JADX 路径
 *
 * 用法：
 *   node setup.mjs                 # 装 REA 6.4.0 + 打补丁
 *   node setup.mjs 6.4.0           # 指定版本
 *   node setup.mjs --no-install    # 只打补丁、只报告
 *   node setup.mjs --with-jadx     # 额外下载 JADX 引擎（约 40MB，按 sha256 校验）
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 辅助函数在 lib/paths.mjs：插件入口 index.js 只允许导出 name/inject/apply，
// 多导出函数会被 cordis loader 当成插件去挂载并抛错。
import {
  JADX_JAR_FILENAME,
  JADX_RELEASE_SHA256,
  JADX_RELEASE_URL,
  applyExecPathPatch,
  applyJadxHostGatePatch,
  jadxGateState,
  patchState,
  resolveJadxJar,
  resolveJavaTmpDir,
  resolveNodeExecPath,
  resolveReaEntry,
} from "./lib/paths.mjs";

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = join(PLUGIN_DIR, "vendor");
const REA_VERSION = "6.4.0";

const argv = process.argv.slice(2);
const noInstall = argv.includes("--no-install");
const withJadx = argv.includes("--with-jadx");
const version = argv.find((item) => /^\d+\.\d+\.\d+$/u.test(item)) ?? REA_VERSION;

const log = (message) => process.stdout.write(`${message}\n`);

const node = resolveNodeExecPath({});
log(`[dsh-rea] 真 node 可执行文件: ${node}`);
log(`[dsh-rea] process.execPath   : ${process.execPath}${
  /linker64$/u.test(process.execPath) ? "  ← Android linker64，正是需要绕开的那个" : ""
}`);

if (!noInstall) {
  const reaEntryInVendor = join(VENDOR_DIR, "node_modules", "rea-agents", "scripts", "rea.mjs");
  if (existsSync(reaEntryInVendor)) {
    log(`[dsh-rea] vendor 里已有 REA，跳过安装（要重装先删 ${VENDOR_DIR}）`);
  } else {
    mkdirSync(VENDOR_DIR, { recursive: true });
    const vendorManifest = join(VENDOR_DIR, "package.json");
    if (!existsSync(vendorManifest)) {
      writeFileSync(
        vendorManifest,
        `${JSON.stringify({ name: "dsh-rea-vendor", private: true, version: "0.0.0" }, null, 2)}\n`,
      );
    }
    log(`[dsh-rea] 安装 rea-agents@${version} → ${VENDOR_DIR}`);
    const result = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--prefix", VENDOR_DIR, "--no-audit", "--no-fund", "--loglevel=error", `rea-agents@${version}`],
      { stdio: "inherit", env: { ...process.env, npm_config_yes: "true" } },
    );
    if (result.status !== 0) {
      log(`[dsh-rea] npm install 失败（exit=${String(result.status)}）；也可以手动装好后再跑 --no-install`);
      process.exit(result.status ?? 1);
    }
  }
}

/**
 * 下载 jadx-headless-mcp 的 fat jar（约 40MB）并按 REA 声明的 sha256 校验。
 * 校验不过就丢弃、不落盘 —— 引擎是被 REA 直接喂给 javac 编译桥接的，来路必须干净。
 */
async function downloadJadx() {
  const target = join(VENDOR_DIR, "jadx", JADX_JAR_FILENAME);
  if (existsSync(target)) {
    log(`[dsh-rea] JADX jar 已存在，跳过下载：${target}`);
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  log(`[dsh-rea] 下载 JADX 引擎（约 40MB，慢的话等一会）：${JADX_RELEASE_URL}`);
  let response;
  try {
    response = await fetch(JADX_RELEASE_URL, { redirect: "follow" });
  } catch (error) {
    log(`[dsh-rea] 下载失败（网络）：${String(error?.message ?? error)}`);
    return;
  }
  if (!response.ok) {
    log(`[dsh-rea] 下载失败：HTTP ${response.status}`);
    return;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(buffer).digest("hex");
  if (digest !== JADX_RELEASE_SHA256) {
    log(`[dsh-rea] sha256 不匹配！期望 ${JADX_RELEASE_SHA256}，实得 ${digest} —— 已丢弃，不落盘`);
    return;
  }
  writeFileSync(target, buffer);
  log(`[dsh-rea] JADX jar 校验通过并落盘：${target}（${buffer.byteLength} 字节）`);
}

if (withJadx) await downloadJadx();

const reaEntry = resolveReaEntry({});
if (reaEntry === "") {
  log("[dsh-rea] 仍然找不到 REA 入口，请检查 vendor 目录或设置 DSH_REA_ENTRY。");
  process.exit(1);
}
log(`[dsh-rea] REA 入口: ${reaEntry}`);

let reaVersion = null;
try {
  reaVersion = JSON.parse(readFileSync(join(dirname(dirname(reaEntry)), "package.json"), "utf8")).version;
} catch {
  /* 忽略 */
}
log(`[dsh-rea] REA 版本: ${reaVersion ?? "(未知)"}`);

const before = patchState(reaEntry);
const patchResult = applyExecPathPatch(reaEntry, { allowOutsideVendor: true });
const after = patchState(reaEntry);
log(
  `[dsh-rea] execPath 补丁: 本次改动 ${patchResult.changed.length} 个文件，` +
    `覆盖率 ${after.patched}/${after.present}${
      patchResult.skipped.length > 0 ? `（跳过 ${patchResult.skipped.length}）` : ""
    }`,
);
if (!patchResult.ok) log(`[dsh-rea] 补丁未生效: ${patchResult.reason}`);
if (before.patched === after.patched && patchResult.changed.length === 0) {
  log("[dsh-rea] 补丁此前已存在（幂等，无重复改动）");
}

const gate = applyJadxHostGatePatch(reaEntry, { allowOutsideVendor: true });
const gateState = jadxGateState(reaEntry);
log(
  `[dsh-rea] JADX 宿主门禁: ${gateState.patched ? "已放行（android）" : "未放行"}` +
    `${gate.ok && gate.changed === true ? "（本次改动）" : ""}` +
    `${gate.ok ? "" : `（${gate.reason}）`}`,
);

const jadxJar = resolveJadxJar({});
log(`[dsh-rea] JADX jar   : ${jadxJar === "" ? "(未安装 —— 用 --with-jadx 下载)" : jadxJar}`);
if (jadxJar !== "") {
  const tmp = resolveJavaTmpDir({});
  log(`[dsh-rea] java tmpdir: ${tmp === "" ? "⚠️ 找不到可写目录，jadx 会失败" : tmp}`);
}

log("");
log("[dsh-rea] 下一步：");
log(`  1) 把插件装进 profile:  dsh plugin --profile web add file:${PLUGIN_DIR}`);
log(`  2) 重启 DSH，模型会多出 rea_status / rea_tools / rea_call / rea_cli 四个工具`);
log(`  3) 自检:              node ${join(PLUGIN_DIR, "tests", "smoke.mjs")}`);
log(`  装好 JADX 后（--with-jadx），rea_call/rea_cli 就能反编译 APK 的类与方法；`);
log(`  用 rea_status 看 jadx.ready 是否为 true。`);
