# 联网能力：webtool

本环境安装了一个命令行工具 `webtool`，用于**访问互联网和公司内网 Confluence**。
你没有内置的联网工具，但你可以通过 `execute_command` 调用 `webtool`，这就是你的联网能力。

## 什么时候必须用它

只要出现下面任何一种情况，先用 `webtool`，不要凭记忆回答：

- 需要查某个库、框架、API 的**当前**用法、版本、参数（你的训练数据可能已经过时）
- 用户给了一个 URL，让你看/总结/参考里面的内容
- 需要查报错信息、issue、变更日志、RFC、标准文档
- 需要查公司内部的设计文档、接口约定、部署手册、规范（这些在 Confluence 上）
- 任何你不确定、可能已经变化的事实

## 命令

```bash
# 1) 公网搜索：返回 标题 / URL / 摘要
webtool search "关键词" -n 8

# 2) 抓网页：自动抽正文并转成 Markdown
webtool fetch "https://example.com/docs/xxx"
webtool fetch "https://..." --start 20000     # 内容被截断时翻页继续读
webtool fetch "https://..." --max 40000       # 一次多读一点
webtool fetch "https://.../api.json"          # JSON 会自动格式化

# 3) 内网 Confluence 搜索
webtool wiki "关键词" -n 10
webtool wiki "关键词" --space ENG             # 限定空间

# 4) 读 Confluence 页面全文
webtool page 123456789
webtool page "https://wiki.corp.com/pages/viewpage.action?pageId=123456789"
```

加 `--json` 可以拿到结构化输出（需要程序化处理时用）。

## 使用规范

1. **先搜后取**：不知道确切 URL 时，先 `webtool search`，从结果里挑最相关的 1-3 条，再逐个 `webtool fetch`。不要一次 fetch 十几个页面。
2. **内外网分流**：公司内部的东西（内部服务名、内部规范、接口文档、组织流程）用 `webtool wiki`；开源库、公开标准、报错信息用 `webtool search`。不确定就两边都查一下。
3. **必须标注来源**：每条来自网络的信息，都要在回答里写出它的 URL。`webtool` 的输出顶部有 `SOURCE:` 一行，那就是来源地址。格式示例：

   > 根据 [Node.js 官方文档](https://nodejs.org/api/fs.html)，`fs.readFile` 在 ...

4. **内容被截断时**：输出末尾会提示 `[已截断]` 和续读命令。如果剩下的部分和问题相关，就继续读；不相关就停下，不要无脑翻完。
5. **抓取失败时**：不要反复重试同一个 URL 超过 2 次。换一个来源，或者告诉用户这个站点抓不到（可能需要登录 / 被代理拦了 / 是纯前端渲染页面）。
6. **不要**用 `curl`、`wget`、`python -c "requests.get(...)"` 代替 `webtool`。`webtool` 已经处理了公司代理、证书、字符集、正文提取和长度截断，直接用 curl 会拿到一大坨 HTML 把上下文撑爆。

## 自检

工具报错时，先跑 `webtool doctor` 看代理和后端是否正常，把结果告诉用户。
