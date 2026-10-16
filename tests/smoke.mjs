/**
 * dsh-rea 冒烟测试：不需要 DSH，用假的 ctx 直接驱动插件的四个工具。
 *
 *   node tests/smoke.mjs                       # 用插件自带 vendor 里的 REA
 *   DSH_REA_ENTRY=/abs/rea.mjs node tests/smoke.mjs   # 指定外部 REA
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const registered = new Map();
const effects = [];

const ctx = {
  logger: {
    info: (message) => process.stderr.write(`[log] ${message}\n`),
    warn: (message) => process.stderr.write(`[warn] ${message}\n`),
  },
  effect(fn) {
    const dispose = fn();
    effects.push(dispose);
    return dispose;
  },
  tools: {
    register(tool) {
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    },
  },
};

const plugin = await import(join(PLUGIN_DIR, "index.js"));
plugin.apply(ctx, { log: true });

const call = async (name, args) => {
  const tool = registered.get(name);
  if (tool === undefined) throw new Error(`tool ${name} 未注册`);
  const value = await tool.execute(args ?? {}, {});
  return typeof value === "string" ? value : JSON.stringify(value);
};

let failures = 0;
const check = (label, condition, detail = "") => {
  process.stdout.write(`${condition ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : ` — ${detail}`}\n`);
  if (!condition) failures += 1;
};

check("注册了 4 个工具", registered.size === 4, `实际 ${registered.size}: ${[...registered.keys()].join(", ")}`);

const status = await call("rea_status", {});
process.stdout.write(`\n--- rea_status ---\n${status}\n\n`);
const parsed = JSON.parse(status);
check("REA 入口已解析", typeof parsed.rea.entry === "string" && parsed.rea.entry !== "");
check("REA 版本可读", typeof parsed.rea.version === "string");
check("node 不是 linker64", !/linker64$/u.test(parsed.node.resolved), parsed.node.resolved);
check("execPath 补丁已覆盖", parsed.androidExecPathPatch.complete === true,
  `${parsed.androidExecPathPatch.applied}/${parsed.androidExecPathPatch.expected}`);

const list = await call("rea_tools", { limit: 5 });
process.stdout.write(`\n--- rea_tools (前 5) ---\n${list}\n\n`);
check("工具清单可拉取", list.includes("REA MCP 工具"));

const filtered = await call("rea_tools", { query: "apk", limit: 6 });
process.stdout.write(`\n--- rea_tools query=apk ---\n${filtered}\n\n`);
check("关键词过滤有结果", /命中 [1-9]\d* \//u.test(filtered));

const cli = await call("rea_cli", { args: ["--version"], timeoutMs: 60_000 });
process.stdout.write(`\n--- rea_cli --version ---\n${cli}\n\n`);
check("CLI 可执行", cli.includes("6.4.0") || cli.includes("rea"));

const fixture = join(PLUGIN_DIR, "tests", "fixtures", "hello.js");

const opened = await call("rea_call", {
  tool: "open_binary",
  arguments: { path: fixture },
  timeoutMs: 120_000,
  maxBytes: 2_000,
});
process.stdout.write(`\n--- rea_call open_binary ---\n${opened.slice(0, 400)}\n\n`);
check("open_binary 打开目标", opened.includes("javascript"), opened.split("\n")[0]?.slice(0, 120));

const inspected = await call("rea_call", {
  tool: "inspect_artifact",
  arguments: {},
  timeoutMs: 180_000,
  maxBytes: 3_000,
});
process.stdout.write(`\n--- rea_call inspect_artifact ---\n${inspected.slice(0, 500)}\n\n`);
check("inspect_artifact 作用于已开目标", inspected.includes("evidence_id") && !inspected.includes("No app is open"));

const closed = await call("rea_call", { tool: "close_binary", arguments: {}, timeoutMs: 120_000, maxBytes: 1_000 });
process.stdout.write(`\n--- rea_call close_binary ---\n${closed.slice(0, 300)}\n\n`);
check("close_binary 收尾", !closed.startsWith("REA 调用失败"));

for (const dispose of effects) {
  if (typeof dispose === "function") {
    try {
      dispose();
    } catch {
      /* 忽略 */
    }
  }
}

process.stdout.write(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}\n`);
process.exit(failures === 0 ? 0 : 1);
