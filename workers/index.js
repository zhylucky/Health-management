// Cloudflare Worker: AI Chat + CORS Proxy
// v2: 支持流式输出(SSE)、免费多模态识图(Qwen3.5-4B)、OCR 提取(DeepSeek-OCR)、参数透传
//
// ⚠️⚠️ 本 Worker 从未部署（wrangler deployments list --name jkkeji-api 报
//        "This Worker does not exist on your account"），当前是**未生效代码**。
//        线上 AI 走的是 Pages Functions 同域通道（functions/api/chat.js，主通道）。
//
// ⚠️ 维护须知：本文件与 functions/api/chat.js 是**近乎逐行的重复实现**（历史上已发生漂移：
//    同为 messages 无效，此处曾返回 500 而 Pages 返回 400）。改动 chat 链路时**两处都要改**，
//    否则一旦启用备用通道就会行为不一致。若确定不需要备用通道，建议直接删除 workers/ 与
//    wrangler.jsonc 中的 Worker 配置，消除这份重复。

const ALLOWED_ORIGINS = [
  'https://health.bbroot.com',
  'https://jkkeji.pages.dev',
  'https://jkkeji-api.health-management.workers.dev',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];

function buildCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const headers = {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    // 允许 JS 读取 X-AI-Model（前端续写需回传实际模型）
    'Access-Control-Expose-Headers': 'X-AI-Model',
    'Vary': 'Origin'
  };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

// ═══ 知识库（内嵌，避免 Workers 无法读取文件系统） ═══
import KNOWLEDGE_BASE from '../Markdown/kb.md';
import { buildKnowledgeInjection, KB_CONFIG_DEFAULTS, GENERAL_SYSTEM_PROMPT, shouldSkipRetrieval, trimMessagesToBudget } from '../shared/kb-retrieval.js';

// ═══ 请求上限防护（与 functions/api/chat.js 保持一致，改动需两处同步）═══
const MAX_MESSAGES = 60;

// ═══ 上游超时、模型故障转移与熔断（与 functions/api/chat.js 同逻辑，改动需两处同步）════
// 背景（2026-09-15 实测，每格 n=4）：Qwen/Qwen3.5-4B 在 SiliconFlow 上**间歇性**零字节挂起
// ——请求发出后既不返回内容也不返回 4xx/5xx，连接永远悬着。实测 4B 只有 1/8 成功（失败全部
// 是 45s 零字节），同一时间 Qwen/Qwen3-8B 8/8 全通；挂起与 prompt 体积无关（短 prompt 同样挂）。
// 但 4B 一旦活着就快得多：首内容 418ms、208 字 1.6s（≈130 字/秒）；8B 同长度答案要
// 3.9~26.4s。所以 4B 仍值得当快通道主模型，靠三条兜住它的不可靠：
//  1) 逐候选首字节超时（拿到响应头即解除，不影响后续 body）；
//  2) 故障转移（换**另一个**模型重试，重试安全；备用必须与主模型不同值，否则形同虚设）；
//  3) 熔断（连续失败 2 次即跳过一段时间，别让每个请求都白等一次探针超时）。
const UPSTREAM_URL = 'https://api.siliconflow.cn/v1/chat/completions';
// 主模型探针超时：实测健康首字节 418~1040ms，3.5s 留足余量；挂起时只损失这么久。
const PRIMARY_FIRST_BYTE_MS = 3500;
// 备用模型：宁可多等，也不要两个候选都白等。
const FALLBACK_FIRST_BYTE_MS = 15000;
// 识图：要算上图片上传时间，给比文本探针更宽的值。
const IMAGE_FIRST_BYTE_MS = 10000;
// 非流式：上游要等**完整生成结束**才发响应头，故"首字节"实际等于"生成完成"，放宽到 60s。
// **生产请用流式**：config.stream 默认 true。
const NON_STREAM_TIMEOUT_MS = 60000;
// 熔断参数
const MODEL_FAIL_THRESHOLD = 2;
const MODEL_COOLDOWN_MS = 60000;
const FALLBACK_MODEL_DEFAULT = 'Qwen/Qwen3-8B';
// 识图默认模型：原来的 Qwen/Qwen3.5-4B 实测 0/4 零字节挂起，而且它**不是 VLM**。
// 实测 Qwen/Qwen3-VL-8B-Instruct：200、首内容 728ms、正确答出图片颜色。
const IMAGE_MODEL_DEFAULT = 'Qwen/Qwen3-VL-8B-Instruct';

// ═══ 模型专属参数：必须逐候选模型算，不能按主模型算一次就复用 ═══
// 实测：Qwen/Qwen3-VL-* 收到 enable_thinking 直接 400；文本模型则需要关掉思考，否则思考
// 耗尽 max_tokens 导致 content 为空。故只给 Qwen 文本模型加这两个字段。
const NON_TEXT_QWEN_RE = /-VL-|omni|OCR/i;
function applyModelFlags(requestBody, model) {
  const body = { ...requestBody, model };
  delete body.enable_search;
  delete body.enable_thinking;
  if (/^Qwen\//i.test(model) && !NON_TEXT_QWEN_RE.test(model)) {
    body.enable_search = false;
    body.enable_thinking = false;
  }
  return body;
}

// ═══ 模型熔断：key = 模型名。连续失败达到阈值即熔断，成功一次立即清零。═══
const modelHealth = new Map();
function isModelCoolingDown(model) {
  const h = modelHealth.get(model);
  return !!h && h.downUntil > Date.now();
}
function noteModelFailure(model) {
  const h = modelHealth.get(model) || { fails: 0, downUntil: 0 };
  h.fails += 1;
  if (h.fails >= MODEL_FAIL_THRESHOLD) {
    h.downUntil = Date.now() + MODEL_COOLDOWN_MS;
    h.fails = 0;
    console.log(`[Upstream] ${model} 连续失败达 ${MODEL_FAIL_THRESHOLD} 次，熔断 ${MODEL_COOLDOWN_MS}ms`);
  }
  modelHealth.set(model, h);
}
function noteModelSuccess(model) {
  modelHealth.delete(model);
}
export function __resetUpstreamHealth() {
  modelHealth.clear();
}

/**
 * 组装候选模型列表。主备相同时只有一个候选，此时**不给它探针超时**——没有更快的替代品，
 * 等久一点才是对的。
 */
function buildCandidates(primaryModel, fallbackModel, primaryMs = PRIMARY_FIRST_BYTE_MS, fallbackMs = FALLBACK_FIRST_BYTE_MS) {
  if (!fallbackModel || fallbackModel === primaryModel) {
    return [{ model: primaryModel, timeoutMs: fallbackMs }];
  }
  return [
    { model: primaryModel, timeoutMs: primaryMs },
    { model: fallbackModel, timeoutMs: fallbackMs }
  ];
}

async function callUpstream(apiKey, requestBody, candidates) {
  const list = [];
  for (const c of candidates || []) {
    if (c && c.model && !list.some(x => x.model === c.model)) list.push(c);
  }
  if (list.length === 0) return { resp: null, model: null, error: new Error('没有可用的候选模型') };

  let lastError = null;
  for (let i = 0; i < list.length; i++) {
    const { model, timeoutMs } = list[i];
    // 熔断中的模型直接跳过；但**最后一个候选必须试**
    if (i < list.length - 1 && isModelCoolingDown(model)) {
      console.log(`[Upstream] ${model} 熔断中，跳过 → ${list[i + 1].model}`);
      continue;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(UPSTREAM_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(applyModelFlags(requestBody, model)),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (resp.ok) {
        noteModelSuccess(model);
        return { resp, model };
      }
      // 4xx：请求/凭证问题，换模型一样失败，如实透传，不计健康度
      if (resp.status < 500) return { resp, model };
      lastError = new Error(`上游模型 ${model} 返回 ${resp.status}`);
      noteModelFailure(model);
      await resp.text().catch(() => '');
    } catch (err) {
      clearTimeout(timer);
      noteModelFailure(model);
      lastError = (err?.name === 'TimeoutError' || err?.name === 'AbortError')
        ? new Error(`上游模型 ${model} ${timeoutMs}ms 内未返回任何响应`)
        : err;
    }
    if (i < list.length - 1) {
      console.log(`[Upstream] ${model} 失败：${lastError?.message} → 切换 ${list[i + 1].model}`);
    }
  }
  return { resp: null, model: null, error: lastError };
}
const MAX_IMAGE_CHARS = 8 * 1024 * 1024;
// 解析前体积上限：request.json() 会完整解析整个 body 才轮到图片 413 检查，故先看
// content-length 把超大请求挡在解析之外（chunked 下该头缺失，退化为解析后校验）。
const MAX_BODY_BYTES = MAX_IMAGE_CHARS + 64 * 1024;

// ═══ 图片消息处理：识图理解 / OCR 提取 ═══
async function handleImage(request, env, body) {
  const { image, imageMode, messages } = body;
  const mode = imageMode === 'ocr' ? 'ocr' : 'understand';
  // 识图也走流式：复杂图全量生成可达数十秒，透传 SSE 让用户逐字看到结果
  // OCR 输出通常较短、且不确认上游模型支持流式，保持非流式更稳妥
  const isStream = body.stream === true && mode !== 'ocr';

  const apiKey = env.SILICONFLOW_API_KEY;
  // 免费多模态模型做"看图问答"；DeepSeek-OCR 做"文字提取"
  const imageModel = env.IMAGE_MODEL || IMAGE_MODEL_DEFAULT;
  const ocrModel = env.OCR_MODEL || 'deepseek-ai/DeepSeek-OCR';

  // 文本侧上限（与 functions/api/chat.js 同逻辑）：图片本身有 MAX_IMAGE_CHARS，
  // 但 prompt 与历史此前无约束 —— 识图路径没有 trimMessagesToBudget 兜底
  const IMAGE_PROMPT_MAX_CHARS = 2000;
  const IMAGE_HISTORY_MAX_CHARS = 6000;

  const lastText = (messages && messages.length > 0)
    ? messages[messages.length - 1].content
    : '';
  const trimmedPrompt = typeof lastText === 'string' ? lastText.slice(0, IMAGE_PROMPT_MAX_CHARS) : '';
  const prompt = mode === 'ocr'
    ? (trimmedPrompt || 'OCR this image. 提取图片中的全部文字，用 Markdown 输出。')
    : (trimmedPrompt || '请描述这张图片的内容。');

  // 识图（understand）带上最近的文本历史（与 functions/api/chat.js 同逻辑）；
  // OCR 不带历史——纯提取模型塞对话历史会干扰输出。条数与总字符数双上限。
  const IMAGE_HISTORY_LIMIT = 6;
  const history = [];
  if (mode !== 'ocr' && Array.isArray(messages)) {
    const recent = messages.slice(0, -1)
      .filter(m => m && (m.role === 'user' || m.role === 'assistant')
        && typeof m.content === 'string' && m.content.trim())
      .slice(-IMAGE_HISTORY_LIMIT);
    // 从最近一条往前累计，超出预算即停（保持历史连续，不跳着留）
    let budget = IMAGE_HISTORY_MAX_CHARS;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].content.length > budget) break;
      budget -= recent[i].content.length;
      history.unshift({ role: recent[i].role, content: recent[i].content });
    }
  }

  const imageRequestBody = {
    model: mode === 'ocr' ? ocrModel : imageModel,
    messages: [
      ...history,
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: image } },
          { type: 'text', text: prompt }
        ]
      }
    ],
    stream: isStream,
    // understand 2000：复杂图描述/长报告可能超 1000 token，太低会触发 length 截断（输出中断）；
    // OCR 1200：文字提取输出较短
    max_tokens: mode === 'ocr' ? 1200 : 2000,
    temperature: mode === 'ocr' ? 0.1 : 0.4,
    top_p: 0.8
  };

  // 模型专属入参由 callUpstream → applyModelFlags 按实际模型逐个计算：
  // 文本 Qwen 关思考；VL 模型不能带 enable_thinking（实测 400）。

  // 识图候选：主模型 + **默认兜底一个已知可用的 VLM**。原因：环境变量 IMAGE_MODEL 一旦被显式
  // 设成坏模型（例如老的 Qwen/Qwen3.5-4B），代码里的默认值就被覆盖、修了也不生效；加了兜底后
  // 无需改任何环境变量也能自愈（主模型挂起 10s → 自动换 VL 模型；连续失败后熔断直接跳过它）。
  // OCR 不加兜底：通用 VLM 描述图片 ≠ 提取文字，格式语义都不对。
  const imageCandidates = mode === 'ocr'
    ? [{ model: imageRequestBody.model, timeoutMs: NON_STREAM_TIMEOUT_MS }]
    : buildCandidates(
        imageRequestBody.model,
        env.IMAGE_FALLBACK_MODEL || IMAGE_MODEL_DEFAULT,
        IMAGE_FIRST_BYTE_MS,
        IMAGE_FIRST_BYTE_MS
      );

  const { resp, error } = await callUpstream(apiKey, imageRequestBody, imageCandidates);
  // 上游挂起/5xx：以前这里会一直悬着，前端只能干等到首字节上限
  if (!resp) throw new Error(`识图失败：${error?.message || '上游无响应'}`);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`识图请求失败：${resp.status} - ${errText.slice(0, 200)}`);
  }

  // 流式：SSE 直接透传给前端（与文本对话同路径）
  if (isStream) {
    if (!resp.body) throw new Error('识图流式响应缺少数据流，请重试');
    return new Response(resp.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        ...buildCorsHeaders(request)
      }
    });
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  return {
    choices: [{ message: { content: content || '图片识别返回为空，请重试（可能是 SiliconFlow 免费档偶发问题，或图片过大/格式不支持）' } }],
    type: mode === 'ocr' ? 'ocr_response' : 'image_response'
  };
}

// ═══ AI Chat Handler（支持流式 SSE） ═══
async function handleChat(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: buildCorsHeaders(request) });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...buildCorsHeaders(request) }
    });
  }

  const corsHeaders = buildCorsHeaders(request);

  try {
    // ── 解析前体积拦截：必须早于 request.json()（与 Pages 通道同逻辑）──
    const contentLength = Number(request.headers?.get?.('content-length')) || 0;
    if (contentLength > MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ error: `请求体过大（上限约 ${Math.round(MAX_BODY_BYTES / 1048576)}MB）` }), {
        status: 413,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const body = await request.json();
    const { messages, model, image, imageMode, injectKnowledge, stream, temperature, max_tokens } = body;

    const apiKey = env.SILICONFLOW_API_KEY;
    if (!apiKey) {
      throw new Error('API密钥未配置');
    }

    // ── 条数上限：必须在图片分支之前，否则识图请求会绕过它（与 Pages 同逻辑）──
    if (Array.isArray(messages) && messages.length > MAX_MESSAGES) {
      return new Response(JSON.stringify({ error: `messages 条数超出上限（最多 ${MAX_MESSAGES} 条）` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // ── 图片消息：识图理解 / OCR ──
    if (image) {
      if (typeof image !== 'string' || image.length > MAX_IMAGE_CHARS) {
        return new Response(JSON.stringify({ error: '图片过大或格式无效（上限约 6MB）' }), {
          status: 413,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      const result = await handleImage(request, env, body);
      // 流式时返回的是 SSE Response 直接透传；否则是普通对象转 JSON
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // ── 文本对话 ──
    // 参数错误直接返回 400：此前用 throw，会被外层 catch 统一变成 500，
    // 与 Pages Functions 的 400 行为不一致（历史漂移点，已对齐）。
    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: 'messages 参数无效或缺失' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // 知识库检索注入（RAG：按问题检索相关片段，不再整库全量注入）
    // 双通道（prompt + 模型）：命中知识库 → 严格提示词 + KB_MODEL（默认4B，快）；
    //          未命中 → 通用提示词 + GENERAL_MODEL（默认8B，知识面更全）
    let kbModelOverride = null;
    if (injectKnowledge === true && messages.length > 0) {
      const { injection, hits } = buildKnowledgeInjection(messages, KNOWLEDGE_BASE, KB_CONFIG_DEFAULTS);
      const systemMsgIndex = messages.findIndex(m => m.role === 'system');
      // 寒暄/闲聊（你好/谢谢等）也走快通道 4B
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      const isChitchat = lastUserMsg ? shouldSkipRetrieval(String(lastUserMsg.content || '')) : false;

      if (hits.length > 0 && injection) {
        // 快通道主模型 = 4B：它健康时 208 字只要 1.6s（8B 同样内容要 3.9~26.4s），所以命中
        // 知识库仍优先用它；它间歇性零字节挂起（1/8），靠探针超时 + 换 8B + 熔断兜住。
        kbModelOverride = env.KB_MODEL || 'Qwen/Qwen3.5-4B';
        if (systemMsgIndex !== -1) {
          messages[systemMsgIndex].content += injection;
        } else {
          messages.unshift({
            role: 'system',
            content: `你是"个人健康精英Pro+"的AI健康助手。${injection}`
          });
        }
        console.log('[KB-RAG] hits:', hits.map(h => `${h.title}(${h.score.toFixed(2)})`).join(' | '));
      } else {
        // 未命中知识库 → 通用模式。寒暄走快通道 4B；真正的通用问答才用 GENERAL_MODEL(8B)。
        kbModelOverride = isChitchat
          ? (env.KB_MODEL || 'Qwen/Qwen3.5-4B')
          : (env.GENERAL_MODEL || 'Qwen/Qwen3-8B');
        if (systemMsgIndex !== -1) {
          messages[systemMsgIndex].content = GENERAL_SYSTEM_PROMPT;
        } else {
          messages.unshift({ role: 'system', content: GENERAL_SYSTEM_PROMPT });
        }
        console.log('[KB-RAG] no hit, switch to general prompt');
      }
    }

    // 最终使用的模型（便于 Cloudflare 日志确认双通道是否生效）
    const finalModel = kbModelOverride || model || env.DEFAULT_MODEL || 'Qwen/Qwen3-8B';
    const fallbackModel = env.FALLBACK_MODEL || FALLBACK_MODEL_DEFAULT;
    console.log(`[KB-RAG] final model=${finalModel} (override=${kbModelOverride || 'none'}, frontend=${model || 'none'}, fallback=${fallbackModel})`);

    // ═══ 超窗降级兜底：估算超出预算时从最旧历史丢弃（保留 system 与最新提问），避免上游 400 ═══
    const PROMPT_TOKEN_BUDGET = 26000; // 32K 窗口 − 输出 max_tokens 上限 − 安全余量
    const trimmedMessages = trimMessagesToBudget(messages, PROMPT_TOKEN_BUDGET);
    if (trimmedMessages.length < messages.length) {
      console.log(`[Context] 超窗降级：${messages.length} → ${trimmedMessages.length} 条`);
    }

    const isStream = stream === true;
    const requestBody = {
      model: finalModel,
      messages: trimmedMessages,
      stream: isStream,
      // 默认 800（原 1500）：降低生成总量，显著缩短非流式等待时间
      max_tokens: max_tokens || 800,
      temperature: (typeof temperature === 'number') ? temperature : 0.5,
      top_p: 0.8,
      presence_penalty: 0.2,
      frequency_penalty: 0.3
    };

    // 模型专属入参（enable_search / enable_thinking）在 callUpstream 内**按候选模型**逐个
    // 计算——VL 模型收到 enable_thinking 会直接 400（实测）。

    // ── 流式模式：透传 SSE ──
    // 故障转移只发生在「拿到响应头之前」，此时还没向客户端吐任何字节，重试安全；
    // 一旦开始吐流就不再重试（避免打断已开始的流）。
    if (isStream) {
      const { resp, model: usedModel, error } = await callUpstream(
        apiKey, requestBody, buildCandidates(finalModel, fallbackModel)
      );
      if (!resp) {
        return new Response(JSON.stringify({ error: 'AI 服务暂时不可用，请稍后重试', details: error?.message }), {
          status: 504,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        return new Response(JSON.stringify({ error: `SiliconFlow API 请求失败：${resp.status} - ${errText.slice(0, 200)}` }), {
          status: resp.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      return new Response(resp.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
          // 回传**实际成功**的模型（故障转移后可能与 finalModel 不同），供前端
          // 「自动续写」请求回传同一模型，避免同一条回答首尾模型不一致
          'X-AI-Model': usedModel,
          ...corsHeaders
        }
      });
    }

    // ── 非流式模式（与 functions/api/chat.js 同逻辑）──
    // 首字节超时 + 换模型重试由 callUpstream 统一处理；4xx（401 密钥/400 参数/429 限流）
    // 不重试，换模型一样失败，且 429 无退避重试会加剧限流。
    // 读 body 不再设超时：首字节计时在拿到响应头时已解除，长回答可完整生成不被截断。
    const { resp, model: usedModel, error } = await callUpstream(
      apiKey, requestBody, buildCandidates(finalModel, fallbackModel, NON_STREAM_TIMEOUT_MS, NON_STREAM_TIMEOUT_MS)
    );
    if (!resp) {
      return new Response(JSON.stringify({ error: 'AI 服务暂时不可用，请稍后重试', details: error?.message }), {
        status: 504,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    let responseText;
    try {
      responseText = await resp.text();
    } catch (netError) {
      return new Response(JSON.stringify({ error: '读取 AI 服务响应中断，请稍后重试', details: netError.message }), {
        status: 504,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    if (resp.ok) {
      try {
        return new Response(JSON.stringify(JSON.parse(responseText)), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-AI-Model': usedModel, ...corsHeaders }
        });
      } catch (parseError) {
        return new Response(JSON.stringify({ error: 'AI 服务返回了非预期格式', details: parseError.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
    return new Response(JSON.stringify({
      error: `SiliconFlow API 请求失败：${resp.status} - ${responseText.slice(0, 200)}`
    }), {
      status: resp.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

// ═══ CORS Proxy Handler ═══
async function handleProxy(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: buildCorsHeaders(request) });
  }

  const corsHeaders = buildCorsHeaders(request);
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  try {
    const decodedUrl = decodeURIComponent(targetUrl);
    const urlObj = new URL(decodedUrl);
    const allowedDomains = ['management.lifetide.cn'];

    if (!allowedDomains.includes(urlObj.hostname)) {
      return new Response(JSON.stringify({ error: 'Domain not allowed', domain: urlObj.hostname }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // 目标API证书过期，用HTTP
    const httpUrl = decodedUrl.replace('https://', 'http://');
    const resp = await fetch(httpUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    });

    const data = await resp.text();
    return new Response(data, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-cache',
        ...corsHeaders
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Proxy request failed', message: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

// ═══ Router ═══
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/chat' || path.endsWith('/chat')) {
      return handleChat(request, env);
    }
    if (path === '/proxy' || path.endsWith('/proxy')) {
      return handleProxy(request, env);
    }

    return new Response(JSON.stringify({ message: 'jkkeji-api worker is running' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
