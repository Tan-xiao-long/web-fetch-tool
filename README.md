# webtool —— 给 Cline 补上联网能力

不改动已安装的 Cline 插件、不依赖 MCP，通过 Cline 自带的 `execute_command` 提供
**公网抓取 / 公网搜索 / 内网 Confluence 检索** 三类能力。

---

## 一、WebFetch 这类工具到底是怎么实现的

不管是 Claude Code、Cursor 还是 Cline，`WebFetch` 内部都是同一条四步流水线：

| 步骤 | 做什么 | 容易踩的坑 |
|---|---|---|
| **1. 请求** | HTTP GET，处理代理、超时、重定向、gzip、字符集 | 不设响应体大小上限，抓到大文件直接把内存打满；重定向后不再做安全校验，被 SSRF 打穿 |
| **2. 正文提取** | 用 Readability 之类的算法剥掉导航、侧边栏、广告、页脚，只留正文 | 不提取直接丢原始 HTML 给模型，token 爆炸而且噪音干扰判断 |
| **3. 格式转换** | HTML → Markdown，保留标题层级、链接、代码块、表格 | 表格被拍平成一行；相对链接没转绝对，模型拿到 `/docs/x` 没法二次抓取 |
| **4. 截断与分页** | 按字符数截断，返回"还剩多少、怎么续读" | 硬截断且不给续读入口，长文档只能读到开头 |

有些实现会在第 2 步后再加一层"用小模型把网页内容按用户 query 压缩一遍"（Claude Code 的
WebFetch 就是这么做的），本质是拿一次额外的模型调用换上下文长度。本工具没做这层——
在编码场景里保留原文的代码块和参数表通常比摘要更有用。

**搜索是另一件事。** `fetch` 只能抓已知 URL，要让模型自己找资料必须外挂一个搜索后端：
要么调商业搜索 API（Brave / Google CSE / Tavily），要么自建元搜索（SearXNG），
要么解析搜索引擎的 HTML 结果页（免 Key，但会被限流）。本工具四种都支持，默认走免 Key 的那种。

本仓库 `src/` 下的文件就是按这条流水线拆的：
`http.js`（第 1 步）→ `extract.js`（第 2、3、4 步）→ `search.js` / `confluence.js`（检索）→ `cli.js`（外壳）。

---

## 二、为什么是 CLI 而不是 MCP / VSIX

- **MCP**：最优雅，但你们禁了。
- **改 Cline 源码重打 VSIX**：能把工具做成一等公民，但要长期维护 fork，Cline 迭代很快，跟不动。
- **单独写一个 VSIX**：做不到——VSCode 没有提供"往别的扩展里注册工具"的 API，Cline 的工具表是它自己写死的。
- **CLI + 规则文件**（本方案）：Cline 通过 `execute_command` 调用，规则文件告诉模型什么时候用、怎么用。
  唯一的妥协是工具不会出现在系统提示的工具列表里，靠规则引导——实测引导得好的话稳定性没问题。

关于"看不到来源网址"的顾虑：本工具的输出把 `SOURCE:` 放在最顶部，Cline 会把命令输出完整
渲染在对话里，人和模型都能一眼看到出处；规则文件里也强制要求模型在回答中标注 URL。

---

## 三、安装

```bash
# Linux / macOS
./install.sh

# Windows PowerShell
.\install.ps1

# 想同时把规则写进某个项目
./install.sh --project /path/to/your/repo
```

安装脚本会做 5 件事，全都可逆：

1. `npm install`（4 个依赖：undici / linkedom / @mozilla/readability / turndown）
2. 在 `~/.local/bin/` 放一个 `webtool` 启动器
3. 生成配置模板 `~/.config/cline-web-tools/config.json`
4. 把使用规则写进 Cline 全局规则目录 `~/Documents/Cline/Rules/webtool.md`
5. 跑一次连通性自检

装完在 Cline 面板右上角 **Rules** 里确认 `webtool.md` 已勾选。
如果 `~/.local/bin` 不在 PATH 里，脚本会提示怎么加——**加完要重启 VSCode**，
否则插件继承的还是旧 PATH。

---

## 四、配置

改 `~/.config/cline-web-tools/config.json`，或者用命令：

```bash
webtool config --set WEB_PROXY=http://proxy.corp.com:8080
webtool config --set CONFLUENCE_BASE_URL=https://wiki.corp.com
webtool config --set CONFLUENCE_TOKEN=<你的 PAT>
webtool doctor        # 自检
```

环境变量优先级高于配置文件。用配置文件是因为 Cline 起的 shell 不一定继承你终端里的环境变量。

### 公司代理

```json
{
  "WEB_PROXY": "http://proxy.corp.com:8080",
  "NO_PROXY": "corp.com,localhost,10.0.0.0/8"
}
```

自签 CA 证书：设 `NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem`（推荐），
实在搞不定再用 `WEB_INSECURE_TLS=1` 关校验（仅限内网自用）。

### 内网域名放行

默认禁止访问私网地址（防 SSRF：`127.0.0.1`、`10.x`、`192.168.x`、
以及云元数据地址 `169.254.169.254`）。内网 wiki 要显式放行：

```json
{ "WEB_ALLOW_HOSTS": "wiki.corp.com,confluence.corp.com,gitlab.corp.com" }
```

图省事也可以 `"WEB_ALLOW_PRIVATE": "1"` 全放开，但白名单更稳妥。

### 搜索后端

| 后端 | 配置 | 说明 |
|---|---|---|
| `duckduckgo`（默认） | 无 | 免 Key、零配置。缺点：高频会被限流，国内直连大概率不通，要挂代理 |
| `searxng` | `SEARXNG_URL` | **内网环境最推荐**。docker 起一个 SearXNG，出口统一、可审计、不限流 |
| `brave` | `BRAVE_API_KEY` | 质量好，有免费额度 |
| `tavily` | `TAVILY_API_KEY` | 专为 LLM 设计，结果自带正文摘要 |
| `google` | `GOOGLE_API_KEY` + `GOOGLE_CSE_ID` | Programmable Search，每天 100 次免费 |

自建 SearXNG 只要一条命令：

```bash
docker run -d --name searxng -p 8888:8080 \
  -e SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml \
  searxng/searxng
# 记得在 settings.yml 的 search.formats 里加上 json，否则 API 返回 403
webtool config --set WEB_SEARCH_BACKEND=searxng --set SEARXNG_URL=http://searxng.corp.com:8888
```

### Confluence

Server / Data Center（用 Personal Access Token）：

```json
{
  "CONFLUENCE_BASE_URL": "https://wiki.corp.com",
  "CONFLUENCE_TOKEN": "<PAT>",
  "CONFLUENCE_SPACES": "ENG,ARCH",
  "WEB_ALLOW_HOSTS": "wiki.corp.com"
}
```

Atlassian Cloud（用邮箱 + API Token）：

```json
{
  "CONFLUENCE_BASE_URL": "https://your-org.atlassian.net",
  "CONFLUENCE_EMAIL": "you@corp.com",
  "CONFLUENCE_API_TOKEN": "<API Token>"
}
```

`CONFLUENCE_SPACES` 会自动加进 CQL 限定搜索范围，内网知识库很杂的时候很有用。

---

## 五、用法

```bash
webtool search "关键词" -n 8                       # 公网搜索
webtool fetch "https://example.com/docs"           # 抓网页转 Markdown
webtool fetch "https://..." --start 20000          # 长文翻页
webtool fetch "https://..." --raw                  # 不提取正文，给原始 HTML
webtool wiki "网关限流" --space ENG                 # 内网 Confluence 搜索
webtool page 123456789                             # 读 Confluence 页面全文
webtool doctor                                     # 自检
```

所有命令都支持 `--json`，方便脚本二次处理。

装完之后在 Cline 里直接说人话就行：

> 查一下 Vite 7 的 `build.rollupOptions` 现在怎么配

> 我们内网关于网关限流的规范是怎么写的？

Cline 会自己去调 `webtool search` / `webtool wiki`，再 `webtool fetch` 读正文。
头一两次如果它没主动调用，明确说一句「用 execute_command 跑 webtool search 查」，
之后规则就稳定生效了。

---

## 六、排查

| 现象 | 原因 / 处理 |
|---|---|
| `command not found: webtool` | `~/.local/bin` 不在 PATH，或者加了 PATH 之后没重启 VSCode |
| `请求失败 …（经代理 …）` | 代理地址不对，或内网地址没写进 `NO_PROXY` |
| `certificate` 相关报错 | 设 `NODE_EXTRA_CA_CERTS` 指向公司 CA |
| `拒绝访问内网地址` | 把域名加进 `WEB_ALLOW_HOSTS` |
| `DuckDuckGo 触发了反爬限流` | 换 `--backend searxng`，或配个商业搜索 API Key |
| `Confluence 鉴权失败` | PAT 过期，或 Cloud/Server 认证方式配错了（Cloud 要邮箱+Token，Server 用 PAT） |
| 抓回来的内容是空的 | 该页面是纯前端渲染（SPA）。找它的 API 接口直接抓 JSON，或者退回 Cline 的 `browser_action` |
| Cline 不主动调用 | 检查 Rules 里 `webtool.md` 是否勾选；或在对话里明确要求用一次 |

`webtool doctor` 会把代理、后端、Confluence 的连通性逐项跑一遍，先看它的输出。

---

## 七、目录结构

```
src/config.js       配置加载（环境变量 > 配置文件 > 默认值）
src/http.js         HTTP 层：代理、超时、逐跳重定向 + SSRF 校验、大小上限、字符集
src/extract.js      Readability 抽正文 → Turndown 转 Markdown → 分页截断
src/search.js       公网搜索，5 种后端可插拔
src/confluence.js   Confluence CQL 搜索 + 页面正文读取
src/cli.js          命令行外壳
install.js          一键安装
CLINE-RULES.md      写给模型看的使用规则
test/               本地 mock 服务，用于离线验证
```

想加新的搜索后端，在 `src/search.js` 的 `BACKENDS` 里加一个函数就行，签名是
`(query, count) => [{title, url, snippet}]`。

---

## 八、离线自测

```bash
node test/fixture-server.js &        # 假网页（含导航/广告/表格/代码块）
WEB_ALLOW_PRIVATE=1 webtool fetch http://127.0.0.1:8799/

node test/mock-confluence.js &       # 假 Confluence
WEB_ALLOW_PRIVATE=1 CONFLUENCE_BASE_URL=http://127.0.0.1:8800 \
  CONFLUENCE_TOKEN=fake CONFLUENCE_FLAVOR=server webtool wiki "网关"
```

## 卸载

删掉 `~/.local/bin/webtool`、`~/.config/cline-web-tools/`、
`~/Documents/Cline/Rules/webtool.md` 和本目录即可，没有其他残留。
