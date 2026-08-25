# 健康科技官网

AI 驱动的睡眠健康分析平台官方网站。医疗级传感器精准监测 ECG、HRV、血氧、呼吸率，AI 智能分析生成专属健康报告。

## 技术栈

- **前端**: HTML5 + CSS3 + 原生 ES6 JavaScript（无框架、无构建）
- **图标**: Font Awesome（cdnjs CDN）+ Lucide（已本地化至 `js/vendor/`）
- **图表**: ECharts（多 CDN 容错加载器 `js/echarts-loader.js`）
- **AI**: SiliconFlow 大模型（`Qwen/Qwen3.5-4B` 对话/识图 + `deepseek-ai/DeepSeek-OCR` 文字提取），经 **Pages Functions 同域代理**调用
- **后端认证**: Supabase（浏览器 CDN 直连 + anon key）
- **部署**: Cloudflare Pages + Pages Functions（主）、Netlify（备用）、Cloudflare Worker（备用 API 通道）

## 项目结构

```
├── index.html                 # 官网首页
├── html/
│   ├── login.html             # 登录注册页面
│   ├── health-management.html # 健康管理中心
│   └── QRcode.html            # 产品下载二维码页
├── css/
│   ├── index.css              # 首页样式
│   ├── login.css              # 登录页样式
│   ├── JKstyle.css            # 健康管理中心样式
│   └── ai-chat.css            # AI 聊天样式（弹窗布局 + 灯箱 + 思考区）
├── js/
│   ├── index.js               # 首页交互
│   ├── login.js               # 登录注册逻辑
│   ├── JKscript.js            # 健康管理逻辑
│   ├── ai-chat.js             # AI 助手（流式/识图/OCR/思考模式/图片灯箱）
│   ├── echarts-loader.js      # ECharts 多 CDN 加载器
│   ├── mobile-nav.js          # 移动端导航
│   ├── performance-optimizer.js # Supabase 性能优化
│   └── vendor/lucide.min.js   # 本地化 Lucide 图标库（v1.32.0）
├── partialshtml/              # 健康管理子页面模板
├── config/                    # AI 与性能配置
│   ├── ai-chat-config.js      # AI 助手配置（模型/思考模式/意图策略）
│   └── performance-config.js  # Supabase 性能配置
├── functions/api/             # Cloudflare Pages Functions（同域代理）
│   ├── chat.js                # POST /api/chat → SiliconFlow（流式/识图/OCR）
│   └── proxy.js               # GET /api/proxy → management.lifetide.cn（下载页数据）
├── netlify/                   # Netlify 备用形态（Functions）
├── workers/                   # Cloudflare Worker 备用 API 通道
├── images/                    # 图片资源
├── Markdown/                  # 知识库与部署文档
├── scripts/                   # 本地验证脚本（零依赖，node 直跑）
├── shared/                    # 三通道共用的检索模块（kb-retrieval.js）
├── _headers                   # Pages 缓存与安全响应头
├── wrangler.jsonc             # Cloudflare Worker 配置
└── netlify.toml               # Netlify 部署配置（备用）
```

## 功能模块

- **官网首页**: 产品介绍、功能展示、央视报道、App 下载
- **用户认证**: 手机号注册登录，Supabase 认证，密码强度检测
- **健康管理中心**: 数据统计、客户档案、健康趋势分析、房间报告
- **AI 助手（豆眼儿）**:
  - 流式输出（打字机效果，50ms 渲染节流）
  - 多模态识图（Qwen3.5-4B 免费，粘贴/上传图片自动切换）
  - OCR 文字提取（DeepSeek-OCR）
  - 思考模式（像 DeepSeek 网页一样先显示思考内容再输出回答）
  - Markdown 渲染（标题/列表/代码块/加粗等）
  - 图片灯箱（点击消息内图片放大查看）
  - 意图分类智能策略（temperature/max_tokens 按问题类型调整）

## 本地开发

```bash
# 安装依赖
npm install

# 方式一：Netlify 本地开发（含 Functions，兼容备用形态）
npm run dev            # 访问 http://localhost:8888

# 方式二：本地起 Worker（AI 接口调试，读取 .dev.vars 中的密钥）
npm run cf:dev
```

## 环境变量

| 变量 | 位置 | 说明 |
|------|------|------|
| `SILICONFLOW_API_KEY` | **Pages 项目 secret**（生产）/ `.dev.vars`（本地） | SiliconFlow AI 密钥，AI 助手必需 |
| `SUPABASE_URL` | 前端 `js/login.js` / `js/JKscript.js` 硬编码 | Supabase 项目地址（公开） |
| `SUPABASE_KEY` | 同上（anon key 公开） | 浏览器端认证密钥 |

生产配置：

```bash
npx wrangler pages secret put SILICONFLOW_API_KEY --project-name=health-management
```

本地配置：复制 `.dev.vars.example` 为 `.dev.vars` 并填写（已被 .gitignore 忽略）。

## 部署

主形态为 **Cloudflare Pages**（静态文件 + Functions），另有 Netlify 与 Worker 备用。

```bash
# Cloudflare Pages（主，含 Functions）
npm run deploy:pages        # 等价 npx wrangler pages deploy . --project-name=health-management --branch=main

# Cloudflare Worker（备用 API）
npm run deploy:worker       # 等价 npx wrangler deploy

# 同时部署
npm run deploy:all
```

> 注意：`functions/`、`js/vendor/`、`wrangler.jsonc` 等关键文件必须提交到 Git，否则控制台触发重新部署会丢失 Functions（导致 /api/chat 返回 405）。详细部署说明见 `Markdown/cloudflare-deploy.md`。
