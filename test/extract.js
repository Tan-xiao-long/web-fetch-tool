/**
 * 内容提取：HTML -> 正文 -> Markdown。
 *
 * 思路和 Claude Code / Cursor 的 WebFetch 一致：
 *   1. Readability 抽正文（去导航、广告、页脚）
 *   2. Turndown 转 Markdown（保留标题层级、链接、代码块、表格）
 *   3. 失败则退回整页文本
 * 模型读 Markdown 比读原始 HTML 省 5~10 倍 token，且不容易被页面里的噪音带偏。
 */
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
});

// 彻底丢弃这些标签
turndown.remove(["script", "style", "noscript", "iframe", "svg", "canvas", "form"]);

// 表格：turndown 默认会把 <table> 拍平，这里保留成 Markdown 表格
turndown.addRule("table", {
  filter: "table",
  replacement(_content, node) {
    const rows = Array.from(node.querySelectorAll("tr"));
    if (!rows.length) return "";
    const cells = (tr) =>
      Array.from(tr.querySelectorAll("th,td")).map((td) =>
        (td.textContent || "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()
      );
    const head = cells(rows[0]);
    if (!head.length) return "";
    const out = [
      `| ${head.join(" | ")} |`,
      `| ${head.map(() => "---").join(" | ")} |`,
    ];
    for (const tr of rows.slice(1)) {
      const c = cells(tr);
      if (c.length) out.push(`| ${c.join(" | ")} |`);
    }
    return "\n\n" + out.join("\n") + "\n\n";
  },
});

function absolutize(doc, baseUrl) {
  const fix = (el, attr) => {
    const v = el.getAttribute(attr);
    if (!v || /^(https?:|data:|mailto:|#)/i.test(v)) return;
    try {
      el.setAttribute(attr, new URL(v, baseUrl).href);
    } catch {}
  };
  for (const a of doc.querySelectorAll("a[href]")) fix(a, "href");
  for (const img of doc.querySelectorAll("img[src]")) fix(img, "src");
}

function tidy(md) {
  return md
    .replace(/ /g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @returns {{title:string, byline:string, markdown:string, mode:string}}
 */
export function htmlToMarkdown(html, baseUrl, { raw = false } = {}) {
  if (raw) return { title: "", byline: "", markdown: html, mode: "raw-html" };

  const { document } = parseHTML(html);
  absolutize(document, baseUrl);

  const title =
    document.querySelector("title")?.textContent?.trim() ||
    document.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
    "";

  // 1) Readability 抽正文
  try {
    const clone = parseHTML(document.toString()).document;
    const article = new Readability(clone, { charThreshold: 200 }).parse();
    if (article?.content) {
      const md = tidy(turndown.turndown(article.content));
      if (md.length > 200) {
        return {
          title: article.title || title,
          byline: article.byline || "",
          markdown: md,
          mode: "readability",
        };
      }
    }
  } catch {
    /* 落到下面的兜底 */
  }

  // 2) 兜底：砍掉明显的非正文区域，整页转 Markdown
  for (const sel of [
    "script", "style", "noscript", "iframe", "svg", "nav", "header",
    "footer", "aside", "form", "[role=navigation]", "[aria-hidden=true]",
  ]) {
    for (const el of document.querySelectorAll(sel)) el.remove();
  }
  const main =
    document.querySelector("main") ||
    document.querySelector("article") ||
    document.body ||
    document.documentElement;

  return {
    title,
    byline: "",
    markdown: tidy(turndown.turndown(main?.innerHTML || html)),
    mode: "fallback",
  };
}

/** 把任意 content-type 的响应转成给模型看的文本 */
export function responseToText(res, { raw = false } = {}) {
  const ct = (res.contentType || "").toLowerCase();

  if (ct.includes("json") || /^\s*[[{]/.test(res.body.slice(0, 200))) {
    try {
      return {
        title: "",
        byline: "",
        markdown: "```json\n" + JSON.stringify(JSON.parse(res.body), null, 2) + "\n```",
        mode: "json",
      };
    } catch { /* 不是 JSON，继续 */ }
  }
  if (ct.includes("html") || ct.includes("xhtml") || /<html[\s>]/i.test(res.body.slice(0, 2000))) {
    return htmlToMarkdown(res.body, res.url, { raw });
  }
  if (ct.includes("pdf") || res.buffer?.subarray(0, 5).toString() === "%PDF-") {
    return {
      title: "",
      byline: "",
      markdown:
        "[这是一个 PDF 文件，本工具不解析二进制 PDF。可以让 Cline 用 execute_command 调用 " +
        "`pdftotext` 或 python 的 pypdf 处理下载后的文件。]",
      mode: "pdf",
    };
  }
  return { title: "", byline: "", markdown: res.body, mode: "text" };
}

/** 分页截断：返回 {text, truncated, nextIndex, total} */
export function paginate(text, startIndex, maxLength) {
  const total = text.length;
  const start = Math.min(Math.max(startIndex | 0, 0), total);
  const end = Math.min(start + maxLength, total);
  return {
    text: text.slice(start, end),
    truncated: end < total,
    nextIndex: end,
    total,
  };
}
