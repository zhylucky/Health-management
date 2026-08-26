// ═══════════════════════════════════════════════
// Pages Function: /api/chat 同域 AI 代理
// 作用：前端同域请求 /api/chat → 本函数转发到 SiliconFlow
//      彻底绕开 workers.dev 跨境不稳定的问题（与页面同一网络路径）
// 依赖：Pages 项目环境变量 SILICONFLOW_API_KEY（wrangler pages secret put）
// ═══════════════════════════════════════════════

// 知识库 RAG 检索（共享模块，三通道行为一致）
import { buildKnowledgeInjection, KB_CONFIG_DEFAULTS, GENERAL_SYSTEM_PROMPT, shouldSkipRetrieval } from '../../shared/kb-retrieval.js';

// 知识库：运行时读取同源静态资源 Markdown/kb.md
// （Pages Functions 打包器不支持 .md 导入，故随站点发布后 fetch 读取）
let KNOWLEDGE_BASE_CACHE = null;

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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

// ═══ 图片消息处理：识图理解 / OCR ═══
async function handleImage(env, body) {
  const { image, imageMode, messages } = body;
  const mode = imageMode === 'ocr' ? 'ocr' : 'understand';
  const apiKey = env.SILICONFLOW_API_KEY;
  const imageModel = env.IMAGE_MODEL || 'Qwen/Qwen3.5-4B';
  const ocrModel = env.OCR_MODEL || 'deepseek-ai/DeepSeek-OCR';

  const lastText = (messages && messages.length > 0) ? messages[messages.length - 1].content : '';
  const prompt = mode === 'ocr'
    ? (typeof lastText === 'string' && lastText ? lastText : 'OCR this image. 提取图片中的全部文字，用 Markdown 输出。')
    : (typeof lastText === 'string' && lastText ? lastText : '请描述这张图片的内容。');

  const imageRequestBody = {
    model: mode === 'ocr' ? ocrModel : imageModel,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: image } },
        { type: 'text', text: prompt }
      ]
    }],
    stream: false,
    max_tokens: mode === 'ocr' ? 1200 : 2000,
    temperature: mode === 'ocr' ? 0.1 : 0.7,
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
    const body = await request.json();
    const { messages, model, image, imageMode, injectKnowledge, stream, temperature, max_tokens } = body;

    const apiKey = env.SILICONFLOW_API_KEY;
    if (!apiKey) return json({ error: 'API密钥未配置' }, 500);

    // ── 图片消息 ──
    if (image) {
      const result = await handleImage(env, body);
      return json(result);
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

    const isStream = stream === true;
    const requestBody = {
      model: kbModelOverride || model || env.DEFAULT_MODEL || 'Qwen/Qwen3-8B',
      messages,
      stream: isStream,
      max_tokens: max_tokens || 800,
      temperature: (typeof temperature === 'number') ? temperature : 0.5,
      top_p: 0.8,
      presence_penalty: 0.2,
      frequency_penalty: 0.3
    };

    if (requestBody.model.includes('Qwen')) {
      requestBody.enable_search = false;
      // 思考模式由前端配置控制（thinkingMode）；未传时默认 false，兼容旧前端
      // 避免平台默认开启思考导致 content 为空（旧前端无法解析 reasoning_content）
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
          'X-Accel-Buffering': 'no'
        }
      });
    }

    // ── 非流式 ──
    const maxRetries = 2;
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const resp = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify(requestBody)
        });
        const responseText = await resp.text();
        if (!resp.ok) {
          if (resp.status === 504 || resp.status === 503) {
            throw new Error(`SiliconFlow API 暂时不可用：${resp.status}`);
          }
          throw new Error(`SiliconFlow API 请求失败：${resp.status} - ${responseText.slice(0, 200)}`);
        }
        return json(JSON.parse(responseText));
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }
    return json({ error: 'AI 服务响应超时，请稍后重试', details: lastError?.message }, 504);
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}
