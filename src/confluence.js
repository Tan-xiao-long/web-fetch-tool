/**
 * Confluence 内网检索。
 * 同时兼容 Cloud（/wiki/rest/api，Basic: email:api_token）
 * 和 Server / Data Center（/rest/api，Bearer: PAT）。
 */
import { config, confluenceConfigured } from "./config.js";
import { httpGet, httpGetJson } from "./http.js";
import { htmlToMarkdown } from "./extract.js";

function authHeaders() {
  const c = config.confluence;
  if (c.token) return { authorization: `Bearer ${c.token}` };
  if (c.email && c.apiToken) {
    const b64 = Buffer.from(`${c.email}:${c.apiToken}`).toString("base64");
    return { authorization: `Basic ${b64}` };
  }
  return {};
}

/** 返回候选 API 前缀，auto 时两个都试 */
function apiPrefixes() {
  const c = config.confluence;
  if (c.flavor === "cloud") return ["/wiki/rest/api"];
  if (c.flavor === "server") return ["/rest/api"];
  // auto：atlassian.net 基本都是 Cloud
  return /atlassian\.net$/i.test(new URL(c.baseUrl).hostname)
    ? ["/wiki/rest/api", "/rest/api"]
    : ["/rest/api", "/wiki/rest/api"];
}

function assertConfigured() {
  if (!confluenceConfigured()) {
    throw new Error(
      "Confluence 未配置。请在 cline_mcp_settings.json 的 env 里设置 CONFLUENCE_BASE_URL " +
        "以及 CONFLUENCE_TOKEN（Server/DC 的 PAT）或 CONFLUENCE_EMAIL + CONFLUENCE_API_TOKEN（Cloud）。"
    );
  }
}

async function callApi(path, { query = {} } = {}) {
  assertConfigured();
  const c = config.confluence;
  let lastErr;
  for (const prefix of apiPrefixes()) {
    const url = new URL(c.baseUrl + prefix + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    try {
      return { data: await httpGetJson(url.href, { headers: { ...authHeaders(), accept: "application/json" } }), prefix };
    } catch (e) {
      lastErr = e;
      // 404 / 路径不对就试下一个前缀；鉴权错误直接抛
      if (/HTTP 40[13]/.test(e.message)) throw new Error(`Confluence 鉴权失败：${e.message}`);
    }
  }
  throw lastErr || new Error("Confluence 请求失败");
}

function buildCql(query, { space, type = "page", extraCql } = {}) {
  if (extraCql) return extraCql;
  const esc = query.replace(/["\\]/g, "\\$&");
  const parts = [`(text ~ "${esc}" OR title ~ "${esc}")`];
  if (type) parts.push(`type = "${type}"`);

  const spaces = space
    ? [space]
    : config.confluence.spaces.length
    ? config.confluence.spaces
    : [];
  if (spaces.length) {
    parts.push(`space in (${spaces.map((s) => `"${s}"`).join(",")})`);
  }
  return parts.join(" AND ") + " ORDER BY lastmodified DESC";
}

export async function confluenceSearch(query, { limit = 10, space, cql } = {}) {
  const finalCql = buildCql(query, { space, extraCql: cql });
  const { data } = await callApi("/search", {
    query: { cql: finalCql, limit, expand: "content.version,content.space" },
  });

  const base = config.confluence.baseUrl;
  const results = (data.results || []).map((r) => {
    const content = r.content || {};
    const link = r.url || content._links?.webui || "";
    const prefix = data._links?.base || (/atlassian\.net$/i.test(new URL(base).hostname) ? base + "/wiki" : base);
    return {
      id: content.id || r.id || "",
      title: r.title || content.title || "(无标题)",
      space: content.space?.key || content.space?.name || r.resultGlobalContainer?.title || "",
      lastModified: r.lastModified || content.version?.when || "",
      url: link ? (link.startsWith("http") ? link : prefix.replace(/\/+$/, "") + link) : "",
      excerpt: (r.excerpt || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    };
  });
  return { cql: finalCql, results };
}

/** 从 pageId 或页面 URL 取正文，转成 Markdown */
export async function confluenceGetPage(idOrUrl) {
  assertConfigured();
  let pageId = String(idOrUrl).trim();

  if (/^https?:/i.test(pageId)) {
    const u = new URL(pageId);
    const byParam = u.searchParams.get("pageId");
    // 新版 URL 形如 /wiki/spaces/ENG/pages/123456789/Title
    const byPath = /\/pages\/(\d+)/.exec(u.pathname)?.[1];
    if (byParam || byPath) {
      pageId = byParam || byPath;
    } else {
      // display 短链：直接把整页抓下来解析
      const res = await httpGet(u.href, { headers: authHeaders() });
      const doc = htmlToMarkdown(res.body, res.url);
      return { id: "", title: doc.title, url: res.url, markdown: doc.markdown, via: "html" };
    }
  }

  const { data } = await callApi(`/content/${encodeURIComponent(pageId)}`, {
    query: { expand: "body.storage,version,space" },
  });
  const html = data.body?.storage?.value || "";
  const base = config.confluence.baseUrl;
  const webui = data._links?.webui || "";
  const prefix = /atlassian\.net$/i.test(new URL(base).hostname) ? base + "/wiki" : base;

  const doc = htmlToMarkdown(
    `<html><body>${html}</body></html>`,
    prefix + webui
  );
  return {
    id: data.id,
    title: data.title,
    space: data.space?.key || "",
    version: data.version?.number,
    lastModified: data.version?.when || "",
    url: webui ? prefix.replace(/\/+$/, "") + webui : "",
    markdown: doc.markdown,
    via: "api",
  };
}

export { confluenceConfigured };
