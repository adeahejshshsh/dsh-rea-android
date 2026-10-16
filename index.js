/**
 * dsh-rea — REA (Reverse Engineer Anything) 的 DSH 桥接插件。
 *
 * ⚠️ 导出面是硬契约：本文件只允许导出 `name` / `inject` / `apply`。
 * DSH 的 cordis loader 会把插件模块里的**每一个函数导出当成一个插件**去挂载，
 * 多导出一个辅助函数就会在启动时被当成插件调用并抛错（boot 直接失败）。
 * 所以所有辅助函数都在 ./lib/paths.mjs 里，这里绝不 re-export。
 *
 * 设计取舍（为什么不把 170 个 MCP 工具直接注册进来）：
 *   REA 的 MCP `tools/list` 全量载荷实测约 1.95 MB / ~55.8 万 token。任何「全量注册」
 *   都会在第一次请求就吃掉上下文窗口。所以这里只注册 4 个「闸门」工具：
 *
 *     rea_tools   检索 REA 的 170 个工具（名字 + 一句话），命中时给入参字段
 *     rea_call    按原始工具名调用任意一个 REA MCP 工具
 *     rea_cli     跑 REA 的 CLI（覆盖 MCP 没暴露的命令）
 *     rea_status  安装/版本/Android 补丁/引擎就绪状态
 *
 * 底层是一条常驻的 MCP stdio 连接（`node rea.mjs mcp`），按需启动、断了自动重连。
 *
 * Android 适配：安卓上 Node 的 process.execPath 指向 /apex/.../linker64（bionic 的
 * /proc/self/exe 指向解释器），REA 有 10 处 spawn(process.execPath) 的 worker 会因此
 * 失败。本插件：① 用真实 node 路径拉起 REA；② 传 REA_NODE_EXEC_PATH 环境变量；
 * ③ 对**自己 vendor 目录下**的 REA 副本打 execPath 补丁（绝不动全局安装）。
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  PLUGIN_DIR,
  applyExecPathPatch,
  applyGhidraPatch,
  applyJadxHostGatePatch,
  effectiveCallTimeoutMs,
  ghidraNativeState,
  ghidraPatchState,
  jadxGateState,
  patchState,
  reaRootOf,
  resolveGhidraInstallDir,
  resolveJadxJar,
  resolveJavaHome,
  resolveJavaTmpDir,
  resolveNodeExecPath,
  resolveReaEntry,
} from "./lib/paths.mjs";

export const name = "dsh-rea";
export const inject = ["tools"];

const PLUGIN_VERSION = "0.1.0";

const DEFAULTS = {
  enabled: true,
  reaEntry: "",
  nodeExecPath: "",
  jadxMcpJar: "",
  javaTmpDir: "",
  ghidraInstallDir: "",
  javaHome: "",
  // Ghidra 的启动/分析绝对时限（毫秒）。0 = 用 REA 默认（只有 330 秒，大目标必超时）。
  ghidraStartupTimeoutMs: 0,
  callTimeoutMs: 300_000,
  maxResultBytes: 80_000,
  listTimeoutMs: 60_000,
  startupTimeoutMs: 120_000,
  allowPatchOutsideVendor: false,
  log: false,
};

// --------------------------------------------------------- MCP stdio 客户端

class ReaMcpClient {
  #proc = null;
  #buffer = "";
  #pending = new Map();
  #nextId = 1;
  #ready = false;
  #starting = null;
  #restarts = 0;
  #toolCache = null;
  #stderrTail = [];
  #closing = false;

  constructor(options) {
    this.node = options.node;
    this.entry = options.entry;
    this.cwd = options.cwd;
    this.jadxJar = options.jadxJar ?? "";
    this.javaTmpDir = options.javaTmpDir ?? "";
    this.ghidraInstallDir = options.ghidraInstallDir ?? "";
    this.javaHome = options.javaHome ?? "";
    this.ghidraStartupTimeoutMs = Number(options.ghidraStartupTimeoutMs) || 0;
    this.callTimeoutMs = options.callTimeoutMs;
    this.listTimeoutMs = options.listTimeoutMs;
    this.startupTimeoutMs = options.startupTimeoutMs;
    this.log = options.log ?? (() => {});
  }

  get alive() {
    return this.#ready && this.#proc !== null && this.#proc.exitCode === null;
  }

  async #ensure() {
    if (this.alive) return;
    if (this.#starting !== null) return this.#starting;
    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start() {
    if (this.#closing) throw new Error("rea: client is closed");
    this.#ready = false;
    this.#buffer = "";
    const env = {
      ...process.env,
      REA_NODE_EXEC_PATH: this.node,
      PATH: `${dirname(this.node)}${process.env.PATH === undefined ? "" : `:${process.env.PATH}`}`,
    };
    // REA 的 JADX 链路需要这两个变量才能在本机跑起来（jar + JVM 临时目录）。
    if (this.jadxJar !== "") env.REA_JADX_MCP_JAR = this.jadxJar;
    // Ghidra 原生链路需要安装根 + JDK 21：本机 PATH 上的 java 是 17，而 Ghidra 12.1.4 硬要求 21+，
    // 不显式给 JAVA_HOME 的话 analyzeHeadless 根本起不来。
    if (this.ghidraInstallDir !== "") env.GHIDRA_INSTALL_DIR = this.ghidraInstallDir;
    if (this.javaHome !== "") env.JAVA_HOME = this.javaHome;
    // REA 的 Ghidra 启动时限默认只有 330 秒，16.8MB 的 .so 就要 8 分 19 秒，必须能抬。
    if (this.ghidraStartupTimeoutMs > 0) {
      env.REA_GHIDRA_STARTUP_TIMEOUT_MS = String(this.ghidraStartupTimeoutMs);
    }
    const jvmOptions = javaToolOptions(this.javaTmpDir);
    if (jvmOptions !== "") env.JAVA_TOOL_OPTIONS = jvmOptions;
    this.log(`rea: spawning ${this.node} ${this.entry} mcp`);
    const proc = spawn(this.node, [this.entry, "mcp"], {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => this.#onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      const text = String(chunk);
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        this.#stderrTail.push(line);
        if (this.#stderrTail.length > 40) this.#stderrTail.shift();
      }
    });
    proc.on("exit", (code, signal) => this.#onExit(code, signal));
    proc.on("error", (error) => {
      this.#failAll(new Error(`rea: spawn failed: ${String(error?.message ?? error)}`));
      this.#ready = false;
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`rea: MCP startup timed out after ${this.startupTimeoutMs} ms`));
      }, this.startupTimeoutMs);
      proc.once("spawn", () => {
        clearTimeout(timer);
        resolve();
      });
      proc.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "dsh-rea", version: PLUGIN_VERSION },
      },
      this.listTimeoutMs,
    );
    this.#write({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.#ready = true;
    this.#restarts = 0;
  }

  #onData(chunk) {
    this.#buffer += chunk;
    for (;;) {
      const index = this.#buffer.indexOf("\n");
      if (index === -1) break;
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // 非 JSON 行忽略，不污染调用结果
      }
      if (message === null || typeof message !== "object") continue;
      const id = message.id;
      if (id === undefined || id === null) continue; // notification
      const waiter = this.#pending.get(id);
      if (waiter === undefined) continue;
      this.#pending.delete(id);
      clearTimeout(waiter.timer);
      if (message.error !== undefined) {
        waiter.reject(
          new Error(`rea: ${String(message.error?.code ?? "error")} ${String(message.error?.message ?? "")}`),
        );
      } else {
        waiter.resolve(message.result);
      }
    }
  }

  #onExit(code, signal) {
    const wasReady = this.#ready;
    this.#ready = false;
    this.#proc = null;
    this.#toolCache = null;
    this.#failAll(new Error(`rea: MCP server exited (code=${String(code)}, signal=${String(signal)})`));
    if (this.#closing) return;
    if (wasReady && this.#restarts < 5) {
      this.#restarts += 1;
      const delay = Math.min(500 * 2 ** this.#restarts, 10_000);
      this.log(`rea: server died, reconnect attempt ${this.#restarts} in ${delay} ms`);
      setTimeout(() => {
        this.#ensure().catch((error) => this.log(`rea: reconnect failed: ${String(error)}`));
      }, delay);
    }
  }

  #failAll(error) {
    for (const [, waiter] of this.#pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#pending.clear();
  }

  #write(payload) {
    const proc = this.#proc;
    if (proc === null || proc.stdin === null || proc.stdin.destroyed) {
      throw new Error("rea: MCP server is not running");
    }
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async request(method, params, timeoutMs) {
    if (!this.alive && !(method === "initialize" && this.#starting !== null)) {
      await this.#ensure();
    }
    const id = this.#nextId++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`rea: ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  async tools({ refresh = false } = {}) {
    if (refresh) this.#toolCache = null;
    if (this.#toolCache !== null) return this.#toolCache;
    const result = await this.request("tools/list", {}, this.listTimeoutMs);
    this.#toolCache = Array.isArray(result?.tools) ? result.tools : [];
    return this.#toolCache;
  }

  async call(rawName, args, timeoutMs) {
    return await this.request("tools/call", { name: rawName, arguments: args ?? {} }, timeoutMs);
  }

  stderrTail() {
    return this.#stderrTail.slice(-10);
  }

  close() {
    this.#closing = true;
    this.#failAll(new Error("rea: client closed"));
    const proc = this.#proc;
    this.#proc = null;
    this.#ready = false;
    if (proc !== null && proc.exitCode === null) {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* 已经没了 */
      }
    }
  }
}

// ---------------------------------------------------------------- 小工具

const truncate = (text, maxBytes) => {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  const head = buffer.subarray(0, maxBytes).toString("utf8");
  return `${head}\n\n… [已截断：共 ${buffer.byteLength} 字节，只返回前 ${maxBytes} 字节。调大 maxBytes 或用 rea_cli 落盘再读]`;
};

const firstSentence = (text, limit = 110) => {
  const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const stop = cut.search(/[。.;；!！?？]\s/u);
  return stop > 30 ? cut.slice(0, stop + 1) : `${cut}…`;
};

/** REA 的 inputSchema 里，入参定义在 properties（可能 $ref 到 $defs）。 */
const schemaFieldNames = (schema) => {
  const properties = schema?.properties;
  if (properties === null || typeof properties !== "object") return "";
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.keys(properties)
    .map((key) => (required.has(key) ? `${key}*` : key))
    .join(", ");
};

const runProcess = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code, signal, timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已经没了 */
      }
      finish(null, null, true);
    }, options.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += `\n[spawn error] ${String(error?.message ?? error)}`;
      finish(null, null, false);
    });
    child.on("close", (code, signal) => finish(code, signal, false));
  });

/** 给 JVM 的临时目录参数（原因见 lib/paths.mjs 里 resolveJavaTmpDir 的说明）。 */
const JAVA_TMP_FLAG = "-Djava.io.tmpdir=";

const javaToolOptions = (javaTmpDir) => {
  const existing = String(process.env.JAVA_TOOL_OPTIONS ?? "");
  if (javaTmpDir === "") return existing;
  if (existing.includes(JAVA_TMP_FLAG)) return existing; // 调用方已显式指定，不覆盖
  return `${existing} ${JAVA_TMP_FLAG}${javaTmpDir}`.trim();
};

/** 与 fujiang-armor 一致：裸对象注册用的 output 形状（schema 必须是完整 JSON Schema）。 */
const TEXT_OUTPUT = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: String(value) }],
};

// ---------------------------------------------------------------- 插件本体

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...(config ?? {}) };
  if (settings.enabled === false) {
    ctx.logger?.info?.("[dsh-rea] disabled by config");
    return;
  }

  const node = resolveNodeExecPath(settings);
  const reaEntry = resolveReaEntry(settings);
  const log = (message) => {
    if (settings.log) ctx.logger?.info?.(`[dsh-rea] ${message}`);
  };

  const jadxJar = resolveJadxJar(settings);
  const javaTmpDir = resolveJavaTmpDir(settings);
  const ghidraInstallDir = resolveGhidraInstallDir(settings);
  const javaHome = resolveJavaHome(settings);
  const ghidraStartupTimeoutMs = Number(settings.ghidraStartupTimeoutMs) || 0;

  try {
    if (reaEntry === "") {
      ctx.logger?.warn?.(
        `[dsh-rea] 找不到 REA 入口：先跑 \`node ${join(PLUGIN_DIR, "setup.mjs")}\`，或在 config.reaEntry 指定 scripts/rea.mjs 绝对路径。`,
      );
    } else {
      const state = patchState(reaEntry);
      if (state.present > 0 && state.patched < state.present) {
        const result = applyExecPathPatch(reaEntry, {
          allowOutsideVendor: settings.allowPatchOutsideVendor === true,
        });
        if (result.ok && result.changed.length > 0) {
          ctx.logger?.info?.(
            `[dsh-rea] 已给 ${result.changed.length} 个 REA 文件打 Android execPath 补丁（${result.root}）`,
          );
        } else if (!result.ok) {
          ctx.logger?.warn?.(
            `[dsh-rea] execPath 补丁跳过（${result.reason}）：REA 不在本插件 vendor 目录内。`,
          );
        }
      }
      // JADX 链路：REA 的宿主白名单只认 linux/darwin/win32-x64，安卓上 process.platform
      // 是 "android"，于是 APK 反编译被误判 unsupported_host。放行它（实测引擎能跑）。
      const gate = applyJadxHostGatePatch(reaEntry, {
        allowOutsideVendor: settings.allowPatchOutsideVendor === true,
      });
      if (gate.ok && gate.changed === true) {
        ctx.logger?.info?.("[dsh-rea] 已放行 REA 的 JADX 宿主门禁（android）");
      } else if (!gate.ok) {
        ctx.logger?.warn?.(`[dsh-rea] JADX 门禁补丁跳过（${gate.reason}）`);
      }
      // Ghidra 链路：REA 的「平台→原生工具目录」与「平台→可执行格式」两张表里都没有 android，
      // 于是安卓上 ghidra-platform / ghidra-architecture / ghidra-native_decompiler 三条全红。
      // 补两行放行（二进制仍是本机自己编的 aarch64 那份）。
      const ghidraGate = applyGhidraPatch(reaEntry, {
        allowOutsideVendor: settings.allowPatchOutsideVendor === true,
      });
      if (ghidraGate.ok && ghidraGate.changed.length > 0) {
        ctx.logger?.info?.("[dsh-rea] 已给 REA 的 Ghidra provider 放行 android 平台");
      } else if (!ghidraGate.ok) {
        ctx.logger?.warn?.(`[dsh-rea] Ghidra 平台补丁跳过（${ghidraGate.reason}）`);
      }
    }
  } catch (error) {
    // 补丁只是优化，绝不让它拖垮宿主启动。
    ctx.logger?.warn?.(`[dsh-rea] 启动自检失败（忽略，不影响启动）：${String(error?.message ?? error)}`);
  }

  const client = new ReaMcpClient({
    node,
    entry: reaEntry,
    cwd: PLUGIN_DIR,
    jadxJar,
    javaTmpDir,
    ghidraInstallDir,
    javaHome,
    ghidraStartupTimeoutMs,
    callTimeoutMs: Number(settings.callTimeoutMs) || DEFAULTS.callTimeoutMs,
    listTimeoutMs: DEFAULTS.listTimeoutMs,
    startupTimeoutMs: DEFAULTS.startupTimeoutMs,
    log,
  });

  const requireEntry = () => {
    if (reaEntry === "") {
      throw new Error(
        `REA 未安装或入口未解析。运行 \`node ${join(PLUGIN_DIR, "setup.mjs")}\` 安装 REA，或设置 config.reaEntry。`,
      );
    }
  };

  ctx.effect(() => () => client.close());

  // ---- rea_status -------------------------------------------------------
  ctx.tools.register({
    name: "rea_status",
    description:
      "REA 桥接状态：REA 版本与入口、真 node 路径、Android execPath 补丁覆盖率、可选 doctor 就绪摘要。" +
      "在 rea_call 报连接错误、或想知道 REA 在本机哪些分析链路可用时先调它。",
    parameters: {
      type: "object",
      properties: {
        includeDoctor: {
          type: "boolean",
          description: "true 时额外跑 `rea doctor` 并返回引擎/宿主就绪摘要（约 1-3 秒）。",
        },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const state = patchState(reaEntry);
      let reaVersion = null;
      let reaRoot = "";
      try {
        reaRoot = reaRootOf(reaEntry);
        if (reaRoot !== "") {
          reaVersion = JSON.parse(readFileSync(join(reaRoot, "package.json"), "utf8")).version ?? null;
        }
      } catch {
        /* 读不到就算了 */
      }
      const payload = {
        plugin: { name, version: PLUGIN_VERSION, dir: PLUGIN_DIR },
        rea: { entry: reaEntry || null, root: reaRoot || null, version: reaVersion, mcpConnected: client.alive },
        node: { resolved: node, processExecPath: process.execPath },
        androidExecPathPatch: {
          applied: state.patched,
          expected: state.present,
          complete: state.present > 0 && state.patched === state.present,
        },
        jadx: {
          jar: jadxJar || null,
          jarConfigured: jadxJar !== "",
          hostGatePatched: jadxGateState(reaEntry).patched,
          javaTmpDir: javaTmpDir || null,
          ready: jadxJar !== "" && jadxGateState(reaEntry).patched,
        },
        ghidra: (() => {
          const native = ghidraNativeState(ghidraInstallDir);
          const patched = ghidraPatchState(reaEntry).patched;
          return {
            installDir: ghidraInstallDir || null,
            installDirConfigured: ghidraInstallDir !== "",
            nativeDecompile: native.path || null,
            nativePresent: native.present,
            platformGatePatched: patched,
            javaHome: javaHome || null,
            java21: javaHome !== "",
            startupTimeoutMs: ghidraStartupTimeoutMs || null,
            ready: ghidraInstallDir !== "" && native.present && patched && javaHome !== "",
          };
        })(),
        config: { callTimeoutMs: settings.callTimeoutMs, maxResultBytes: settings.maxResultBytes },
      };
      if (args?.includeDoctor === true) {
        requireEntry();
        const result = await runProcess(node, [reaEntry, "doctor", "--format", "json"], {
          cwd: PLUGIN_DIR,
          env: { ...process.env, REA_NODE_EXEC_PATH: node, ...(ghidraInstallDir !== "" ? { GHIDRA_INSTALL_DIR: ghidraInstallDir } : {}), ...(javaHome !== "" ? { JAVA_HOME: javaHome } : {}) },
          timeoutMs: 120_000,
        });
        payload.doctor = {
          exitCode: result.code,
          timedOut: result.timedOut,
          output: truncate(result.stdout.trim() || result.stderr.trim(), 20_000),
        };
      }
      return JSON.stringify(payload, null, 2);
    },
  });

  // ---- rea_tools --------------------------------------------------------
  ctx.tools.register({
    name: "rea_tools",
    description:
      "检索 REA（逆向工程工具集）的 MCP 工具清单。REA 共 170 个工具，覆盖二进制/APK/.NET/JS-Electron/" +
      "artifacts/固件/EVM/ADB 等；本插件只把 4 个闸门工具注册进 DSH，具体工具用本工具按关键词找。" +
      "不带 query 时只列工具名；带 query 时给出一句话说明与入参字段名（* = 必填）。" +
      "常用入口：open_binary（开目标）/ close_binary / binary_session（会话状态）/ " +
      "inspect_artifact（产物结构）/ analyze_javascript_application（JS-Electron 静态重建）/ " +
      "inspect_android_package（APK 声明）/ decode_android_resources（apktool 解码资源）。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "关键词，子串匹配（忽略大小写），如 apk / javascript / string / adb / evm / function。留空列全部。",
        },
        limit: { type: "number", description: "最多返回条数，默认 40。" },
        refresh: { type: "boolean", description: "true 时重新向 REA 拉取工具清单（默认用缓存）。" },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      requireEntry();
      const tools = await client.tools({ refresh: args?.refresh === true });
      const query = typeof args?.query === "string" ? args.query.trim().toLowerCase() : "";
      const limit =
        Number.isFinite(Number(args?.limit)) && Number(args.limit) > 0
          ? Math.min(Number(args.limit), 170)
          : 40;
      const matched =
        query === ""
          ? tools
          : tools.filter((tool) =>
              `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(query),
            );
      const head = `REA MCP 工具：命中 ${matched.length} / 共 ${tools.length} 个（serverName 命名空间：rea）。`;
      if (query === "") {
        const names = matched.slice(0, limit).map((tool) => tool.name);
        return `${head}\n${names.join("\n")}${
          matched.length > names.length ? `\n… 还有 ${matched.length - names.length} 个，用 query 过滤或调大 limit` : ""
        }`;
      }
      const rows = matched.slice(0, limit).map((tool) => {
        const fields = schemaFieldNames(tool.inputSchema);
        return `- ${tool.name}: ${firstSentence(tool.description)}\n  入参: ${fields === "" ? "(无)" : fields}`;
      });
      return `${head}\n${rows.join("\n")}${
        matched.length > rows.length ? `\n… 还有 ${matched.length - rows.length} 个未显示` : ""
      }`;
    },
  });

  // ---- rea_call ---------------------------------------------------------
  ctx.tools.register({
    name: "rea_call",
    description:
      "调用 REA 的任意一个 MCP 工具（原始工具名，先用 rea_tools 查名字与入参）。" +
      "REA 工具返回带 Evidence 的 JSON，覆盖产物/二进制/APK/JS/.NET 等逆向分析。" +
      "会话模型（重要）：REA 是「先开目标再分析」——绝大多数工具（inspect_artifact / list_architectures / " +
      "list_procedures / list_strings / analyze_function …）不接受路径，只作用于当前打开的目标。" +
      "所以顺序是：open_binary {path} → 若干分析工具 → close_binary。" +
      "本插件的 MCP 连接在整个 DSH 会话里常驻，open_binary 的状态会跨多次 rea_call 保持。" +
      "例外：analyze_javascript_application 这类分析器自带 input_path，不需要先 open_binary。",
    parameters: {
      type: "object",
      properties: {
        tool: { type: "string", description: "REA MCP 原始工具名，如 open_binary / inspect_artifact / list_procedures。" },
        arguments: {
          type: "object",
          additionalProperties: true,
          description: "该工具的入参对象（字段名见 rea_tools 输出）。",
        },
        timeoutMs: {
          type: "number",
          description:
            "超时毫秒。默认 = max(callTimeoutMs, ghidraStartupTimeoutMs)，下限 330000（REA 自己的 Ghidra 启动预算）。" +
            "成本主要在 Ghidra 冷启动：batch_decompile 热起来只要约 8 ms/地址，但它常常是 open_binary 之后" +
            "第一个取数的调用，会背上整个冷启动（265 KB 的 .so 约 28 s，16.8 MB 的 .so 实测 508 s）。" +
            "大目标先调大配置里的 ghidraStartupTimeoutMs，这里会自动跟着放宽。",
        },
        maxBytes: { type: "number", description: "返回截断上限（字节），默认 80000。" },
      },
      required: ["tool"],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      requireEntry();
      const tool = typeof args?.tool === "string" ? args.tool.trim() : "";
      if (tool === "") return "请给出 tool（先用 rea_tools 查工具名）。";
      const timeoutMs =
        Number.isFinite(Number(args?.timeoutMs)) && Number(args.timeoutMs) > 0
          ? Number(args.timeoutMs)
          : effectiveCallTimeoutMs(settings);
      const maxBytes =
        Number.isFinite(Number(args?.maxBytes)) && Number(args.maxBytes) > 0
          ? Number(args.maxBytes)
          : Number(settings.maxResultBytes);
      let result;
      try {
        result = await client.call(tool, args?.arguments ?? {}, timeoutMs);
      } catch (error) {
        const tail = client.stderrTail().join("\n");
        return `REA 调用失败：${String(error?.message ?? error)}${
          tail === "" ? "" : `\n--- REA stderr 尾部 ---\n${truncate(tail, 4_000)}`
        }`;
      }
      const blocks = Array.isArray(result?.content) ? result.content : [];
      const text = blocks
        .map((block) =>
          block?.type === "text" ? String(block.text ?? "") : `[${String(block?.type ?? "unknown")} 内容]`,
        )
        .join("\n");
      const flag = result?.isError === true ? "REA 报告该调用为错误结果：\n" : "";
      return flag + truncate(text === "" ? "(空结果)" : text, maxBytes);
    },
  });

  // ---- rea_cli ----------------------------------------------------------
  ctx.tools.register({
    name: "rea_cli",
    description:
      "直接跑 REA 的 CLI（覆盖 MCP 未暴露的命令，例如 decode-android-resources、analyze-javascript-application、" +
      "doctor、capabilities、setup --dry-run）。参数按数组传，不走 shell。" +
      "Android 上 apktool 链路可用：设 extraEnv.REA_APKTOOL_COMMAND 指向 `java -jar apktool.jar` 的启动脚本。",
    parameters: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string" },
          description: '命令行参数数组，如 ["capabilities"] 或 ["analyze-javascript-application","/abs/path","--format","json"]。',
        },
        cwd: { type: "string", description: "工作目录（可选）。" },
        timeoutMs: {
          type: "number",
          description: "超时毫秒。默认 = max(callTimeoutMs, ghidraStartupTimeoutMs)，下限 330000（覆盖 Ghidra 冷启动）。",
        },
        maxBytes: { type: "number", description: "输出截断上限（字节），默认 80000。" },
        extraEnv: {
          type: "object",
          additionalProperties: true,
          description: '附加环境变量，如 { "REA_APKTOOL_COMMAND": "/abs/apktool.sh" }。',
        },
      },
      required: ["args"],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      requireEntry();
      const argv = Array.isArray(args?.args) ? args.args.map((item) => String(item)) : [];
      if (argv.length === 0) return '请给出 args 数组，例如 ["capabilities"]。';
      const timeoutMs =
        Number.isFinite(Number(args?.timeoutMs)) && Number(args.timeoutMs) > 0
          ? Number(args.timeoutMs)
          : effectiveCallTimeoutMs(settings);
      const maxBytes =
        Number.isFinite(Number(args?.maxBytes)) && Number(args.maxBytes) > 0
          ? Number(args.maxBytes)
          : Number(settings.maxResultBytes);
      const extraEnv =
        args?.extraEnv !== null && typeof args?.extraEnv === "object" ? args.extraEnv : {};
      // 自动注入 JADX 链路需要的两个变量；调用方 extraEnv 优先级更高。
      const autoEnv = { REA_NODE_EXEC_PATH: node };
      if (jadxJar !== "") autoEnv.REA_JADX_MCP_JAR = jadxJar;
      if (ghidraInstallDir !== "") autoEnv.GHIDRA_INSTALL_DIR = ghidraInstallDir;
      if (javaHome !== "") autoEnv.JAVA_HOME = javaHome;
      if (ghidraStartupTimeoutMs > 0) {
        autoEnv.REA_GHIDRA_STARTUP_TIMEOUT_MS = String(ghidraStartupTimeoutMs);
      }
      const jvmOptions = javaToolOptions(javaTmpDir);
      if (jvmOptions !== "") autoEnv.JAVA_TOOL_OPTIONS = jvmOptions;
      const env = { ...process.env, ...autoEnv, ...extraEnv };
      const result = await runProcess(node, [reaEntry, ...argv], {
        cwd: typeof args?.cwd === "string" && args.cwd !== "" ? args.cwd : PLUGIN_DIR,
        env,
        timeoutMs,
      });
      const body = result.stdout.trim() === "" ? result.stderr.trim() : result.stdout.trim();
      const meta = `exit=${String(result.code)}${result.timedOut ? " (超时被杀)" : ""}${
        result.signal === null || result.signal === undefined ? "" : ` signal=${result.signal}`
      }`;
      const stderrTail =
        result.stdout.trim() === "" ? "" : `\n--- stderr ---\n${truncate(result.stderr.trim(), 4_000)}`;
      return `${meta}\n${truncate(body === "" ? "(无输出)" : body, maxBytes)}${stderrTail}`;
    },
  });

  log(`ready: node=${node} rea=${reaEntry || "(未安装)"}`);
}
