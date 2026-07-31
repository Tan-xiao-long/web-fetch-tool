#!/usr/bin/env node
/**
 * webtool —— 给 Cline（以及任何能执行 shell 命令的 AI 编码工具）用的联网工具集。
 *
 *   webtool fetch <url> [--start N] [--max N] [--raw] [--json]
 *   webtool search <query...> [-n 8] [--backend duckduckgo|searxng|brave|tavily|google] [--json]
 *   webtool wiki <query...> [-n 10] [--space KEY] [--json]     # Confluence 搜索
 *   webtool page <pageId|url> [--max N] [--json]               # Confluence 取正文
 *   webtool config [--set KEY=VALUE ...] [--path]
 *   webtool doctor
 *
 * 设计目标：输出永远把「来源 URL」放在最显眼的位置，让人和模型都能一眼看到信息出处。
 */
import fs from "node:fs";
import path from "node:path";
import { config, CONFIG_DIR, CONFIG_FILE, confluenceConfigured } from "./config.js";
import { httpGet } from "./http.js";
import { responseToText, paginate } from "./extract.js";
import { webSearch, availableBackends } from "./search.js";
import { confluenceSearch, confluenceGetPage } from "./confluence.js";

const VERSION = "1.0.0";

/* ---------------------------- 参数解析 ---------------------------- */

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("-")) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (/^-[a-zA-Z]$/.test(a)) {
      flags[a.slice(1)] = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// 被 | head 之类截断时不要抛 EPIPE
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); });

const out = (s) => process.stdout.write(s + "\n");
const die = (msg, code = 1) => { process.stderr.write("ERROR: " + msg + "\n"); process.exit(code); };
const json = (o) => out(JSON.stringify(o, null, 2));

/* ---------------------------- fetch ---------------------------- */

async function cmdFetch(positional, flags) {
  const url = positional[0];
  if (!url) die("用法：webtool fetch <url> [--start N] [--max N] [--raw]");

  const maxLength = Number(flags.max ?? flags.m ?? config.maxLength);
  const startIndex = Number(flags.start ?? flags.s ?? 0);

  const res = await httpGet(url);
  if (res.status >= 400) {
    if (flags.json) return json({ ok: false, url: res.url, status: res.status });
    die(`HTTP ${res.status} —— ${res.url}`);
  }

  const doc = responseToText(res, { raw: Boolean(flags.raw) });
  const page = paginate(doc.markdown, startIndex, maxLength);

  if (flags.json) {
    return json({
      ok: true,
      source_url: res.url,
      requested_url: url,
      title: doc.title,
      status: res.status,
      content_type: res.contentType,
      extract_mode: doc.mode,
      total_chars: page.total,
      range: [startIndex, page.nextIndex],
      truncated: page.truncated,
      content: page.text,
    });
  }

  out("=".repeat(72));
  if (doc.title) out(`TITLE:  ${doc.title}`);
  out(`SOURCE: ${res.url}`);
  if (res.url !== url) out(`（原始请求 ${url} 发生了重定向）`);
  if (doc.byline) out(`BYLINE: ${doc.byline}`);
  out(
    `INFO:   HTTP ${res.status} | ${res.contentType.split(";")[0] || "?"} | ` +
      `提取方式 ${doc.mode} | 正文共 ${page.total} 字符，本次显示 ${startIndex}-${page.nextIndex}`
  );
  out("=".repeat(72));
  out("");
  out(page.text);
  out("");
  if (page.truncated) {
    out("-".repeat(72));
    out(
      `[已截断] 还剩 ${page.total - page.nextIndex} 字符。` +
        `继续阅读请执行： webtool fetch "${res.url}" --start ${page.nextIndex}`
    );
  }
}

/* ---------------------------- search ---------------------------- */

async function cmdSearch(positional, flags) {
  const query = positional.join(" ").trim();
  if (!query) die(`用法：webtool search <关键词> [-n 8] [--backend ${availableBackends.join("|")}]`);

  const count = Number(flags.n ?? flags.num ?? config.searchResults);
  const { backend, results } = await webSearch(query, count, flags.backend);

  if (flags.json) return json({ ok: true, query, backend, count: results.length, results });

  out("=".repeat(72));
  out(`SEARCH: ${query}`);
  out(`ENGINE: ${backend}   共 ${results.length} 条结果`);
  out("=".repeat(72));
  if (!results.length) {
    out("\n（没有结果。可以换关键词，或用 --backend 切换搜索后端。）");
    return;
  }
  results.forEach((r, i) => {
    out("");
    out(`[${i + 1}] ${r.title}`);
    out(`    URL: ${r.url}`);
    if (r.snippet) out(`    ${r.snippet}`);
  });
  out("");
  out("-".repeat(72));
  out('想读某条的正文，执行： webtool fetch "<上面的 URL>"');
}

/* ---------------------------- confluence ---------------------------- */

async function cmdWiki(positional, flags) {
  const query = positional.join(" ").trim();
  if (!query && !flags.cql) die("用法：webtool wiki <关键词> [-n 10] [--space KEY] [--cql '<原始CQL>']");

  const limit = Number(flags.n ?? flags.num ?? 10);
  const { cql, results } = await confluenceSearch(query, {
    limit,
    space: flags.space,
    cql: typeof flags.cql === "string" ? flags.cql : undefined,
  });

  if (flags.json) return json({ ok: true, query, cql, count: results.length, results });

  out("=".repeat(72));
  out(`CONFLUENCE 搜索: ${query || flags.cql}`);
  out(`CQL:    ${cql}`);
  out(`SITE:   ${config.confluence.baseUrl}   共 ${results.length} 条`);
  out("=".repeat(72));
  if (!results.length) {
    out("\n（没有结果。换个关键词，或用 --space 限定空间、--cql 写原始 CQL。）");
    return;
  }
  results.forEach((r, i) => {
    out("");
    out(`[${i + 1}] ${r.title}`);
    out(`    URL:  ${r.url}`);
    out(`    ID:   ${r.id}   空间: ${r.space || "-"}   更新: ${r.lastModified || "-"}`);
    if (r.excerpt) out(`    ${r.excerpt}`);
  });
  out("");
  out("-".repeat(72));
  out("读全文： webtool page <上面的 ID 或 URL>");
}

async function cmdPage(positional, flags) {
  const target = positional[0];
  if (!target) die("用法：webtool page <pageId 或 页面URL> [--max N] [--start N]");

  const p = await confluenceGetPage(target);
  const maxLength = Number(flags.max ?? flags.m ?? config.maxLength);
  const startIndex = Number(flags.start ?? flags.s ?? 0);
  const page = paginate(p.markdown, startIndex, maxLength);

  if (flags.json) {
    return json({ ok: true, ...p, markdown: undefined, content: page.text, total_chars: page.total, truncated: page.truncated });
  }

  out("=".repeat(72));
  out(`TITLE:  ${p.title}`);
  out(`SOURCE: ${p.url}`);
  out(`INFO:   Confluence 页面 ${p.id || "-"} | 空间 ${p.space || "-"} | v${p.version ?? "-"} | ${p.lastModified || "-"}`);
  out(`        正文共 ${page.total} 字符，本次显示 ${startIndex}-${page.nextIndex}`);
  out("=".repeat(72));
  out("");
  out(page.text);
  if (page.truncated) {
    out("");
    out("-".repeat(72));
    out(`[已截断] 继续： webtool page ${p.id || target} --start ${page.nextIndex}`);
  }
}

/* ---------------------------- config / doctor ---------------------------- */

function cmdConfig(positional, flags) {
  if (flags.path) return out(CONFIG_FILE);

  let current = {};
  if (fs.existsSync(CONFIG_FILE)) current = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));

  const sets = []
    .concat(flags.set || [])
    .concat(positional.filter((p) => p.includes("=")));

  if (sets.length) {
    for (const kv of [].concat(sets)) {
      const idx = String(kv).indexOf("=");
      if (idx < 0) continue;
      const k = String(kv).slice(0, idx).trim();
      const v = String(kv).slice(idx + 1).trim();
      if (v === "") delete current[k];
      else current[k] = v;
    }
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
    out(`已写入 ${CONFIG_FILE}`);
  }

  const masked = Object.fromEntries(
    Object.entries(current).map(([k, v]) => [
      k,
      /TOKEN|KEY|PASSWORD|SECRET/i.test(k) && String(v)
        ? String(v).slice(0, 4) + "****"
        : v,
    ])
  );
  out("当前配置：");
  out(JSON.stringify(masked, null, 2));
}

async function cmdDoctor() {
  out(`webtool v${VERSION}   node ${process.version}`);
  out(`配置文件: ${CONFIG_FILE} ${fs.existsSync(CONFIG_FILE) ? "(存在)" : "(不存在，用默认值)"}`);
  out(`代理:     ${config.proxy || "(未设置，直连)"}`);
  out(`搜索后端: ${config.searchBackend}`);
  out(`内网放行: WEB_ALLOW_PRIVATE=${config.allowPrivate} allowHosts=${config.allowHosts.join(",") || "-"}`);
  out(`Confluence: ${confluenceConfigured() ? config.confluence.baseUrl : "(未配置)"}`);
  out("");

  const check = async (label, fn) => {
    const t = Date.now();
    try {
      const detail = await fn();
      out(`  [OK]   ${label}  ${Date.now() - t}ms  ${detail || ""}`);
    } catch (e) {
      out(`  [FAIL] ${label}  ${e.message}`);
    }
  };

  out("连通性自检：");
  await check("HTTP 抓取 (example.com)", async () => {
    const r = await httpGet("https://example.com");
    return `HTTP ${r.status}, ${r.bytes} bytes`;
  });
  await check(`搜索后端 (${config.searchBackend})`, async () => {
    const { results } = await webSearch("hello world", 3);
    return `${results.length} 条结果`;
  });
  if (confluenceConfigured()) {
    await check("Confluence 搜索", async () => {
      const { results } = await confluenceSearch("test", { limit: 3 });
      return `${results.length} 条结果`;
    });
  }
}

/* ---------------------------- help ---------------------------- */

function help() {
  out(`webtool v${VERSION} —— 给 AI 编码助手用的联网工具集

用法:
  webtool fetch <url> [--start N] [--max N] [--raw] [--json]
      抓取网页并转成 Markdown 正文。输出顶部固定展示来源 URL。
      --start  从第 N 个字符开始（用于翻页读长文）
      --max    本次最多返回多少字符（默认 ${config.maxLength}）
      --raw    不做正文提取，返回原始 HTML

  webtool search <关键词...> [-n 8] [--backend <引擎>] [--json]
      公网搜索，返回 标题 / URL / 摘要。
      可用引擎: ${availableBackends.join(", ")}

  webtool wiki <关键词...> [-n 10] [--space KEY] [--cql '<CQL>'] [--json]
      搜索内网 Confluence。

  webtool page <pageId|url> [--start N] [--max N] [--json]
      读取 Confluence 页面正文（Markdown）。

  webtool config --set KEY=VALUE ...      写入配置（存 ${CONFIG_FILE}）
  webtool doctor                          自检：代理、搜索后端、Confluence 连通性

常用配置项:
  WEB_SEARCH_BACKEND   duckduckgo(默认) | searxng | brave | tavily | google
  SEARXNG_URL / BRAVE_API_KEY / TAVILY_API_KEY / GOOGLE_API_KEY + GOOGLE_CSE_ID
  WEB_PROXY            http://proxy.corp.com:8080
  NO_PROXY             corp.com,localhost
  WEB_ALLOW_HOSTS      wiki.corp.com,confluence.corp.com   （放行内网域名）
  CONFLUENCE_BASE_URL  https://wiki.corp.com
  CONFLUENCE_TOKEN     Server/DC 的 Personal Access Token
  CONFLUENCE_EMAIL + CONFLUENCE_API_TOKEN                   （Atlassian Cloud）
`);
}

/* ---------------------------- main ---------------------------- */

async function main() {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgs(argv);
  const cmd = positional.shift();

  if (!cmd || flags.help || flags.h || cmd === "help") return help();
  if (flags.version || flags.v || cmd === "version") return out(VERSION);

  switch (cmd) {
    case "fetch": case "get": case "read":   return cmdFetch(positional, flags);
    case "search": case "s":                 return cmdSearch(positional, flags);
    case "wiki": case "confluence":          return cmdWiki(positional, flags);
    case "page": case "wiki-page":           return cmdPage(positional, flags);
    case "config":                           return cmdConfig(positional, flags);
    case "doctor": case "check":             return cmdDoctor();
    default:
      // 直接给了个 URL 就当 fetch
      if (/^https?:\/\//i.test(cmd)) return cmdFetch([cmd, ...positional], flags);
      die(`未知命令 "${cmd}"，执行 webtool --help 查看用法`);
  }
}

main().catch((e) => die(e?.message || String(e)));
