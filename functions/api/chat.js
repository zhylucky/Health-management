// ═══════════════════════════════════════════════
// Pages Function: /api/chat 同域 AI 代理
// 作用：前端同域请求 /api/chat → 本函数转发到 SiliconFlow
//      彻底绕开 workers.dev 跨境不稳定的问题（与页面同一网络路径）
// 依赖：Pages 项目环境变量 SILICONFLOW_API_KEY（wrangler pages secret put）
// ═══════════════════════════════════════════════

// 知识库 RAG 检索（共享模块，与 Worker 通道行为一致）
import { buildKnowledgeInjection, KB_CONFIG_DEFAULTS, GENERAL_SYSTEM_PROMPT, shouldSkipRetrieval, trimMessagesToBudget } from '../../shared/kb-retrieval.js';

// 知识库：运行时读取同源静态资源 Markdown/kb.md
// （Pages Functions 打包器不支持 .md 导入，故随站点发布后 fetch 读取）
let KNOWLEDGE_BASE_CACHE = null;

// ═══ 请求上限防护 ═══
// 本端点是同域公开端点（无鉴权/无限流），必须有硬上限兜住单请求成本。
// 前端正常只发 ≤24 条历史（config.maxMessages），这里留 2.5 倍余量；
// 图片上限约 6MB（前端已压到 5MB 内 + 1280px，此处防的是绕过前端的直连请求）。
// 注意：限流/人机校验需在 Cloudflare 侧配置（WAF Rate Limiting 或 Turnstile），
// 代码层只能做这种纵深防护。
const MAX_MESSAGES = 60;
const MAX_IMAGE_CHARS = 8 * 1024 * 1024;

// 解析前的体积上限：request.json() 会把整个 body 完整解析成对象，之后才轮到图片 413 检查——
// 直连攻击者可塞入接近 Cloudflare 请求体上限（100MB）的垃圾 JSON，白烧本实例的 CPU/内存。
// 正常请求最大也就「8M 字符图片 + JSON 信封」，故留 64KB 余量。
// 注意：content-length 在 chunked 传输下会缺失，此时退化为解析后校验，不是绝对防线。
const MAX_BODY_BYTES = MAX_IMAGE_CHARS + 64 * 1024;

// ═══ 上游超时、模型故障转移与熔断 ═══
// 背景（2026-09-15 实测，每格 n=4）：Qwen/Qwen3.5-4B 在 SiliconFlow 上**间歇性**零字节挂起
// ——请求发出后既不返回内容也不返回 4xx/5xx，连接永远悬着。实测 4B 只有 1/8 成功（失败全部
// 是 45s 零字节），同一时间 Qwen/Qwen3-8B 8/8 全通；挂起与 prompt 体积无关（短 prompt 同样挂），
// 也不是思考模式（未出现 reasoning_content）。
// 但 4B 一旦活着就快得多：首内容 418ms、208 字 1.6s（≈130 字/秒）；8B 同长度答案要
// 3.9~26.4s（≈8~50 字/秒）。所以 4B 仍然值得当快通道主模型，靠下面三条兜住它的不可靠：
//  1) 逐候选首字节超时：只约束「发请求 → 拿到响应头」，拿到头立刻 clearTimeout，后续 body
//     不再受约束——否则流式长回答会被拦腰截断。主模型用很短的"探针"超时（它健康时 0.4s
//     就出头），挂起时只损失几秒就换人；备用模型给宽裕值。
//  2) 故障转移：主模型失败（超时/网络错误/5xx）换**另一个模型**重试。此时还没向客户端吐
//     任何字节，重试安全。**备用必须与主模型不同值**，否则候选只剩一个、故障转移形同虚设
//     （2026-09-15 曾经把两者都默认成 8B，等于从未兜底）。
//  3) 熔断：主模型整体不可用时，别让**每个**请求都先白等一次探针超时。连续失败 2 次即熔断
//     一段时间，期间直接跳到备用；到期后放行一次重新探测，成功即恢复快通道。
//     纯内存、按 isolate 生效（冷启动会重新探测一次，可接受）。
const UPSTREAM_URL = 'https://api.siliconflow.cn/v1/chat/completions';
// 主模型探针超时：实测健康首字节 418~1040ms，3.5s 留足余量；挂起时只损失这么久。
const PRIMARY_FIRST_BYTE_MS = 3500;
// 备用模型：宁可多等，也不要两个候选都白等。
const FALLBACK_FIRST_BYTE_MS = 15000;
// 识图：要算上图片上传时间，给比文本探针更宽的值。
const IMAGE_FIRST_BYTE_MS = 10000;
// 非流式：**不能**沿用上面的值。非流式要等模型把内容全部生成完，上游才会发出响应头，
// 所以这里的"首字节"实际等于"生成完成"。实测同一请求流式 20s 完成、非流式 40s 仍未完成
// （原因未查明）。故放宽到 60s 作为兜底。**生产请用流式**：config.stream 默认 true。
const NON_STREAM_TIMEOUT_MS = 60000;
// 熔断参数
const MODEL_FAIL_THRESHOLD = 2;
const MODEL_COOLDOWN_MS = 60000;
// 备用模型：主模型整体不可用时兜底。可用环境变量 FALLBACK_MODEL 覆盖。
const FALLBACK_MODEL_DEFAULT = 'Qwen/Qwen3-8B';
// 识图默认模型：原来的 Qwen/Qwen3.5-4B 实测 0/4 零字节挂起，而且它**不是 VLM**
// （SiliconFlow 对非视觉模型直接回 400 "The model is not a VLM"）。
// 实测 Qwen/Qwen3-VL-8B-Instruct：200、首内容 728ms、正确答出图片颜色。
const IMAGE_MODEL_DEFAULT = 'Qwen/Qwen3-VL-8B-Instruct';

async function loadKnowledgeBase(request) {
  if (KNOWLEDGE_BASE_CACHE) return KNOWLEDGE_BASE_CACHE;
  const url = new URL('/Markdown/kb.md', request.url).toString();
  try {
    // cache:'no-store' 用于绕过边缘缓存。但本地 `wrangler pages dev`（miniflare）
    // **不实现 fetch 的 cache 字段**，会直接抛 "The 'cache' field on 'RequestInitializerDict'
    // is not implemented."，使本地 KB 永远加载失败 → 所有请求都被判为"未命中"、
    // 整段换成 GENERAL_SYSTEM_PROMPT 并用 8B，本地就完全测不了 KB 模式。
    // 故失败后退化为不带该字段再取一次（生产走第一条分支，行为不变）。
    let resp;
    try {
      resp = await fetch(url, { cache: 'no-store' });
    } catch {
      resp = await fetch(url);
    }
    if (resp.ok) {
      KNOWLEDGE_BASE_CACHE = await resp.text();
      return KNOWLEDGE_BASE_CACHE;
    }
  } catch (e) {
    console.warn('[KnowledgeBase] 读取失败：', e.message);
  }
  return '';
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }
  });
}

// ═══ 模型专属参数：必须逐候选模型算，不能按主模型算一次就复用 ═══
// 实测：Qwen/Qwen3-VL-* 收到 enable_thinking 直接 400
//       （"current model does not support parameter `enable_thinking`"）；
//       文本模型则需要关掉思考——平台默认开启思考，思考会耗尽 max_tokens 导致 content 为空，
//       而前端不解析 reasoning_content，表现为"回答空白"。
// 故：只给 Qwen 文本模型加这两个字段；VL / Omni / OCR 以及非 Qwen 模型一律不加。
// 若将来要启用思考，前端必须同步支持渲染 reasoning_content。
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

// ═══ 模型熔断（见文件头第 3 条）═══
// key = 模型名。连续失败达到阈值即熔断，成功一次立即清零。
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
// 测试用：熔断状态是模块级的，会跨用例泄漏，测试需要显式清零
export function __resetUpstreamHealth() {
  modelHealth.clear();
}

/**
 * 组装候选模型列表。
 * 主备相同时（没配 FALLBACK_MODEL，或主模型本身就是备用模型）只有一个候选，此时**不给它
 * 探针超时**——没有更快的替代品，等久一点才是对的；否则每次排队都白白 504。
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

/**
 * 调用 SiliconFlow，带逐候选首字节超时、故障转移与熔断。
 * candidates: [{ model, timeoutMs }]，按顺序尝试（内部按模型名去重）。
 * 成功返回 { resp, model }；全部候选失败返回 { resp: null, model: null, error }。
 *
 * 注意：返回的 resp 已经解除首字节计时，调用方可以安全读完整个 body
 * （流式长回答、非流式完整生成都不会被中途掐断）。
 * 4xx 不重试也不计入健康度——那是凭证/参数问题，换模型一样失败，如实透传上游状态码。
 */
async function callUpstream(apiKey, requestBody, candidates) {
  const list = [];
  for (const c of candidates || []) {
    if (c && c.model && !list.some(x => x.model === c.model)) list.push(c);
  }
  if (list.length === 0) return { resp: null, model: null, error: new Error('没有可用的候选模型') };

  let lastError = null;
  for (let i = 0; i < list.length; i++) {
    const { model, timeoutMs } = list[i];
    // 熔断中的模型直接跳过；但**最后一个候选必须试**，否则会出现"全部跳过、无候选可用"
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
      // 拿到响应头就解除首字节超时：之后的 body 读取不再受约束
      clearTimeout(timer);
      if (resp.ok) {
        noteModelSuccess(model);
        return { resp, model };
      }
      // 4xx：请求/凭证问题，换模型一样失败，如实透传，不计健康度
      if (resp.status < 500) return { resp, model };
      lastError = new Error(`上游模型 ${model} 返回 ${resp.status}`);
      noteModelFailure(model);
      await resp.text().catch(() => ''); // 释放 body，避免连接悬挂
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

// ═══ 图片消息处理：识图理解 / OCR ═══
async function handleImage(env, body) {
  const { image, imageMode, messages } = body;
  const mode = imageMode === 'ocr' ? 'ocr' : 'understand';
  // 识图也走流式：复杂图全量生成可达数十秒，透传 SSE 让用户逐字看到结果
  // OCR 输出通常较短、且不确认上游模型支持流式，保持非流式更稳妥
  const isStream = body.stream === true && mode !== 'ocr';
  const apiKey = env.SILICONFLOW_API_KEY;
  const imageModel = env.IMAGE_MODEL || IMAGE_MODEL_DEFAULT;
  const ocrModel = env.OCR_MODEL || 'deepseek-ai/DeepSeek-OCR';

  // 文本侧上限：图片本身有 MAX_IMAGE_CHARS，但 prompt 与历史此前无任何约束 ——
  // 实测"小图 + 2MB 文本历史"会把 payload 原样发上游（文本路径有 trimMessagesToBudget 兜底，识图路径没有）
  const IMAGE_PROMPT_MAX_CHARS = 2000;
  const IMAGE_HISTORY_MAX_CHARS = 6000;

  const lastText = (messages && messages.length > 0) ? messages[messages.length - 1].content : '';
  const trimmedPrompt = typeof lastText === 'string' ? lastText.slice(0, IMAGE_PROMPT_MAX_CHARS) : '';
  const prompt = mode === 'ocr'
    ? (trimmedPrompt || 'OCR this image. 提取图片中的全部文字，用 Markdown 输出。')
    : (trimmedPrompt || '请描述这张图片的内容。');

  // 识图（understand）带上最近的文本历史：此前只构造单条图片消息，把前端传来的全部
  // 历史丢弃，"接着刚才的话题发张图"时模型看不到前文。
  // OCR 不带历史——DeepSeek-OCR 是纯文字提取模型，塞对话历史会干扰输出。
  // 条数与总字符数双上限，避免"图片 + 长历史"把 payload 撑大。
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
  // 上游挂起/5xx：以前这里会一直悬着，前端只能干等到 35s 首字节上限
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
        'X-Accel-Buffering': 'no'
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

// ═══ 主处理 ═══
export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    // ── 解析前体积拦截：必须早于 request.json()，否则大 body 已被完整解析 ──
    const contentLength = Number(request.headers?.get?.('content-length')) || 0;
    if (contentLength > MAX_BODY_BYTES) {
      return json({ error: `请求体过大（上限约 ${Math.round(MAX_BODY_BYTES / 1048576)}MB）` }, 413);
    }

    const body = await request.json();
    const { messages, model, image, imageMode, injectKnowledge, stream, temperature, max_tokens } = body;

    const apiKey = env.SILICONFLOW_API_KEY;
    if (!apiKey) return json({ error: 'API密钥未配置' }, 500);

    // ── 条数上限：必须在图片分支之前，否则识图请求会绕过它 ──
    // （识图只取最后 6 条发给上游，但 slice/filter 仍要遍历传入的全部消息）
    if (Array.isArray(messages) && messages.length > MAX_MESSAGES) {
      return json({ error: `messages 条数超出上限（最多 ${MAX_MESSAGES} 条）` }, 400);
    }

    // ── 图片消息 ──
    if (image) {
      if (typeof image !== 'string' || image.length > MAX_IMAGE_CHARS) {
        return json({ error: '图片过大或格式无效（上限约 6MB）' }, 413);
      }
      const result = await handleImage(env, body);
      // 流式时返回的是 SSE Response 直接透传；否则是普通对象转 JSON
      return result instanceof Response ? result : json(result);
    }

    // ── 文本对话 ──
    if (!messages || !Array.isArray(messages)) {
      return json({ error: 'messages 参数无效或缺失' }, 400);
    }

    // 知识库检索注入（RAG：按问题检索相关片段，不再整库全量注入）
    // 双通道（prompt + 模型）：命中知识库 → 严格提示词 + KB_MODEL（默认4B，快）；
    //          未命中 → 通用提示词 + GENERAL_MODEL（默认8B，知识面更全）
    let kbModelOverride = null;
    if (injectKnowledge === true && messages.length > 0) {
      const knowledgeBase = await loadKnowledgeBase(request);
      const { injection, hits } = buildKnowledgeInjection(messages, knowledgeBase, KB_CONFIG_DEFAULTS);
      const systemMsgIndex = messages.findIndex(m => m.role === 'system');
      // 寒暄/闲聊（你好/谢谢等）不换 8B，保持 4B 快速响应
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      const isChitchat = lastUserMsg ? shouldSkipRetrieval(String(lastUserMsg.content || '')) : false;

      if (hits.length > 0 && injection) {
        // 快通道主模型 = 4B：它健康时 208 字只要 1.6s（8B 同样内容要 3.9~26.4s），所以命中
        // 知识库仍优先用它。它间歇性零字节挂起（2026-09-15 实测 1/8），靠「3.5s 探针超时 →
        // 换 8B 重试 → 连续失败熔断」兜住，不需要为了它牺牲速度。
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
        // 未命中知识库 → 通用模式。寒暄也走快通道 4B（一句话的答案不需要 8B 的知识面，
        // 却要为它多等十几秒）；真正的通用问答才用 GENERAL_MODEL(8B)。
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
    // 故障转移目标：主模型整体不可用（挂起/5xx）时改用它重试。与主模型相同时候选只剩一个。
    const fallbackModel = env.FALLBACK_MODEL || FALLBACK_MODEL_DEFAULT;
    console.log(`[KB-RAG] final model=${finalModel} (override=${kbModelOverride || 'none'}, frontend=${model || 'none'}, fallback=${fallbackModel})`);

    // ═══ 超窗降级兜底：system+知识库注入+历史 估算超出预算时从最旧历史丢弃（保留 system 与最新提问），
    // 避免上下文超窗被 SiliconFlow 400 拒绝。前端已有第一道裁剪，这里兜住旧缓存前端等异常体积请求 ═══
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
      max_tokens: max_tokens || 800,
      temperature: (typeof temperature === 'number') ? temperature : 0.5,
      top_p: 0.8,
      presence_penalty: 0.2,
      frequency_penalty: 0.3
    };

    // 模型专属入参（enable_search / enable_thinking）在 callUpstream 内**按候选模型**逐个
    // 计算，不在这里按主模型算一次——VL 模型收到 enable_thinking 会直接 400（实测）。

    // ── 流式：透传 SSE ──
    if (isStream) {
      const { resp, model: usedModel, error } = await callUpstream(
        apiKey, requestBody, buildCandidates(finalModel, fallbackModel)
      );
      // 全部候选模型失败：首字节超时或上游 5xx。如实回 504，让前端给出可操作的提示，
      // 而不是让它干等到自己的超时计时触发。
      if (!resp) {
        return json({ error: 'AI 服务暂时不可用，请稍后重试', details: error?.message }, 504);
      }
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        return json({ error: `SiliconFlow API 请求失败：${resp.status} - ${errText.slice(0, 200)}` }, resp.status);
      }
      if (!resp.body) return json({ error: '上游流式响应缺少数据流，请重试' }, 502);
      return new Response(resp.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
          // 回传**实际成功**的模型（故障转移后可能与 finalModel 不同）：供前端
          // 「自动续写」请求显式回传同一模型，避免同一条回答首尾模型不一致
          'X-AI-Model': usedModel
        }
      });
    }

    // ── 非流式 ──
    // 首字节超时 + 换模型重试由 callUpstream 统一处理；4xx 不重试——那是凭证/参数问题
    // （401 密钥无效、400 参数错、429 限流），换模型一样失败，尤其 429 无退避地立即
    // 重试反而加剧限流，故如实透传上游状态码。
    // 注意：这里读 body 不再设超时——首字节计时在拿到响应头时已解除，长回答可以完整
    // 生成而不会被拦腰截断；整体时长由前端超时兜底。前端默认 stream=true，本分支是兜底路径。
    const { resp, model: usedModel, error } = await callUpstream(
      apiKey, requestBody, buildCandidates(finalModel, fallbackModel, NON_STREAM_TIMEOUT_MS, NON_STREAM_TIMEOUT_MS)
    );
    if (!resp) {
      return json({ error: 'AI 服务暂时不可用，请稍后重试', details: error?.message }, 504);
    }
    let responseText;
    try {
      // 读 body 也算网络层：连接在读完响应头后中断会在这里抛错
      responseText = await resp.text();
    } catch (netError) {
      return json({ error: '读取 AI 服务响应中断，请稍后重试', details: netError.message }, 504);
    }
    if (resp.ok) {
      try {
        return json(JSON.parse(responseText), 200, { 'X-AI-Model': usedModel });
      } catch (parseError) {
        // 200 但 body 不是 JSON：重试大概率还是同样结果，直接如实报错
        return json({ error: 'AI 服务返回了非预期格式', details: parseError.message }, 502);
      }
    }
    return json({
      error: `SiliconFlow API 请求失败：${resp.status} - ${responseText.slice(0, 200)}`
    }, resp.status);
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}
