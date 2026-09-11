# 健康科技官网

AI 驱动的睡眠健康分析平台官方网站。医疗级传感器精准监测 ECG、HRV、血氧、呼吸率，AI 智能分析生成专属健康报告。

## 技术栈

- **前端**：HTML5 + CSS3 + 原生 ES6 JavaScript（无框架、无构建）
- **图标**：Lucide 本地子集（`js/vendor/lucide.min.js`，仅打包站点实际用到的 36 个图标）
- **图表**：ECharts（多 CDN 容错加载器 `js/echarts-loader.js`）
- **AI**：SiliconFlow 大模型，经 **Cloudflare Pages Functions 同域代理**调用
  - 对话 / 识图：`Qwen/Qwen3.5-4B`（命中知识库时）或 `Qwen/Qwen3-8B`（未命中走通用模式）
  - OCR 文字提取：`deepseek-ai/DeepSeek-OCR`
  - 知识库检索：本地 RAG（`shared/kb-retrieval.js`），零依赖、按标题切块 + bigram 打分
- **后端认证**：Supabase（浏览器 CDN 直连 + anon key）
- **部署**：Cloudflare Pages（主，含 Functions）+ Cloudflare Worker（备用 API 通道）

## 在线域名

| 域名 | 用途 |
|------|------|
| `health.bbroot.com` | 正式对外域名 |
| `jkkeji.pages.dev` | Pages 站点域名（Pages 项目名为 `health-management`） |
| `jkkeji-api.health-management.workers.dev` | Worker 备用 API 通道（`/chat`、`/proxy`） |

## 项目结构

```
├── index.html                 # 官网首页（含热熔字标 Hero）
├── html/
│   ├── login.html             # 登录注册页面
│   ├── health-management.html # 健康管理中心
│   └── QRcode.html            # 产品下载二维码页
├── partialshtml/              # 健康管理子页面模板（由 health-management.html 动态加载）
│   ├── user_list.html         # 用户列表
│   ├── health_trends.html     # 健康趋势
│   ├── data_analysis.html     # 数据分析
│   └── Roomreport.html        # 房间报告（含 AI 解读）
├── css/
│   ├── index.css              # 首页样式
│   ├── login.css              # 登录页样式
│   ├── JKstyle.css            # 健康管理中心样式
│   └── ai-chat.css            # AI 聊天样式（弹窗布局 + 灯箱 + 思考区）
├── js/
│   ├── index.js               # 首页交互
│   ├── thermal-wordmark.js    # 首页 Hero 热熔字标（逐像素合成动画）
│   ├── login.js               # 登录注册逻辑
│   ├── JKscript.js            # 健康管理逻辑
│   ├── ai-chat.js             # AI 助手（流式/识图/OCR/图片灯箱/Markdown 渲染）
│   ├── echarts-loader.js      # ECharts 多 CDN 容错加载器
│   ├── mobile-nav.js          # 移动端导航
│   ├── performance-optimizer.js # Supabase 性能优化
│   └── vendor/lucide.min.js   # Lucide 图标本地子集（含手工补充的 Github 图标）
├── config/
│   ├── ai-chat-config.js      # AI 助手配置（模型/上下文预算/意图策略/system prompt）
│   └── performance-config.js  # Supabase 性能配置
├── functions/api/             # Cloudflare Pages Functions（主通道，同域代理）
│   ├── chat.js                # POST /api/chat → SiliconFlow（流式/识图/OCR + RAG 注入）
│   └── proxy.js               # GET  /api/proxy → management.lifetide.cn（下载页数据）
├── workers/index.js           # Cloudflare Worker（备用 API 通道，含 CORS 白名单）
├── shared/kb-retrieval.js     # 知识库检索共享模块（Pages Functions / Worker 共用）
├── scripts/                   # 本地验证脚本（零依赖，node 直跑）
│   ├── kb-selftest.js         # 22 题知识库自测（含硬编码目标断言）
│   ├── diag-kb-v2.js          # 切块 / 体积 / 结构假设体检
│   ├── test-kb-retrieval.js   # 检索层验证（切块统计、命中/不命中用例）
│   ├── test-context-budget.js # 上下文超窗降级裁剪验证
│   └── test-ai-hardening.js   # AI 链路加固回归（XSS / 裁剪复杂度 / 请求上限 / 识图预算 / 重试策略 / 两后端常量一致）
├── Markdown/kb.md             # 知识库正文（RAG 数据源）
├── docs/                      # 自测报告与设计文档
├── images/                    # 图片资源
├── proxy-server.js            # 本地开发代理（端口 3003，供 QRcode 下载页跨域取数）
├── _headers                   # Pages 缓存与安全响应头
└── wrangler.jsonc             # Cloudflare Worker 配置
```

## 功能模块

- **官网首页**：产品介绍、功能展示、央视报道、App 下载、热熔字标 Hero
- **用户认证**：手机号注册登录，Supabase 认证，密码强度检测
- **健康管理中心**：数据统计、客户档案、健康趋势分析、房间报告
- **AI 助手（豆眼儿）**：
  - 流式输出（打字机效果，50ms 渲染节流）
  - 多模态识图（Qwen3.5-4B 免费，粘贴/上传图片自动切换）
  - OCR 文字提取（DeepSeek-OCR）
  - 知识库 RAG（命中知识库 → 严格提示词 + 4B；未命中 → 通用提示词 + 8B）
  - Markdown 渲染（标题/列表/代码块/加粗等）
  - 图片灯箱（点击消息内图片放大查看）
  - 意图分类智能策略（temperature/max_tokens 按问题类型调整）

### AI 链路的请求上限与安全约束（改动 `functions/api/chat.js` 前请先读）

`/api/chat` 是**同域公开端点**，代码层必须自己兜住单请求成本：

| 约束 | 值 | 说明 |
|------|-----|------|
| `MAX_MESSAGES` | 60 | 前端只发 ≤24 条（`config.maxMessages`），留 2.5 倍余量；超出返回 400。**校验必须先于图片分支**，否则识图请求会绕过它 |
| `MAX_IMAGE_CHARS` | 8M 字符 | 约 6MB 图片（base64 膨胀 ~1.33x）；超出返回 413 |
| `IMAGE_HISTORY_LIMIT` | 6 | 识图（understand）拼入的历史条数上限；**OCR 模式不带历史** |
| `IMAGE_HISTORY_MAX_CHARS` | 6000 | 识图历史文本总量上限（从最近一条往前累计，超预算即停）。识图路径**没有** `trimMessagesToBudget` 兜底，缺这条会原样发出超大 payload |
| `IMAGE_PROMPT_MAX_CHARS` | 2000 | 识图当前提问（prompt）截断上限 |
| 非流式重试 | 仅 5xx + 网络异常 | 4xx（401/400/429）直接透传状态码，无退避重试会加剧限流；**读 body 失败也算网络层**，同样重试 |
| `trimMessagesToBudget` | O(n) | 曾为 O(n²)：8000 条消息耗 55 秒 CPU，可被用来打满 Functions 限额 |

- **`formatContent`（`js/ai-chat.js`）必须转义引号并做 URL 协议白名单**：链接的 URL 会拼进 `href` 属性且输出走 `innerHTML`，只转义 `& < >` 时 `[x](" onmouseover="…")` 可闭合属性注入脚本。白名单里的单斜杠分支要写成 `\/(?!\/)`，否则 `[x](//evil.com)` 这种协议相对 URL 会生成外站跳转链接。改动渲染逻辑后跑 `node scripts/test-ai-hardening.js`。
- **`workers/index.js` 从未部署**，与 `functions/api/chat.js` 是重复实现（历史已漂移过）。改 chat 链路**两处都要改**；`test-ai-hardening.js` 有一项断言专门比对两边的关键常量，能挡住只改一处的疏漏。若不需要备用通道建议直接删除。
- **限流/人机校验不在代码层**：需在 Cloudflare 侧配置（WAF Rate Limiting 或 Turnstile），否则端点可被匿名滥用、烧掉 SiliconFlow 免费额度。

## 知识库（RAG）

知识库正文为 `Markdown/kb.md`（v2.1，约 46.9K 字符 / 28K token / 97 块），由 `shared/kb-retrieval.js` 在运行时按标题切块、按 bigram 覆盖率打分，取 top-4 注入 system prompt。

设计要点（改动检索逻辑前请先读）：

- **不全量注入**：28K token 超过 Worker 的 `PROMPT_TOKEN_BUDGET`（26000），实际每次注入约 700–1700 token。
- **`KB_ROUTES` 与章节号强绑定**：意图路由的目标按 kb.md 的小节编号硬编码（如 `> 16.6`），**换库或章节重排必须同步核对这张表**，否则会反向恶化。
- **`NO_SPLIT_TITLES` 白名单**：产品清单等"整表即答案"的块绕过 1500 字符二次切分，否则被切掉的行永远无法召回。
- **免责声明常驻**：命中知识库时无条件追加 16.3 免责声明（约 80 token）。
- **第十八章为噪声章**：11 项源文档冲突未处理，检索时降权不注入。

改完知识库或检索逻辑后，务必重跑：

```bash
node scripts/diag-kb-v2.js    # 切块 / 体积 / 结构假设
node scripts/kb-selftest.js   # 22 题自测，任一路由目标解析为 0 块即失败退出
```

**改检索策略必须做 A/B 回归**（用 20+ 题跑开关对比）——曾加"同章最多 2 块"配额，凭直觉以为更优，实测 2 例变好、5 例变差，已撤回。

改动 AI 链路（`js/ai-chat.js` 渲染、`shared/kb-retrieval.js` 裁剪、`functions/api/chat.js`）后重跑：

```bash
node scripts/test-ai-hardening.js   # 35 项：XSS 拦截 / 裁剪等价性与复杂度 / 请求上限 / 识图历史与文本预算 / 重试策略 / 两后端常量一致
```

## 本地开发

```bash
npm install

# 主方式：Cloudflare Pages 本地开发（含 Functions，读取 .dev.vars）
npm run dev              # → http://localhost:8788

# 备用 API 通道（Worker）
npm run cf:dev           # → wrangler dev

# QRcode 下载页本地取数代理（另开一个终端）
npm run proxy            # → http://localhost:3003/proxy?url=

# 纯静态预览（不含 Functions）
npm run dev:static
```

AI 链路本地自测需要 `.dev.vars`：复制 `.dev.vars.example` 为 `.dev.vars` 并填入真实密钥（`.dev.vars` 已被 gitignore，不会入库；模板文件本身入库）。

## 环境变量

| 变量 | 位置 | 说明 |
|------|------|------|
| `SILICONFLOW_API_KEY` | Pages 项目 secret / `.dev.vars` | SiliconFlow 密钥，AI 助手必需 |
| `IMAGE_MODEL` | 可选 | 识图模型，默认 `Qwen/Qwen3.5-4B` |
| `OCR_MODEL` | 可选 | OCR 模型，默认 `deepseek-ai/DeepSeek-OCR` |
| `KB_MODEL` | 可选 | 命中知识库时的模型，默认 `Qwen/Qwen3.5-4B` |
| `GENERAL_MODEL` | 可选 | 未命中知识库时的模型，默认 `Qwen/Qwen3-8B` |
| `DEFAULT_MODEL` | 可选 | 兜底模型，默认 `Qwen/Qwen3-8B` |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | 前端 `js/login.js` / `js/JKscript.js` 硬编码 | anon key 设计上即为公开密钥 |

生产配置：

```bash
npx wrangler pages secret put SILICONFLOW_API_KEY --project-name=health-management
```

## 部署

```bash
# Cloudflare Pages（主，含 Functions）
npm run deploy:pages     # npx wrangler pages deploy . --project-name=health-management --branch=main

# Cloudflare Worker（备用 API）
npm run deploy:worker    # npx wrangler deploy

# 同时部署
npm run deploy:all
```

> `functions/`、`shared/`、`Markdown/kb.md`、`js/vendor/`、`wrangler.jsonc` 等文件必须提交到 Git，否则控制台触发重新部署会丢失 Functions（表现为 `/api/chat` 返回 405）。

## 缓存策略（`_headers`）

| 路径 | 策略 |
|------|------|
| `/*.html` | 不缓存，始终回源校验 |
| `/js/*` | 不缓存，始终回源校验（无文件指纹，改后立即生效） |
| `/css/*` | 不缓存，始终回源校验（同 JS，改后立即生效） |
| `/config/*` | 不缓存（模型配置常改，需即时生效） |
| `/images/*` | 长缓存 1 年（更新同名图片请改名或加 `?v=`） |

> ⚠️ 站点为无构建静态站、无文件指纹。`/*.html`、`/js/*`、`/css/*` 一律不缓存，**改这三类文件都无需维护 `?v=` 版本号**，推送后即对老用户生效。
>
> 仅 `/images/*` 例外（长缓存 1 年 immutable）：更新同名图片必须改用新文件名或加 `?v=`。

## 首页热熔字标

`js/thermal-wordmark.js` 为首页 Hero 的逐像素热熔动画：词表从 canvas 的 `data-words="A|B"` 读取，每 3000ms 换词，热力色带 13 锚点 + Catmull-Rom 时钟 + 160×256 LUT + 20 级各向异性模糊。

调参时可用冻结钩子：`?thermalT=3000` 会把动画时钟定格到 3000ms 并渲染一帧后停止（便于逐帧比对效果）。`prefers-reduced-motion` 下直接绘制最后一个词的 settled 帧。
