# 可替换模型的位置 + 免费稳定平台清单（2026-09-15 实测）

> 说明：本次 `web_search`（modsearch/firecrawl 免密通道）被 403 拒绝，所以"平台是否可用"全部改用
> **直接打 HTTP 端点**实测（`/v1/models`）。我只能验证「连通性 + 接口里暴露的价格」，
> 无法用一次探测证明长期稳定性与限速。

---

## 一、DSH 里能换模型的地方（共 4 处配置 + 1 个入口）

配置文件：`C:\Users\29575\.dsh\settings.yaml`（1582 行）

| 位置 | 行号 | 作用 |
|---|---|---|
| `agent-default-model` | L6–8 | 全局默认模型。当前 = `vision-toolkit-tokenharbor` / `deepseek-v4.1-flash:free` |
| `llm-pi-ai.providers` | L9–83 | **自定义 OpenAI 兼容 provider 的主入口**，已有 6 家：`b-ai`、`free-router`、`deepseek-v4-flash-free`(orcarouter)、`tokenharbor`、`tokenrouter`、`cavoti` |
| `vision-toolkit.provider` | L1555–1573 | 视觉/网关链：`https://vision.anionex.me/v1` + `credential: ANIONEX_FREE_VISION` + `gemini-3.7-flash` |
| `llm-deepseek.models` | L1579–1582 | 官方 deepseek 路由，只挂了 `deepseek-flash` |
| Web UI 的 **Models 页** | `http://127.0.0.1:43120` | 改默认模型、以及**写入 API Key**（DSH 源码里明确：`apiKeyEnv` 引用的凭据由 Models 页写进凭据服务，见 `dsh-llm-pi-ai/lib/index.js`） |

模型插件市场上还有个值得装的：`V1ki/dsh-plugin-subscriptions` —— 用 ChatGPT(Codex)/Claude/Grok
订阅通过 OAuth 登录直接当 DSH provider，**不需要 API key**（前提是你有这些订阅）。

### ⚠️ 现状里两个"已经坏了/名不副实"的点

1. **`free-router` 已死**：`baseURL: http://127.0.0.1:8787/v1` 连不上（`Get-NetTCPConnection -LocalPort 8787` 无监听）。
   → 建议删掉，或者把你那个本地路由重新跑起来。
2. **你实际在用的不是 tokenharbor 本身**：`tokenharbor.ai` 从本机是 **403 region_blocked（明确点名大陆）**。
   现在这个会话跑在 `vision-toolkit-b-ai/qwen3.8-flash` 上、之前跑在 `vision-toolkit-tokenharbor/...:free` 上，
   走的都是 `vision.anionex.me` 这个**免费网关**，所以 origin 被封也不影响 —— 这条反而是目前最稳的免费通道。

---

## 二、实测连通性（出口 IP：114.248.220.209，中国大陆）

| 平台 | 端点 | 结果 | 判断 |
|---|---|---|---|
| **ModelScope 魔搭** | `api-inference.modelscope.cn/v1/models` | **200**，免 key 就能列模型 | ✅ 首选，大陆原生 |
| **OpenRouter** | `openrouter.ai/api/v1/models` | **200** | ✅ 可用，8 个 `:free` |
| **OrcaRouter** | `api.orcarouter.ai/v1/models` | **200** | ✅ 可用，含免费项 |
| **anionex 视觉网关** | `vision.anionex.me/v1/models` | 401 + 提示：`Use api_key="https://agent-vision.anionex.me"` | ✅ 公开端点，已在用 |
| cavoti | `cavoti.com/v1/models` | 401 `API_KEY_REQUIRED` | ✅ 通，需 key |
| tokenrouter | `api.tokenrouter.com/v1/models` | 401 `Token not provided` | ✅ 通，需 key |
| SiliconFlow 硅基流动 | `api.siliconflow.cn/v1/models` | 401 `Token is invalid` | ✅ 通，需 key |
| 智谱 BigModel | `open.bigmodel.cn/api/paas/v4/models` | 401 缺 Authorization | ✅ 通，需 key |
| 阶跃 StepFun | `api.stepfun.com/v1/models` | 401 | ✅ 通，需 key |
| 阿里 DashScope | `dashscope.aliyuncs.com/compatible-mode/v1/models` | 401 | ✅ 通，需 key |
| 月之暗面 Moonshot | `api.moonshot.cn/v1/models` | 401 | ✅ 通，需 key |
| 火山方舟 Ark | `ark.cn-beijing.volces.com/api/v3/models` | 401 AuthenticationError | ✅ 通，需 key |
| **tokenharbor** | `tokenharbor.ai/v1/models` | **403 region_blocked**（点名大陆/港澳） | ❌ 换掉 |
| **Groq** | `api.groq.com/openai/v1/models` | **403 Forbidden** | ❌ 不可用 |
| **Cerebras** | `api.cerebras.ai/v1/models` | **403 Cloudflare Error 1009 国家封禁 (CN)** | ❌ 不可用 |
| **api.b.ai** | — | DNS 解析到**非公网 IP**（污染） | ⚠️ 直连不可用，只靠 anionex 网关兜住 |

---

## 三、真正免费、可以直接加的模型

### A. ModelScope（`https://api-inference.modelscope.cn/v1`，200 实测列表里挑的）
适合当主力的：
`deepseek-ai/DeepSeek-V4.1-Flash`、`deepseek-ai/DeepSeek-V4-Flash-0731`、`Qwen/Qwen3.8-Flash-Next`、
`ZhipuAI/GLM-4.7-Flash`、`stepfun-ai/Step-3.7-Flash`、`Tencent-Hunyuan/Hy3`、`MiniMax/MiniMax-M3`、
`Qwen/Qwen3-Coder-30B-A3B-Instruct`、`Qwen/Qwen3.5-397B-A17B`、`nex-agi/Nex-N2.5-Pro`

### B. OpenRouter `:free`（全量 8 个，实测从 pricing=0 提取）
```
nex-agi/nex-n2.5-pro:free          262K ctx · tools · reasoning   ← 这俩是免费里最能打的
nvidia/nemotron-3.5-lightning:free 1M ctx
inclusionai/ling-3.0-flash-vl:free 262K ctx · 图/视频输入
inclusionai/ling-3.0-flash-fin:free
inclusionai/ling-3.0-flash-sante:free
dots-studio/dots-3-note-preview:free
liquid/lfm-2.5-2.6b:free           65K ctx（太小，仅备用）
nex-agi/nex-n2.5-mini:free
```

### C. OrcaRouter（已在你的配置里）
`orcarouter/free`、`orcarouter/fusion-flash`(262K)、`orcarouter/fusion-mini`(1M)、
`deepseek/deepseek-v4-flash-free`（接口里 `pricing.request = 0`）

---

## 四、可直接粘贴的 settings.yaml 片段

贴到 `llm-pi-ai.providers:` 下面（缩进对齐 `b-ai:` 那一级）。
`apiKeyEnv` 引用的凭据请在 **Web UI → Models 页**填，或写进 `C:\Users\29575\.dsh\.credentials.yaml` 的 `refs`。

```yaml
    modelscope:
      displayName: ModelScope 魔搭 (Free quota)
      apiKeyEnv: MODELSCOPE_API_KEY
      api: openai-completions
      baseURL: https://api-inference.modelscope.cn/v1
      models:
        - id: deepseek-ai/DeepSeek-V4.1-Flash
          name: DeepSeek V4.1 Flash (ModelScope)
          contextWindow: 1048576
          maxTokens: 384000
        - id: Qwen/Qwen3.8-Flash-Next
          name: Qwen3.8 Flash Next (ModelScope)
          contextWindow: 262144
        - id: ZhipuAI/GLM-4.7-Flash
          name: GLM-4.7 Flash (ModelScope)
          contextWindow: 262144
        - id: stepfun-ai/Step-3.7-Flash
          name: Step 3.7 Flash (ModelScope)
          contextWindow: 262144
    openrouter-free:
      displayName: OpenRouter (free)
      apiKeyEnv: OPENROUTER_API_KEY
      api: openai-completions
      baseURL: https://openrouter.ai/api/v1
      models:
        - id: nex-agi/nex-n2.5-pro:free
          name: Nex-N2.5-Pro (free)
          contextWindow: 262144
          maxTokens: 235929
        - id: nvidia/nemotron-3.5-lightning:free
          name: Nemotron 3.5 Lightning (free)
          contextWindow: 1000000
        - id: inclusionai/ling-3.0-flash-vl:free
          name: Ling 3.0 Flash VL (free)
          input: [text, image, video]
          contextWindow: 262144
```

顺手清理：把 `free-router`（L30–39）整段删掉，或者重启你那个 8787 服务。

---

## 五、建议的最终排布

1. **主力**：ModelScope `deepseek-ai/DeepSeek-V4.1-Flash`（1M ctx，大陆直连、免 key 列表已验证）
2. **备用**：OrcaRouter `orcarouter/fusion-flash` + OpenRouter `nex-agi/nex-n2.5-pro:free`
3. **视觉兜底**：保持 `vision-toolkit` 的 anionex 免费网关不动 —— 它是现在唯一实测证明"封不掉还能用"的那条
4. **移除**：`tokenharbor`、`groq`、`cerebras`（大陆均 403），`free-router`（本地服务没起）
