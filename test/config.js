/**
 * 集中式配置。
 *
 * 优先级：环境变量 > ~/.config/cline-web-tools/config.json > 默认值
 * 用配置文件是因为 Cline 的 execute_command 起的 shell 不一定继承你终端里的环境变量，
 * 写进配置文件最稳。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR =
  process.env.CLINE_WEB_TOOLS_HOME ||
  path.join(os.homedir(), ".config", "cline-web-tools");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

let fileConfig = {};
try {
  if (fs.existsSync(CONFIG_FILE)) {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  }
} catch (e) {
  process.stderr.write(`[warn] 配置文件解析失败 ${CONFIG_FILE}: ${e.message}\n`);
}

// 把配置文件里的值填进 process.env（已存在的环境变量不覆盖），
// 这样下面的读取逻辑只需要认 process.env 一处。
for (const [k, v] of Object.entries(fileConfig)) {
  if (v === null || v === undefined || typeof v === "object") continue;
  if (process.env[k] === undefined || process.env[k] === "") {
    process.env[k] = String(v);
  }
}

function num(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function bool(name, dflt = false) {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}

function list(name) {
  const v = process.env[name];
  if (!v) return [];
  return v
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  // ---- 抓取行为 ----
  // 单次返回给模型的最大字符数（超过部分靠 start_index 翻页）
  maxLength: num("WEB_MAX_LENGTH", 20000),
  // 下载的字节上限，防止把 200MB 的文件拉进内存
  maxBytes: num("WEB_MAX_BYTES", 8 * 1024 * 1024),
  timeoutMs: num("WEB_TIMEOUT_MS", 30000),
  maxRedirects: num("WEB_MAX_REDIRECTS", 5),
  userAgent:
    process.env.WEB_USER_AGENT ||
    "Mozilla/5.0 (compatible; ClineWebTools/1.0; +https://github.com/cline/cline)",

  // ---- 网络 ----
  // 显式代理；不填则自动读取 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
  proxy:
    process.env.WEB_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    "",
  noProxy: (process.env.NO_PROXY || process.env.no_proxy || "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // 公司自签 CA 常见：设 NODE_EXTRA_CA_CERTS=/path/ca.pem 即可；
  // 实在搞不定再开这个（不安全，仅内网自用）
  insecureTls: bool("WEB_INSECURE_TLS", false),

  // ---- 安全 ----
  // 默认禁止访问 127.0.0.1 / 10.x / 192.168.x 等内网地址（防 SSRF）。
  // 要抓内网 wiki 就打开它，或者用 WEB_ALLOW_HOSTS 精确放行。
  allowPrivate: bool("WEB_ALLOW_PRIVATE", false),
  allowHosts: list("WEB_ALLOW_HOSTS"), // 白名单，命中则跳过内网检查
  blockHosts: list("WEB_BLOCK_HOSTS"), // 黑名单，优先级最高

  // ---- 搜索后端 ----
  // duckduckgo | searxng | brave | tavily | google
  searchBackend: (process.env.WEB_SEARCH_BACKEND || "duckduckgo").toLowerCase(),
  searxngUrl: process.env.SEARXNG_URL || "",
  braveApiKey: process.env.BRAVE_API_KEY || "",
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  googleApiKey: process.env.GOOGLE_API_KEY || "",
  googleCx: process.env.GOOGLE_CSE_ID || "",
  searchResults: num("WEB_SEARCH_RESULTS", 8),

  // ---- Confluence ----
  confluence: {
    // Cloud: https://your-org.atlassian.net    Server/DC: https://wiki.corp.com
    baseUrl: (process.env.CONFLUENCE_BASE_URL || "").replace(/\/+$/, ""),
    // Server/DC 用 Personal Access Token（Bearer）
    token: process.env.CONFLUENCE_TOKEN || "",
    // Cloud 用 邮箱 + API Token（Basic）
    email: process.env.CONFLUENCE_EMAIL || "",
    apiToken: process.env.CONFLUENCE_API_TOKEN || "",
    // auto | cloud | server
    flavor: (process.env.CONFLUENCE_FLAVOR || "auto").toLowerCase(),
    // 限定空间，逗号分隔，例如 "ENG,ARCH"
    spaces: (process.env.CONFLUENCE_SPACES || "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

export function confluenceConfigured() {
  const c = config.confluence;
  return Boolean(c.baseUrl && (c.token || (c.email && c.apiToken)));
}
