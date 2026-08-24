// Cloudflare Worker: AI Chat + CORS Proxy
// 合并原 netlify/functions/chat.js 和 proxy.js
// v2: 支持流式输出(SSE)、免费多模态识图(Qwen3.5-4B)、OCR 提取(DeepSeek-OCR)、参数透传

const ALLOWED_ORIGINS = [
  'https://jkkeji.netlify.app',
  'https://jkkeji.pages.dev',
  'https://jkkeji-api.health-management.workers.dev',
  'http://localhost:8888',
  'http://127.0.0.1:8888',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];

function buildCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const headers = {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

// ═══ 知识库（内嵌，避免 Workers 无法读取文件系统） ═══
import KNOWLEDGE_BASE from '../Markdown/knowledge-base.md';

// ═══ 图片消息处理：识图理解 / OCR 提取 ═══
async function handleImage(request, env, body) {
  const { image, imageMode, messages } = body;
  const mode = imageMode === 'ocr' ? 'ocr' : 'understand';

  const apiKey = env.SILICONFLOW_API_KEY;
  // 免费多模态模型做"看图问答"；DeepSeek-OCR 做"文字提取"
  const imageModel = env.IMAGE_MODEL || 'Qwen/Qwen3.5-4B';
  const ocrModel = env.OCR_MODEL || 'deepseek-ai/DeepSeek-OCR';

  const lastText = (messages && messages.length > 0)
    ? messages[messages.length - 1].content
    : '';
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
    // OCR 1200 / understand 2000：长报告可能超过 1000 token 触发 length 截断
    max_tokens: mode === 'ocr' ? 1200 : 2000,
    temperature: mode === 'ocr' ? 0.1 : 0.7,
    top_p: 0.8
  };

  // Qwen3.5 默认开启思考模式，思考耗尽 max_tokens 会让 content 为空
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
    const body = await request.json();
    const { messages, model, image, imageMode, injectKnowledge, stream, temperature, max_tokens } = body;

    const apiKey = env.SILICONFLOW_API_KEY;
    if (!apiKey) {
      throw new Error('API密钥未配置');
    }

    // ── 图片消息：识图理解 / OCR ──
    if (image) {
      const result = await handleImage(request, env, body);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // ── 文本对话 ──
    if (!messages || !Array.isArray(messages)) {
      throw new Error('messages 参数无效或缺失');
    }

    // 知识库注入
    if (injectKnowledge === true && messages.length > 0) {
      const systemMsgIndex = messages.findIndex(m => m.role === 'system');
      if (systemMsgIndex !== -1) {
        messages[systemMsgIndex].content += `\n\n--- 产品知识库 ---\n${KNOWLEDGE_BASE}`;
      } else {
        messages.unshift({
          role: 'system',
          content: `你是"个人健康精英Pro+"的AI健康助手。\n\n--- 产品知识库 ---\n${KNOWLEDGE_BASE}`
        });
      }
    }

    const isStream = stream === true;
    const requestBody = {
      model: model || env.DEFAULT_MODEL || 'Qwen/Qwen3-8B',
      messages,
      stream: isStream,
      // 默认 800（原 1500）：降低生成总量，显著缩短非流式等待时间
      max_tokens: max_tokens || 800,
      temperature: (typeof temperature === 'number') ? temperature : 0.5,
      top_p: 0.8,
      presence_penalty: 0.2,
      frequency_penalty: 0.3
    };

    // Qwen 模型：关闭搜索，思考模式由前端配置控制（thinkingMode）；未传时默认 false 兼容旧前端
    if (requestBody.model.includes('Qwen')) {
      requestBody.enable_search = false;
      requestBody.enable_thinking = typeof body.enable_thinking === 'boolean' ? body.enable_thinking : false;
    }

    // ── 流式模式：直接透传 SSE 流（不重试，避免打断已开始的流） ──
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
        throw new Error(`SiliconFlow API 请求失败：${resp.status} - ${errText.slice(0, 200)}`);
      }

      return new Response(resp.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
          ...corsHeaders
        }
      });
    }

    // ── 非流式模式：保留原重试逻辑 ──
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

        const data = JSON.parse(responseText);
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }

    return new Response(JSON.stringify({ error: 'AI 服务响应超时，请稍后重试', details: lastError.message }), {
      status: 504,
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
