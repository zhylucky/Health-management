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

async function loadKnowledgeBase(request) {
  if (KNOWLEDGE_BASE_CACHE) return KNOWLEDGE_BASE_CACHE;
  try {
    const url = new URL('/Markdown/kb.md', request.url);
    const resp = await fetch(url.toString(), { cache: 'no-store' });
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

// ═══ 图片消息处理：识图理解 / OCR ═══
async function handleImage(env, body) {
  const { image, imageMode, messages } = body;
  const mode = imageMode === 'ocr' ? 'ocr' : 'understand';
  // 识图也走流式：复杂图全量生成可达数十秒，透传 SSE 让用户逐字看到结果
  // OCR 输出通常较短、且不确认上游模型支持流式，保持非流式更稳妥
  const isStream = body.stream === true && mode !== 'ocr';
  const apiKey = env.SILICONFLOW_API_KEY;
  const imageModel = env.IMAGE_MODEL || 'Qwen/Qwen3.5-4B';
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

  // Qwen3.5 系列默认开启思考模式，思考耗尽 max_tokens 会让 content 为空
  // 识图必须关闭思考以保证直接输出结果
  if (imageRequestBody.model.includes('Qwen')) {
    imageRequestBody.enable_search = false;
    imageRequestBody.enable_thinking = false;
  }

  const resp = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(imageRequestBody)
  });

  if (!resp.ok) {
    const errText = await resp.text();
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
        // 未命中知识库 → 通用模式；寒暄仍用 4B 保证响应速度
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
    console.log(`[KB-RAG] final model=${finalModel} (override=${kbModelOverride || 'none'}, frontend=${model || 'none'})`);

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

    if (requestBody.model.includes('Qwen')) {
      requestBody.enable_search = false;
      // 思考模式**当前固定关闭**。入参通道保留（便于将来启用），但前端从不传
      // enable_thinking —— config/ai-chat-config.js 与 js/ai-chat.js 里都没有该字段
      // （grep 可证），所以恒为 false。关闭原因：平台默认开启思考，思考会耗尽
      // max_tokens 导致 content 为空，而前端不解析 reasoning_content，表现为"回答空白"。
      // 若将来要重新启用，前端必须同步支持渲染 reasoning_content。
      requestBody.enable_thinking = typeof body.enable_thinking === 'boolean' ? body.enable_thinking : false;
    }

    // ── 流式：透传 SSE ──
    if (isStream) {
      const resp = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
      });
      if (!resp.ok) {
        const errText = await resp.text();
        return json({ error: `SiliconFlow API 请求失败：${resp.status} - ${errText.slice(0, 200)}` }, resp.status);
      }
      return new Response(resp.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
          // 回传实际使用的模型：供前端「自动续写」请求显式回传同一模型，
          // 避免 RAG 未命中切到 GENERAL_MODEL(8B) 后，续写回落前端默认模型导致首尾不一致
          'X-AI-Model': finalModel
        }
      });
    }

    // ── 非流式 ──
    // 只重试「值得重试」的失败：网络层异常与 5xx（上游临时故障）。
    // 4xx 是请求/凭证本身的问题（401 密钥无效、400 参数错、429 限流），重试必然同样
    // 失败；尤其 429 无退避地立即重试反而加剧限流，故直接透传上游状态码。
    const maxRetries = 2;
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let resp, responseText;
      try {
        resp = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify(requestBody)
        });
        // 读 body 也算网络层：连接在读完响应头后中断会在这里抛错，同样值得重试
        responseText = await resp.text();
      } catch (netError) {
        lastError = netError; // 网络层失败 → 可重试
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }

      if (resp.ok) {
        try {
          return json(JSON.parse(responseText), 200, { 'X-AI-Model': finalModel });
        } catch (parseError) {
          // 200 但 body 不是 JSON：重试大概率还是同样结果，直接如实报错
          return json({ error: 'AI 服务返回了非预期格式', details: parseError.message }, 502);
        }
      }
      if (resp.status < 500) {
        return json({
          error: `SiliconFlow API 请求失败：${resp.status} - ${responseText.slice(0, 200)}`
        }, resp.status);
      }
      lastError = new Error(`SiliconFlow API 暂时不可用：${resp.status}`);
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
    return json({ error: 'AI 服务响应超时，请稍后重试', details: lastError?.message }, 504);
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}
