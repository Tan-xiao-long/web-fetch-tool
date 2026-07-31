#!/usr/bin/env node
/**
 * 一键安装：
 *   1. 装依赖
 *   2. 在 ~/.local/bin（Windows 是 %USERPROFILE%\.local\bin）放一个 webtool 启动器
 *   3. 生成配置文件模板 ~/.config/cline-web-tools/config.json
 *   4. 把使用规则写进 Cline 的规则文件（全局 + 当前项目），让模型知道有这个工具
 *   5. 跑一次自检
 *
 * 不改动已安装的 Cline 插件本体。
 *
 * 用法：node install.js [--project /path/to/your/repo] [--skip-deps] [--global-rules-only]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const IS_WIN = process.platform === "win32";

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const hasFlag = (name) => args.includes("--" + name);

const log = (s) => console.log(s);
const ok = (s) => console.log("  ✓ " + s);
const warn = (s) => console.log("  ! " + s);

/* ---------------- 0. 环境检查 ---------------- */

log("\n[1/5] 环境检查");
const major = Number(process.versions.node.split(".")[0]);
if (major < 18) {
  console.error(`  ✗ 需要 Node.js >= 18.17，当前 ${process.version}`);
  process.exit(1);
}
ok(`Node ${process.version}`);
ok(`安装目录 ${HERE}`);

/* ---------------- 1. 装依赖 ---------------- */

log("\n[2/5] 安装依赖");
if (hasFlag("skip-deps")) {
  warn("已跳过（--skip-deps）");
} else if (fs.existsSync(path.join(HERE, "node_modules", "turndown"))) {
  ok("依赖已存在，跳过");
} else {
  try {
    execSync("npm install --omit=dev --no-audit --no-fund", { cwd: HERE, stdio: "inherit" });
    ok("依赖安装完成");
  } catch {
    console.error(
      "  ✗ npm install 失败。如果公司有私有源，先执行：\n" +
        "      npm config set registry https://your-registry.corp.com/\n" +
        "    如果卡在代理上：\n" +
        "      npm config set proxy http://proxy.corp.com:8080\n" +
        "      npm config set https-proxy http://proxy.corp.com:8080"
    );
    process.exit(1);
  }
}

/* ---------------- 2. 放启动器 ---------------- */

log("\n[3/5] 安装 webtool 命令");
const binDir = path.join(HOME, ".local", "bin");
fs.mkdirSync(binDir, { recursive: true });
const cliPath = path.join(HERE, "src", "cli.js");

if (IS_WIN) {
  const cmd = path.join(binDir, "webtool.cmd");
  fs.writeFileSync(cmd, `@echo off\r\nnode "${cliPath}" %*\r\n`);
  const ps1 = path.join(binDir, "webtool.ps1");
  fs.writeFileSync(ps1, `node "${cliPath}" @args\r\n`);
  ok(`已写入 ${cmd}`);
} else {
  const sh = path.join(binDir, "webtool");
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`, { mode: 0o755 });
  try { fs.chmodSync(cliPath, 0o755); } catch {}
  ok(`已写入 ${sh}`);
}

const onPath = (process.env.PATH || "")
  .split(IS_WIN ? ";" : ":")
  .some((p) => path.resolve(p || "") === path.resolve(binDir));
if (!onPath) {
  warn(`${binDir} 不在 PATH 里，请加上：`);
  if (IS_WIN) {
    warn(`  setx PATH "%PATH%;${binDir}"      （然后重启 VSCode）`);
  } else {
    warn(`  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc   # zsh 改成 ~/.zshrc`);
    warn(`  然后重启 VSCode，让插件继承新的 PATH`);
  }
} else {
  ok("已在 PATH 中");
}

/* ---------------- 3. 配置文件 ---------------- */

log("\n[4/5] 生成配置文件");
const cfgDir = path.join(HOME, ".config", "cline-web-tools");
const cfgFile = path.join(cfgDir, "config.json");
fs.mkdirSync(cfgDir, { recursive: true });

if (fs.existsSync(cfgFile)) {
  ok(`已存在，未覆盖：${cfgFile}`);
} else {
  const template = {
    _说明: "环境变量优先级高于本文件。改完直接生效，不用重启。敏感字段请自行填写。",
    WEB_SEARCH_BACKEND: "duckduckgo",
    _可选搜索后端: "duckduckgo | searxng | brave | tavily | google",
    SEARXNG_URL: "",
    BRAVE_API_KEY: "",
    TAVILY_API_KEY: "",
    GOOGLE_API_KEY: "",
    GOOGLE_CSE_ID: "",
    WEB_PROXY: "",
    NO_PROXY: "localhost,127.0.0.1,corp.com",
    WEB_ALLOW_HOSTS: "",
    _内网说明: "内网域名要写进 WEB_ALLOW_HOSTS（逗号分隔），否则会被 SSRF 防护拦掉",
    CONFLUENCE_BASE_URL: "",
    CONFLUENCE_TOKEN: "",
    CONFLUENCE_EMAIL: "",
    CONFLUENCE_API_TOKEN: "",
    CONFLUENCE_SPACES: "",
    WEB_MAX_LENGTH: "20000",
    WEB_TIMEOUT_MS: "30000",
  };
  fs.writeFileSync(cfgFile, JSON.stringify(template, null, 2) + "\n", { mode: 0o600 });
  ok(`已生成模板：${cfgFile}`);
  warn("请填写 CONFLUENCE_BASE_URL / CONFLUENCE_TOKEN 和 WEB_PROXY 后再用内网功能");
}

/* ---------------- 4. 写 Cline 规则 ---------------- */

log("\n[5/5] 注册到 Cline（写规则文件，不改插件）");
const rules = fs.readFileSync(path.join(HERE, "CLINE-RULES.md"), "utf8");

// Cline 的全局规则目录
const globalRuleDirs = [
  path.join(HOME, "Documents", "Cline", "Rules"),
  path.join(HOME, "文档", "Cline", "Rules"),
];
let wroteGlobal = false;
for (const dir of globalRuleDirs) {
  if (!fs.existsSync(path.dirname(dir))) continue;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "webtool.md"), rules);
  ok(`全局规则：${path.join(dir, "webtool.md")}`);
  wroteGlobal = true;
  break;
}
if (!wroteGlobal) {
  const dir = path.join(HOME, "Documents", "Cline", "Rules");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "webtool.md"), rules);
  ok(`全局规则：${path.join(dir, "webtool.md")}`);
}
warn("在 Cline 面板右上角 → Rules 里确认 webtool.md 已勾选启用");

const project = getArg("project");
if (project && !hasFlag("global-rules-only")) {
  const dir = path.resolve(project);
  if (!fs.existsSync(dir)) {
    warn(`项目目录不存在，跳过：${dir}`);
  } else {
    const rulesDir = path.join(dir, ".clinerules");
    // 已有同名文件（旧式单文件 .clinerules）就追加，否则用目录形式
    if (fs.existsSync(rulesDir) && fs.statSync(rulesDir).isFile()) {
      fs.appendFileSync(rulesDir, "\n\n" + rules);
      ok(`已追加到 ${rulesDir}`);
    } else {
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(path.join(rulesDir, "webtool.md"), rules);
      ok(`项目规则：${path.join(rulesDir, "webtool.md")}`);
    }
  }
}

/* ---------------- 自检 ---------------- */

log("\n———— 自检 ————");
spawnSync(process.execPath, [cliPath, "doctor"], { stdio: "inherit" });

log(`
———— 安装完成 ————

试一下：
  webtool search "node fs.readFile 用法"
  webtool fetch "https://nodejs.org/api/fs.html"

然后在 Cline 里直接问一句「查一下 xxx 的最新用法」，它应该会自己调用 webtool。
如果它没调用，把这句话贴进对话：「用 execute_command 执行 webtool search 来查」，
用一两次之后规则就稳定生效了。

配置文件：${cfgFile}
卸载：删掉 ${path.join(binDir, IS_WIN ? "webtool.cmd" : "webtool")}、${cfgDir} 和规则文件即可。
`);
