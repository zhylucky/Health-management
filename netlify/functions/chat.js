// netlify/functions/chat.js
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { buildKnowledgeInjection, KB_CONFIG_DEFAULTS, GENERAL_SYSTEM_PROMPT } = require('../../shared/kb-retrieval.js');

// CORS 白名单：仅允许官方站点与本地开发环境
const ALLOWED_ORIGINS = [
  'https://jkkeji.netlify.app',
  'http://localhost:8888',
  'http://127.0.0.1:8888',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];

// 根据请求 Origin 动态生成 CORS 头
// 不在白名单的来源不返回 Access-Control-Allow-Origin，浏览器将阻止跨域读取
function buildCorsHeaders(event) {
  const origin = (event.headers && event.headers.origin) || (event.headers && event.headers.Origin) || '';
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

// 知识库缓存（避免每次请求都读文件）
let knowledgeBaseCache = null;
let knowledgeBaseLoadTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

/**
 * 加载知识库文件（带缓存）
 */
function loadKnowledgeBase() {
  const now = Date.now();
  // 如果缓存有效，直接返回
  if (knowledgeBaseCache && (now - knowledgeBaseLoadTime) < CACHE_TTL) {
    return knowledgeBaseCache;
  }

  try {
    // 尝试多个可能的路径
    const possiblePaths = [
      path.join(__dirname, '../../Markdown/kb.md'),
      path.join(process.cwd(), 'Markdown/kb.md'),
      path.join('/opt/build/repo', 'Markdown/kb.md')
    ];

    for (const filePath of possiblePaths) {
      if (fs.existsSync(filePath)) {
        knowledgeBaseCache = fs.readFileSync(filePath, 'utf8');
        knowledgeBaseLoadTime = now;
        console.log(`[KnowledgeBase] Loaded from: ${filePath}`);
        return knowledgeBaseCache;
      }
    }

    console.warn('[KnowledgeBase] File not found in any path');
    return null;
  } catch (error) {
    console.error('[KnowledgeBase] Load error:', error.message);
    return null;
  }
}

exports.handler = async function(event, context) {
  // 处理预检请求 (OPTIONS)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: buildCorsHeaders(event),
      body: ''
    };
  }

  // 只允许 POST 请求
  if (event.httpMethod !== 'POST') {
    return { 
      statusCode: 405, 
      headers: {
        'Content-Type': 'application/json',
        ...buildCorsHeaders(event)
      },
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }

  // 处理 CORS（仅放行白名单来源）
  const corsHeaders = buildCorsHeaders(event);

  try {
    // 检查请求体是否存在
    if (!event.body) {
      throw new Error('请求体为空');
    }

    const { messages, model, image, injectKnowledge } = JSON.parse(event.body);

    // 验证参数
    if (!messages || !Array.isArray(messages)) {
      throw new Error('messages 参数无效或缺失');
    }

    // ========== 知识库检索注入（RAG） ==========
    // 按问题检索相关片段，不再整库全量注入
    // 双通道（prompt + 模型）：命中知识库 → 严格提示词 + KB_MODEL（默认4B，快）；
    //          未命中 → 通用提示词 + GENERAL_MODEL（默认8B，知识面更全）
    let kbModelOverride = null;
    if (injectKnowledge === true && !image && messages.length > 0) {
      const knowledgeBase = loadKnowledgeBase();
      if (knowledgeBase) {
        const { injection, hits } = buildKnowledgeInjection(messages, knowledgeBase, KB_CONFIG_DEFAULTS);
        const systemMsgIndex = messages.findIndex(m => m.role === 'system');

        if (hits.length > 0 && injection) {
          kbModelOverride = process.env.KB_MODEL || 'Qwen/Qwen3.5-4B';
          // 找到system message并注入
          if (systemMsgIndex !== -1) {
            messages[systemMsgIndex].content += injection;
            console.log('[KB-RAG] Injected into system message');
          } else {
            messages.unshift({
              role: 'system',
              content: `你是"个人健康精英Pro+"的AI健康助手。${injection}`
            });
            console.log('[KB-RAG] Created new system message');
          }
          console.log('[KB-RAG] hits:', hits.map(h => `${h.title}(${h.score.toFixed(2)})`).join(' | '));
        } else {
          // 未命中知识库 → 通用模式
          kbModelOverride = process.env.GENERAL_MODEL || 'Qwen/Qwen3-8B';
          if (systemMsgIndex !== -1) {
            messages[systemMsgIndex].content = GENERAL_SYSTEM_PROMPT;
          } else {
            messages.unshift({ role: 'system', content: GENERAL_SYSTEM_PROMPT });
          }
          console.log('[KB-RAG] no hit, switch to general prompt');
        }
      }
    }

    // 检查环境变量（优先使用SILICONFLOW_API_KEY，兼容AI_API_KEY）
    const apiKey = process.env.SILICONFLOW_API_KEY || process.env.AI_API_KEY;
    if (!apiKey) {
      throw new Error('API密钥未配置，请在Netlify环境变量中设置SILICONFLOW_API_KEY或AI_API_KEY');
    }
    
    // ========== 图像理解功能 ==========
    if (image) {
      console.log('[Image] Processing image request...');
      const imageRequestBody = {
        model: 'Qwen/Qwen2.5-VL-72B-Instruct',  // 使用视觉模型
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: image } },
              { type: 'text', text: messages[messages.length - 1]?.content || '请描述这张图片的内容，并与个人健康精英Pro+产品功能相结合进行说明。' }
            ]
          }
        ],
        max_tokens: 800,
        temperature: 0.7,
        top_p: 0.8
      };

      const response = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'User-Agent': 'Netlify-Function-Client'
        },
        body: JSON.stringify(imageRequestBody),
        timeout: 55000
      });

      if (!response.ok) {
        throw new Error(`视觉模型API请求失败：${response.status}`);
      }

      const data = await response.json();
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        },
        body: JSON.stringify({
          choices: [{
            message: {
              content: data.choices[0]?.message?.content || '图片解析失败，请稍后重试。'
            }
          }],
          type: 'image_response'
        })
      };
    }

    // 构建请求参数
    const requestBody = {
      model: kbModelOverride || model || 'Qwen/Qwen3-8B',
      messages: messages,
      stream: false,
      max_tokens: 1500,
      temperature: 0.5,
      top_p: 0.8,
      presence_penalty: 0.2,
      frequency_penalty: 0.3
    };

    // 明确关闭思考模式和其他耗时功能
    if (model && model.includes('Qwen')) {
      requestBody.enable_search = false;
      requestBody.enable_thinking = false;
    }
    const maxRetries = 2;
    const baseDelay = 500;
        
    let lastError;
        
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Attempt ${attempt + 1}/${maxRetries + 1}] Calling SiliconFlow API...`);
                    
        const response = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'User-Agent': 'Netlify-Function-Client'
          },
          body: JSON.stringify(requestBody),
          timeout: 55000
        });
        
        const responseText = await response.text();
                
        if (!response.ok) {
          if (response.status === 504 || response.status === 503) {
            console.warn(`[Attempt ${attempt + 1}] Server timeout (${response.status}), will retry...`);
            throw new Error(`SiliconFlow API 暂时不可用：${response.status}`);
          }
          throw new Error(`SiliconFlow API 请求失败：${response.status} ${response.statusText} - ${responseText}`);
        }
            
        let data;
        try {
          data = JSON.parse(responseText);
          console.log(`[Success] API response received in ${Date.now()}ms`);
        } catch (parseError) {
          throw new Error(`响应数据解析失败：${parseError.message} - 原始响应：${responseText}`);
        }
                    
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          },
          body: JSON.stringify(data)
        };
      } catch (error) {
        lastError = error;
        console.error(`[Attempt ${attempt + 1}] Failed:`, error.message);
            
        if (attempt < maxRetries) {
          const delay = baseDelay * (attempt + 1);
          console.log(`[Retry] Waiting ${delay}ms before next attempt...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
        
    console.error('[Final] All attempts failed:', lastError.message);
    return {
      statusCode: 504,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      },
      body: JSON.stringify({ 
        error: 'AI 服务响应超时，请稍后重试',
        details: lastError.message
      })
    };
    
  } catch (error) {
    console.error('Function执行错误:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      },
      body: JSON.stringify({ 
        error: error.message
      })
    };
  }
};
