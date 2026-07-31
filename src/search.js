/**
 * 公网搜索：后端可插拔。
 * fetch 只能抓"已知 URL"，要让模型自己找资料就必须有一个搜索后端。
 * 默认 duckduckgo（零配置、免 Key），有条件就切 searxng / brave / tavily / google。
 */
import { parseHTML } from "linkedom";
import { config } from "./config.js";
import { httpGet, httpGetJson } from "./http.js";

/* ---------------- DuckDuckGo（免 Key，解析 HTML 结果页） ---------------- */

async function searchDuckDuckGo(query, count) {
  const url =
    "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query) + "&kl=wt-wt";
  const res = await httpGet(url, { headers: { referer: "https://duckduckgo.com/" } });
  if (res.status >= 400) throw new Error(`DuckDuckGo 返回 HTTP ${res.status}`);

  const { document } = parseHTML(res.body);
  const out = [];

  for (const node of document.querySelectorAll(".result, .web-result")) {
    const a = node.querySelector("a.result__a");
    if (!a) continue;
    let href = a.getAttribute("href") || "";
    // DDG 会包一层跳转：//duckduckgo.com/l/?uddg=<urlencoded>
    const m = /[?&]uddg=([^&]+)/.exec(href);
    if (m) href = decodeURIComponent(m[1]);
    if (href.startsWith("//")) href = "https:" + href;
    if (!/^https?:/.test(href)) continue;

    out.push({
      title: (a.textContent || "").trim(),
      url: href,
      snippet: (node.querySelector(".result__snippet")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim(),
    });
    if (out.length >= count) break;
  }
  if (!out.length && /anomaly|unusual traffic|challenge/i.test(res.body)) {
    throw new Error("DuckDuckGo 触发了反爬限流，请稍后再试或切换到 SearXNG / Brave 后端");
  }
  return out;
}

/* ---------------- SearXNG（自建，内网最合适） ---------------- */

async function searchSearxng(query, count) {
  if (!config.searxngUrl) throw new Error("未配置 SEARXNG_URL");
  const url =
    config.searxngUrl.replace(/\/+$/, "") +
    "/search?format=json&language=zh-CN&q=" +
    encodeURIComponent(query);
  const data = await httpGetJson(url);
  return (data.results || []).slice(0, count).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: (r.content || "").replace(/\s+/g, " ").trim(),
  }));
}

/* ---------------- Brave Search API ---------------- */

async function searchBrave(query, count) {
  if (!config.braveApiKey) throw new Error("未配置 BRAVE_API_KEY");
  const url =
    "https://api.search.brave.com/res/v1/web/search?count=" +
    count +
    "&q=" +
    encodeURIComponent(query);
  const data = await httpGetJson(url, {
    headers: { "x-subscription-token": config.braveApiKey, accept: "application/json" },
  });
  return (data.web?.results || []).slice(0, count).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: (r.description || "").replace(/<[^>]+>/g, "").trim(),
  }));
}

/* ---------------- Tavily（自带正文摘要，对 LLM 最友好） ---------------- */

async function searchTavily(query, count) {
  if (!config.tavilyApiKey) throw new Error("未配置 TAVILY_API_KEY");
  const data = await httpGetJson("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: config.tavilyApiKey,
      query,
      max_results: count,
      search_depth: "basic",
    }),
  });
  return (data.results || []).slice(0, count).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: (r.content || "").replace(/\s+/g, " ").trim(),
  }));
}

/* ---------------- Google Programmable Search ---------------- */

async function searchGoogle(query, count) {
  if (!config.googleApiKey || !config.googleCx) {
    throw new Error("未配置 GOOGLE_API_KEY / GOOGLE_CSE_ID");
  }
  const url =
    "https://www.googleapis.com/customsearch/v1?key=" +
    encodeURIComponent(config.googleApiKey) +
    "&cx=" +
    encodeURIComponent(config.googleCx) +
    "&num=" +
    Math.min(count, 10) +
    "&q=" +
    encodeURIComponent(query);
  const data = await httpGetJson(url);
  return (data.items || []).slice(0, count).map((r) => ({
    title: r.title,
    url: r.link,
    snippet: (r.snippet || "").replace(/\s+/g, " ").trim(),
  }));
}

const BACKENDS = {
  duckduckgo: searchDuckDuckGo,
  ddg: searchDuckDuckGo,
  searxng: searchSearxng,
  brave: searchBrave,
  tavily: searchTavily,
  google: searchGoogle,
};

export async function webSearch(query, count = config.searchResults, backend) {
  const name = (backend || config.searchBackend).toLowerCase();
  const fn = BACKENDS[name];
  if (!fn) {
    throw new Error(
      `未知搜索后端 "${name}"，可选：${Object.keys(BACKENDS).join(", ")}`
    );
  }
  const results = await fn(query, count);
  return { backend: name, results };
}

export const availableBackends = Object.keys(BACKENDS);
