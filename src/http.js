/**
 * HTTP 层：代理、超时、逐跳重定向 + SSRF 校验、响应体大小上限、字符集解码。
 *
 * 这是 web_fetch 类工具最容易被忽略、但最容易出事的一层。
 */
import dns from "node:dns/promises";
import net from "node:net";
import { fetch as undiciFetch, ProxyAgent, Agent } from "undici";
import { config } from "./config.js";

/* ------------------------------------------------------------------ */
/* dispatcher（代理 / TLS）                                            */
/* ------------------------------------------------------------------ */

let directDispatcher = null;
let proxyDispatcher = null;

function tlsOptions() {
  return config.insecureTls ? { rejectUnauthorized: false } : undefined;
}

function getDispatcher(url) {
  const host = url.hostname.toLowerCase();
  const bypass =
    !config.proxy ||
    config.noProxy.some(
      (p) => host === p || host.endsWith(p.startsWith(".") ? p : "." + p)
    );

  if (bypass) {
    directDispatcher ||= new Agent({
      connect: tlsOptions(),
      headersTimeout: config.timeoutMs,
      bodyTimeout: config.timeoutMs,
    });
    return directDispatcher;
  }
  proxyDispatcher ||= new ProxyAgent({
    uri: config.proxy,
    connect: tlsOptions(),
    headersTimeout: config.timeoutMs,
    bodyTimeout: config.timeoutMs,
  });
  return proxyDispatcher;
}

/* ------------------------------------------------------------------ */
/* SSRF 防护                                                           */
/* ------------------------------------------------------------------ */

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / 云元数据 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // ULA
    if (v.startsWith("fe80")) return true; // link-local
    if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
    return false;
  }
  return false;
}

function hostMatches(host, patterns) {
  host = host.toLowerCase();
  return patterns.some((p) => {
    if (p.startsWith("*.")) return host.endsWith(p.slice(1));
    return host === p || host.endsWith("." + p);
  });
}

async function assertUrlAllowed(url) {
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error(`只支持 http/https，收到：${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();

  if (config.blockHosts.length && hostMatches(host, config.blockHosts)) {
    throw new Error(`该域名在黑名单中：${host}`);
  }
  // 白名单命中，直接放行（内网 wiki 走这条）
  if (config.allowHosts.length && hostMatches(host, config.allowHosts)) return;
  if (config.allowPrivate) return;

  // 逐个解析出的 IP 都要检查，防 DNS rebinding
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    return; // 解析失败交给后面的请求自己报错
  }
  for (const { address } of addrs) {
    if (isPrivateIp(address)) {
      throw new Error(
        `拒绝访问内网地址 ${host} -> ${address}。` +
          `如需访问内网，请设置 WEB_ALLOW_PRIVATE=1 或把域名加进 WEB_ALLOW_HOSTS。`
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* 请求                                                                */
/* ------------------------------------------------------------------ */

function decodeBody(buf, contentType) {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType || "")?.[1];

  if (!charset) {
    // HTML 里的 <meta charset> 兜底（只看前 4KB）
    const head = buf.subarray(0, 4096).toString("latin1");
    charset =
      /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ||
      /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head)?.[1];
  }
  charset = (charset || "utf-8").toLowerCase();
  const alias = { "utf8": "utf-8", "gb2312": "gbk", "gb18030": "gb18030", "ks_c_5601-1987": "euc-kr" };
  charset = alias[charset] || charset;

  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    return buf.toString("utf-8");
  }
}

/**
 * 抓取一个 URL，自己处理重定向（每一跳都做 SSRF 校验）。
 * @returns {Promise<{url:string, status:number, contentType:string, body:string, bytes:number, truncatedBytes:boolean}>}
 */
export async function httpGet(rawUrl, { headers = {}, method = "GET", body } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`URL 格式不合法：${rawUrl}`);
  }

  let redirects = 0;
  while (true) {
    await assertUrlAllowed(url);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.timeoutMs);

    let res;
    try {
      res = await undiciFetch(url, {
        method,
        body,
        redirect: "manual",
        signal: ac.signal,
        dispatcher: getDispatcher(url),
        headers: {
          "user-agent": config.userAgent,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          "accept-encoding": "gzip, deflate, br",
          ...headers,
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (err?.name === "AbortError") {
        throw new Error(`请求超时（${config.timeoutMs}ms）：${url.href}`);
      }
      const cause = err?.cause?.message || err?.cause?.code || "";
      const via = getDispatcher(url) === proxyDispatcher ? `（经代理 ${config.proxy}）` : "（直连）";
      let hint = "";
      if (/certificate|self.signed|CERT_/i.test(cause + err?.message)) {
        hint =
          "\n提示：证书校验失败。公司自签 CA 请设置 NODE_EXTRA_CA_CERTS=/path/to/ca.pem，" +
          "临时绕过可设 WEB_INSECURE_TLS=1（仅限内网自用）。";
      } else if (getDispatcher(url) === proxyDispatcher) {
        hint = "\n提示：代理连不通。检查 WEB_PROXY / HTTPS_PROXY 是否正确，内网地址记得写进 NO_PROXY。";
      } else if (/ENOTFOUND|EAI_AGAIN/i.test(cause + err?.message)) {
        hint = "\n提示：DNS 解析不了。如果需要走公司代理上外网，请设置 WEB_PROXY=http://proxy.corp.com:8080。";
      }
      throw new Error(
        `请求失败 ${url.href} ${via}：${err?.message || err}${cause ? ` [${cause}]` : ""}${hint}`
      );
    }

    // 重定向
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      clearTimeout(timer);
      try { await res.body?.cancel(); } catch {}
      if (++redirects > config.maxRedirects) {
        throw new Error(`重定向次数超过 ${config.maxRedirects} 次`);
      }
      url = new URL(res.headers.get("location"), url);
      continue;
    }

    // 读 body，带字节上限
    const chunks = [];
    let bytes = 0;
    let truncatedBytes = false;
    try {
      if (res.body) {
        for await (const chunk of res.body) {
          const b = Buffer.from(chunk);
          if (bytes + b.length > config.maxBytes) {
            chunks.push(b.subarray(0, config.maxBytes - bytes));
            bytes = config.maxBytes;
            truncatedBytes = true;
            break;
          }
          chunks.push(b);
          bytes += b.length;
        }
      }
    } finally {
      clearTimeout(timer);
      try { await res.body?.cancel(); } catch {}
    }

    const buf = Buffer.concat(chunks);
    const contentType = res.headers.get("content-type") || "";

    return {
      url: url.href,
      status: res.status,
      contentType,
      buffer: buf,
      body: decodeBody(buf, contentType),
      bytes,
      truncatedBytes,
    };
  }
}

export async function httpGetJson(rawUrl, opts = {}) {
  const res = await httpGet(rawUrl, opts);
  if (res.status >= 400) {
    throw new Error(`HTTP ${res.status}：${res.body.slice(0, 300)}`);
  }
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error(`返回的不是合法 JSON：${res.body.slice(0, 300)}`);
  }
}
