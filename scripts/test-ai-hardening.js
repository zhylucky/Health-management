#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// scripts/test-ai-hardening.js — AI 链路加固回归测试（零依赖，node 直跑）
//
// 覆盖 2026-09-11 加固的四部分，防止将来被改回去：
//   1. js/ai-chat.js formatContent 的链接渲染不得产生 HTML 属性注入 / 危险协议 / 外站跳转
//   2. shared/kb-retrieval.js trimMessagesToBudget 必须 O(n) 且与旧实现语义等价
//   3. functions/api/chat.js 的请求上限（含解析前体积拦截）、识图历史、重试策略
//   4. functions/api/chat.js 与 workers/index.js 的关键常量保持一致（两份重复实现）
//
// 用法：node scripts/test-ai-hardening.js     任一项失败即 exit 1
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;

function check(name, ok, info) {
  ok ? pass++ : fail++;
  console.log((ok ? '  OK    ' : '  FAIL  ') + name + (info ? '  ' + info : ''));
}

// ═══ 1. formatContent：从真实源码抽取方法后测试 ═══
function extractFormatContent() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'ai-chat.js'), 'utf8');
  const start = src.indexOf('formatContent(content) {');
  if (start === -1) throw new Error('未在 js/ai-chat.js 找到 formatContent');
  const open = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) { end = j; break; } }
  }
  return new Function('content', src.slice(open + 1, end));
}

function testFormatContent() {
  console.log('\n═══ 1. formatContent 链接渲染安全 ═══');
  const formatContent = extractFormatContent();

  const attacks = [
    ['[点我](javascript:alert(document.cookie))', 'javascript: 协议'],
    ['[点我](" onmouseover="alert(1))', '属性闭合注入'],
    ['[点我](x" style="position:fixed;inset:0")', 'style 属性注入'],
    ['[恶意](data:text/html;base64,PHNjcmlwdD4=)', 'data: 协议'],
    ['[恶意](vbscript:msgbox)', 'vbscript: 协议'],
    ['[外站](//evil.example.com/phish)', '协议相对 URL（外站跳转）'],
    ['[外站](///evil.example.com)', '三斜杠协议相对 URL'],
  ];
  for (const [input, label] of attacks) {
    const out = formatContent(input);
    const injected = /<[^>]*\son\w+\s*=/i.test(out) || /<[^>]*\sstyle\s*=/i.test(out);
    const badProto = /<a[^>]*href="\s*(?:javascript|data|vbscript):/i.test(out);
    // href="//host" 是协议相对 URL，会跳到外站（不是 XSS，但要拦）
    const badHost = /<a[^>]*href="\s*\/\//i.test(out);
    check('拒绝 ' + label, !injected && !badProto && !badHost, '→ ' + out.slice(0, 60));
  }

  const normal = [
    ['[官网](https://health.bbroot.com)', '<a href="https://health.bbroot.com"'],
    ['[站内](/html/login)', '<a href="/html/login"'],
    ['[锚点](#top)', '<a href="#top"'],
    ['**加粗**', '<strong>'],
    ['## 标题', '<h2>'],
    ['- 甲\n- 乙', '<ul>'],
    ['1. 甲\n2. 乙', '<ol>'],
    ['`code`', '<code>'],
    ['他说"你好"', '&quot;'],
  ];
  for (const [input, expect] of normal) {
    const out = formatContent(input);
    check('正常渲染 ' + JSON.stringify(input).slice(0, 26), out.includes(expect));
  }
}

// ═══ 2. trimMessagesToBudget：O(n) 且与旧实现等价 ═══
function testTrim() {
  console.log('\n═══ 2. trimMessagesToBudget 等价性与复杂度 ═══');
  const { trimMessagesToBudget, estimateTokens } = require(path.join(ROOT, 'shared', 'kb-retrieval.js'));

  // 旧 O(n²) 实现（对照基线）
  const oldTrim = (messages, budget) => {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    const est = (l) => l.reduce((s, m) => s + estimateTokens(typeof m.content === 'string' ? m.content : '') + 4, 0);
    const out = messages.slice();
    while (out.length > 1 && est(out) > budget) {
      const i = out.findIndex(m => m.role !== 'system');
      if (i === -1 || i === out.length - 1) break;
      out.splice(i, 1);
    }
    return out;
  };

  const roles = ['system', 'user', 'assistant'];
  const texts = ['你好', '这是一段中文测试内容', 'hello world', '', 'x'.repeat(50), '长'.repeat(120)];
  const rand = (n, seed) => {
    let s = seed;
    const r = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    return Array.from({ length: n }, () => ({
      role: roles[Math.floor(r() * 3)], content: texts[Math.floor(r() * texts.length)]
    }));
  };

  let mismatch = 0, total = 0;
  for (let seed = 1; seed <= 2000; seed++) {
    const msgs = rand(1 + (seed % 40), seed);
    for (const budget of [0, 10, 50, 100, 300, 1000, 5000]) {
      total++;
      if (JSON.stringify(oldTrim(msgs, budget)) !== JSON.stringify(trimMessagesToBudget(msgs, budget))) mismatch++;
    }
  }
  check('与旧实现语义等价', mismatch === 0, `${total - mismatch}/${total} 用例一致`);

  // 复杂度：8000 条应远快于旧实现（旧实现实测 >20 秒）
  const big = rand(8000, 42);
  const t0 = process.hrtime.bigint();
  trimMessagesToBudget(big, 26000);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check('8000 条消息 < 100ms（旧实现需 >20 秒）', ms < 100, ms.toFixed(2) + ' ms');
}

// ═══ 3. /api/chat 处理器：上限防护 / 识图历史 / 重试策略 ═══
async function testChatHandler() {
  console.log('\n═══ 3. /api/chat 处理器行为 ═══');
  const { onRequestPost, __resetUpstreamHealth, __resetKnowledgeBaseCache } = await import(
    'file://' + path.join(ROOT, 'functions', 'api', 'chat.js').replace(/\\/g, '/')
  );

  const env = { SILICONFLOW_API_KEY: 'sk-test-not-real' };
  const mkReq = (body) => ({ json: async () => body, url: 'https://health.bbroot.com/api/chat' });
  let captured = null;
  const okJson = (content = 'ok') => new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );

  const call = async (body) => {
    captured = null;
    return onRequestPost({ request: mkReq(body), env });
  };

  // 上限防护
  globalThis.fetch = async () => okJson();
  check('空 body → 400', (await call({})).status === 400);
  check('messages 非数组 → 400', (await call({ messages: 'x' })).status === 400);
  check('messages 61 条 → 400', (await call({ messages: new Array(61).fill({ role: 'user', content: 'x' }) })).status === 400);
  check('图片 9MB → 413', (await call({ image: 'data:image/png;base64,' + 'A'.repeat(9 * 1024 * 1024) })).status === 413);
  // 条数上限必须先于图片分支：否则识图请求会绕过它
  const tooMany = [{ role: 'system', content: 'S' }];
  for (let i = 0; i < 60; i++) tooMany.push({ role: i % 2 ? 'user' : 'assistant', content: 'M' + i });
  check('识图 + 61 条 messages → 400（不绕过上限）',
    (await call({ image: 'data:image/png;base64,AAAA', imageMode: 'understand', stream: false, messages: tooMany })).status === 400);

  // 解析前体积拦截：超大 content-length 必须在 request.json() 之前被拒，否则整个 body 已被解析
  let parsedBigBody = false;
  const bigBodyReq = {
    headers: { get: (h) => (String(h).toLowerCase() === 'content-length' ? String(9 * 1024 * 1024) : null) },
    json: async () => { parsedBigBody = true; return { messages: [{ role: 'user', content: 'x' }] }; },
    url: 'https://health.bbroot.com/api/chat'
  };
  const bigRes = await onRequestPost({ request: bigBodyReq, env });
  check('超大 content-length → 413 且不解析 body',
    bigRes.status === 413 && !parsedBigBody, `(状态 ${bigRes.status}, 已解析=${parsedBigBody})`);

  // 边界：恰为上限应放行到解析层（只有「超过」才拒），且无 content-length 的 chunked 请求不受影响
  let parsedAtLimit = false;
  const atLimitReq = {
    headers: { get: (h) => (String(h).toLowerCase() === 'content-length' ? String(8 * 1024 * 1024 + 64 * 1024) : null) },
    json: async () => { parsedAtLimit = true; return { messages: [{ role: 'user', content: 'hi' }], stream: false }; },
    url: 'https://health.bbroot.com/api/chat'
  };
  check('content-length 恰为上限 → 放行解析',
    (await onRequestPost({ request: atLimitReq, env })).status === 200 && parsedAtLimit);

  // 识图历史
  globalThis.fetch = async (url, opts) => { captured = JSON.parse(opts.body); return okJson(); };
  const msgs = [
    { role: 'system', content: 'S' },
    { role: 'user', content: '第一个问题' },
    { role: 'assistant', content: '第一个回答' },
    { role: 'user', content: '看图' },
  ];
  await call({ image: 'data:image/png;base64,AAAA', imageMode: 'understand', stream: false, messages: msgs });
  const u = captured.messages;
  check('识图 understand 带 2 条文本历史 + 1 条图片',
    u.length === 3 && u.map(m => m.role).join(',') === 'user,assistant,user' && Array.isArray(u[2].content),
    `(上游 ${u.length} 条)`);

  await call({ image: 'data:image/png;base64,AAAA', imageMode: 'ocr', stream: false, messages: msgs });
  check('识图 OCR 不带历史', captured.messages.length === 1 && captured.model.includes('OCR'),
    `(上游 ${captured.messages.length} 条)`);

  const many = [{ role: 'system', content: 'S' }];
  for (let i = 1; i <= 12; i++) many.push({ role: i % 2 ? 'user' : 'assistant', content: 'M' + i });
  many.push({ role: 'user', content: '看图' });
  await call({ image: 'data:image/png;base64,AAAA', imageMode: 'understand', stream: false, messages: many });
  check('识图历史截到 6 条', captured.messages.length === 7, `(上游 ${captured.messages.length} 条)`);

  // 识图路径无 token 裁剪，必须有文本总量上限兜底
  const longHistory = [{ role: 'system', content: 'S' }];
  for (let i = 0; i < 6; i++) longHistory.push({ role: i % 2 ? 'user' : 'assistant', content: 'x'.repeat(5000) });
  longHistory.push({ role: 'user', content: '看图' });
  await call({ image: 'data:image/png;base64,AAAA', imageMode: 'understand', stream: false, messages: longHistory });
  const histChars = captured.messages.slice(0, -1)
    .reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
  check('识图历史文本超预算被截（≤6000 字符）', histChars > 0 && histChars <= 6000, `(历史 ${histChars} 字符)`);

  await call({
    image: 'data:image/png;base64,AAAA', imageMode: 'understand', stream: false,
    messages: [{ role: 'user', content: 'A'.repeat(9999) }]
  });
  const textPart = captured.messages[captured.messages.length - 1].content.find(c => c.type === 'text');
  check('识图 prompt 超长截断到 2000 字符', textPart.text.length === 2000, `(${textPart.text.length} 字符)`);

  // 重试策略
  const chatBody = { messages: [{ role: 'user', content: 'hi' }], stream: false, model: 'Qwen/Qwen3.5-4B' };
  const retryCase = async (label, responder, expectStatus, expectCalls) => {
    __resetUpstreamHealth(); // 熔断状态是模块级的，每个用例都要从干净状态开始
    let calls = 0;
    globalThis.fetch = async () => { calls++; return responder(calls); };
    const res = await onRequestPost({ request: mkReq(chatBody), env });
    check(label, res.status === expectStatus && calls === expectCalls,
      `(状态 ${res.status}, 上游 ${calls} 次)`);
  };
  const errRes = (c) => new Response('upstream error', { status: c });
  await retryCase('4xx 不重试（400）', () => errRes(400), 400, 1);
  await retryCase('4xx 不重试（429）', () => errRes(429), 429, 1);
  // ═══ 重试契约变更（2026-09-15）═══
  // 旧契约：同一模型重试 3 次。线上故障证明它无效——模型整体挂起时，对同一个死模型重试
  // 3 次只是把超时时间翻 3 倍，仍然必败。
  // 新契约：主模型失败后**换备用模型**再试（每个模型只试 1 次，否则挂起场景的等待会成倍
  // 放大）。总尝试次数从 3 降到 2，但对"模型整体不可用"这一真实故障模式有效。
  await retryCase('5xx 依次换两个备用模型仍失败 → 504', () => errRes(503), 504, 3);
  await retryCase('5xx 后换备用模型成功 → 200', (n) => (n === 1 ? errRes(503) : okJson()), 200, 2);
  await retryCase('200 但非 JSON → 502', () => new Response('not json', { status: 200 }), 502, 1);
  // 读 body 失败：不再重试。首字节之后的中断发生在"已经生成内容"的阶段，且此刻换模型
  // 重发会把已生成的半截内容作废；前端默认走流式（本分支只是兜底路径），直接报错更可预测。
  await retryCase('body 读取失败 → 504（不重试）',
    () => new Response(new ReadableStream({ start(c) { c.error(new Error('body broken')); } }), { status: 200 }),
    504, 1);
  // 主备同名（未配 FALLBACK_MODEL / 主模型就是备用模型）时不得"假装故障转移"：
  // 同一个模型只能被调用一次，之后直接接第二备用。
  {
    __resetUpstreamHealth();
    const seen = [];
    globalThis.fetch = async (url, opts) => { seen.push(JSON.parse(opts.body).model); return errRes(503); };
    const res = await onRequestPost({ request: mkReq({ ...chatBody, model: 'Qwen/Qwen3-8B' }), env });
    check('主模型=备用模型时不重复调用，直接接第二备用（8B → GLM）',
      res.status === 504 && seen.length === 2 &&
      seen[0] === 'Qwen/Qwen3-8B' && seen[1] === 'THUDM/GLM-Z1-9B-0414',
      `(状态 ${res.status}, 依次 ${seen.join(' → ')})`);
    __resetUpstreamHealth();
  }

  // ═══ 三级免费候选链：4B → 8B → GLM（三个都是确认免费的模型）═══
  // 顺序即优先级：4B 最快（活着时）→ 8B 最稳 → GLM 兜底（免费但思考关不掉，所以放最后）。
  // 同时校验：非 Qwen 模型不得携带 enable_thinking（GLM 收到它也照样思考，加了没意义；
  // 而 VL 类模型收到它会直接 400）。
  {
    __resetUpstreamHealth();
    const seen = [];
    let glmBody = null;
    globalThis.fetch = async (url, opts) => {
      const b = JSON.parse(opts.body);
      seen.push(b.model);
      if (b.model.includes('GLM')) glmBody = b;
      return seen.length < 3 ? errRes(503) : okJson();
    };
    const res = await onRequestPost({ request: mkReq({ ...chatBody, stream: true }), env });
    check('三级免费候选链按顺序降级：4B → 8B → GLM',
      res.status === 200 && seen.length === 3 &&
      seen[0] === 'Qwen/Qwen3.5-4B' && seen[1] === 'Qwen/Qwen3-8B' && seen[2] === 'THUDM/GLM-Z1-9B-0414',
      `(状态 ${res.status}, 依次 ${seen.join(' → ')})`);
    check('第二备用（GLM，非 Qwen）不携带 enable_thinking',
      glmBody && glmBody.enable_thinking === undefined && glmBody.enable_search === undefined,
      `(enable_thinking=${glmBody && glmBody.enable_thinking})`);
    __resetUpstreamHealth();
  }

  // ═══ 首字节超时 + 模型故障转移（核心场景）═══
  // 复现线上故障：主模型请求发出后挂起，既不返回内容也不返回错误码（实测零字节）。
  // 期望：主模型探针超时 → 自动切备用模型 → 成功返回，而不是干等到前端超时。
  // 用 stream:true——这才是生产真实路径（config.stream 默认 true）；非流式走
  // NON_STREAM_TIMEOUT_MS(60s)，此处不测（会让套件慢一分钟）。
  {
    __resetUpstreamHealth();
    const streamBody = { ...chatBody, stream: true };
    let calls = 0;
    globalThis.fetch = async (url, opts) => {
      calls++;
      if (calls === 1) {
        // 模拟上游挂起：永不 resolve，仅在 abort 时 reject
        return new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        });
      }
      return okJson();
    };
    const t0 = Date.now();
    const res = await onRequestPost({ request: mkReq(streamBody), env });
    const dt = Date.now() - t0;
    check('主模型挂起 → 探针超时(3.5s)后切备用模型并成功',
      res.status === 200 && calls === 2 && dt >= 3000 && dt < 8000,
      `(状态 ${res.status}, 上游 ${calls} 次, 耗时 ${dt}ms)`);
  }

  // ═══ 熔断：主模型持续挂起时，不能让每个请求都白等一次探针超时 ═══
  // 实测 4B 只有 1/8 成功，若每个请求都先等 3.5s 再切，用户要为每次提问多付 3.5s。
  {
    __resetUpstreamHealth();
    const streamBody = { ...chatBody, stream: true };
    const hang = (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
    // 前两次：主模型挂起 → 切备用成功（同时把主模型计入失败）
    for (let i = 0; i < 2; i++) {
      let n = 0;
      globalThis.fetch = async (u, o) => (++n === 1 ? hang(u, o) : okJson());
      await onRequestPost({ request: mkReq(streamBody), env });
    }
    // 第三次：主模型应被熔断跳过 → 只有 1 次上游调用，且不再有探针等待
    let calls = 0;
    globalThis.fetch = async () => { calls++; return okJson(); };
    const t0 = Date.now();
    const res = await onRequestPost({ request: mkReq(streamBody), env });
    const dt = Date.now() - t0;
    check('连续失败后熔断：第三个请求跳过主模型（1 次调用、无探针等待）',
      res.status === 200 && calls === 1 && dt < 1500,
      `(状态 ${res.status}, 上游 ${calls} 次, 耗时 ${dt}ms)`);
    __resetUpstreamHealth();
  }

  // ═══ 逐候选模型入参：VL 模型不能带 enable_thinking（实测 400）═══
  {
    const vlCaptured = [];
    globalThis.fetch = async (url, opts) => { vlCaptured.push(JSON.parse(opts.body)); return okJson(); };
    await onRequestPost({ request: mkReq({ image: 'data:image/png;base64,AAAA', imageMode: 'understand', messages: [{ role: 'user', content: 'x' }] }), env });
    const vlBody = vlCaptured[0];
    check('识图默认模型是免费的 Qwen/Qwen3.5-4B 且关闭思考',
      vlBody.model === 'Qwen/Qwen3.5-4B' && vlBody.enable_thinking === false && vlBody.enable_search === false,
      `(model=${vlBody.model}, enable_thinking=${vlBody.enable_thinking})`);

    const textCaptured = [];
    globalThis.fetch = async (url, opts) => { textCaptured.push(JSON.parse(opts.body)); return okJson(); };
    __resetUpstreamHealth();
    await onRequestPost({ request: mkReq({ ...chatBody, messages: [{ role: 'user', content: 'hi' }] }), env });
    const textBody = textCaptured[0];
    check('文本 Qwen 模型仍然关闭搜索与思考',
      textBody.enable_thinking === false && textBody.enable_search === false,
      `(enable_thinking=${textBody.enable_thinking}, enable_search=${textBody.enable_search})`);
    __resetUpstreamHealth();
  }

  // ═══ 识图兜底链：默认**全部是 0 费用模型**，且不得悄悄切到收费 VLM ═══
  // 2026-09-15 定策：免费档里没有第二个能"看图回答"的通用 VLM（`Qwen/Qwen3-8B` 的视觉标签是错的，
  // 发图回 400 `The model is not a VLM`；VL-8B / VL-30B 分别 ¥2/M、¥2.8/M 属收费），所以兜底只能
  // 挂 OCR 模型。**方案 B**：OCR 只当"读图的替身"，抠出的文字再交给免费文本模型生成回答，
  // 用户看到的是回答而不是一屏原文（见下面 answerFromOcrText 相关断言）。
  {
    __resetUpstreamHealth();
    const seen = [];
    const bodies = [];
    // 带两轮历史，用于验证"兜底到 OCR 模型时不带历史"
    const imgReq = {
      image: 'data:image/png;base64,AAAA', imageMode: 'understand', stream: true,
      messages: [
        { role: 'user', content: '前文提问' },
        { role: 'assistant', content: '前文回答' },
        { role: 'user', content: '看看这张图' }
      ]
    };
    globalThis.fetch = async (url, opts) => {
      const b = JSON.parse(opts.body);
      seen.push(b.model); bodies.push(b);
      return errRes(503);
    };
    const res = await onRequestPost({ request: mkReq(imgReq), env });
    check('识图默认兜底链是 4B → DeepSeek-OCR → PaddleOCR-VL（全部 0 费用）',
      seen.length === 3 && seen[0] === 'Qwen/Qwen3.5-4B' &&
      seen[1] === 'deepseek-ai/DeepSeek-OCR' && seen[2] === 'PaddlePaddle/PaddleOCR-VL-1.5',
      `(依次 ${seen.join(' → ')})`);
    // ⚠️ 别用 /-VL-/ 当判据：OCR 模型自己也叫 `PaddleOCR-VL-1.5`，会误伤。
    // 收费的是 Qwen3-VL-*（¥2/M、¥2.8/M）与 GLM-4.xV（¥1/M）。
    check('识图默认链里不含任何收费 VLM（Qwen3-VL-* / GLM-4.xV）',
      !seen.some(m => /Qwen3-VL|GLM-4\.\dV/i.test(m)), `(${seen.join(', ')})`);
    check('识图全部候选失败 → 500（不是无限悬挂）', res.status === 500, `(状态 ${res.status})`);

    const textOf = (b) => b.messages[b.messages.length - 1].content.find(c => c.type === 'text').text;
    check('识图主模型（4B，非 OCR）保留用户提问与历史',
      textOf(bodies[0]) === '看看这张图' && bodies[0].messages.length === 3,
      `(prompt=${JSON.stringify(textOf(bodies[0]))}, messages=${bodies[0].messages.length})`);
    // 实测：DeepSeek-OCR 收到自然语言提问返回空 content；带英文前缀的中文提示也返回空
    // （原 OCR 模式默认提示词 'OCR this image. …' 正好踩这个坑）
    check('兜底到 DeepSeek-OCR 时换成官方提示词 <image>\\nFree OCR.',
      textOf(bodies[1]) === '<image>\nFree OCR.', `(${JSON.stringify(textOf(bodies[1]))})`);
    check('兜底到 PaddleOCR-VL 时用它的官方提示词 OCR:',
      textOf(bodies[2]) === 'OCR:', `(${JSON.stringify(textOf(bodies[2]))})`);
    check('兜底到 OCR 模型时丢掉对话历史（messages 只剩当前这条）',
      bodies[1].messages.length === 1 && bodies[2].messages.length === 1,
      `(OCR messages=${bodies[1].messages.length}/${bodies[2].messages.length})`);
    check('OCR 兜底模型不携带 enable_thinking（VL/OCR 收到会被 400）',
      bodies[1].enable_thinking === undefined && bodies[1].enable_search === undefined &&
      bodies[2].enable_thinking === undefined && bodies[2].enable_search === undefined,
      `(enable_thinking=${bodies[1].enable_thinking}/${bodies[2].enable_thinking})`);
    __resetUpstreamHealth();

    // 显式配置 IMAGE_FALLBACK_MODEL 时**覆盖**默认链（单值写法与旧版兼容），
    // 且 OCR 成功后要接文本模型作答（方案 B）——所以是 3 次调用：4B → OCR → 文本模型。
    __resetUpstreamHealth();
    const seen2 = [];
    const bodies2 = [];
    globalThis.fetch = async (url, opts) => {
      const b = JSON.parse(opts.body);
      seen2.push(b.model); bodies2.push(b);
      // 图片段（content 是数组）返回抠出来的文字；文本段返回回答
      const isImageStage = Array.isArray(b.messages[0].content);
      return seen2.length === 1 ? errRes(503) : okJson(isImageStage ? '余额 ¥0.9830' : '这段文字说的是账户余额。');
    };
    const res2 = await onRequestPost({
      request: mkReq(imgReq),
      env: { ...env, IMAGE_FALLBACK_MODEL: 'deepseek-ai/DeepSeek-OCR' }
    });
    check('显式配置 IMAGE_FALLBACK_MODEL 覆盖默认链，OCR 成功后接文本模型作答（方案 B）',
      res2.status === 200 && seen2.length === 3 &&
      seen2[0] === 'Qwen/Qwen3.5-4B' && seen2[1] === 'deepseek-ai/DeepSeek-OCR' &&
      seen2[2] === 'Qwen/Qwen3-8B',
      `(状态 ${res2.status}, 依次 ${seen2.join(' → ')})`);
    const stage2 = bodies2[2];
    const stage2User = stage2.messages[stage2.messages.length - 1];
    check('第二段：system 打头 + 保留对话历史 + 用户问题在 prompt 里',
      stage2.messages[0].role === 'system' && stage2.messages.length === 4 &&
      stage2User.role === 'user' && stage2User.content.includes('余额 ¥0.9830') &&
      stage2User.content.includes('看看这张图'),
      `(messages=${stage2.messages.length})`);
    check('第二段：OCR 文字用 【】 标注来源，避免模型当成自己的知识',
      /【[^】]*文字[^】]*】/.test(stage2User.content),
      `(${stage2User.content.slice(0, 24)}…)`);
    check('第二段：跳过刚挂掉的主模型，直接 8B 起步',
      !seen2.slice(2).includes('Qwen/Qwen3.5-4B'), `(${seen2.slice(2).join(', ')})`);
    __resetUpstreamHealth();
  }

  // ═══ 方案 B 的分流：OCR 模式"只提字"不过 LLM，"要加工"才过 ═══
  // 过一遍 LLM 有改写数字、丢掉整行的风险，医疗资料上不能忍；而"整理成表格"这类要求
  // OCR 模型根本执行不了（实测追加要求会让它死循环），只能交给文本模型。
  {
    const ocrReq = (content) => ({
      image: 'data:image/png;base64,AAAA', imageMode: 'ocr', stream: true,
      messages: [{ role: 'user', content }]
    });
    const setup = (ocrText) => {
      __resetUpstreamHealth();
      const seen = [];
      globalThis.fetch = async (url, opts) => {
        const b = JSON.parse(opts.body);
        seen.push(b.model);
        // 图片段（content 是数组）返回抠出来的文字；文本段返回整理结果
        return okJson(Array.isArray(b.messages[0].content) ? ocrText : '整理后的结果');
      };
      return seen;
    };

    // 注意：OCR 模式的主模型本身就是 OCR_MODEL(=DeepSeek-OCR)，与兜底链首个去重后只剩一个 OCR 候选，
    // 所以"纯提取"只有 1 次上游调用、"要加工"是 2 次（OCR + 文本模型）。
    let seen = setup('余额 0.9830');
    const r1 = await onRequestPost({ request: mkReq(ocrReq('帮我提取这张图里的文字')), env: { ...env, IMAGE_FALLBACK_MODEL: 'deepseek-ai/DeepSeek-OCR' } });
    const j1 = await r1.json();
    check('OCR 模式·纯提取：直接返回 OCR 原文，不调用任何 LLM',
      r1.status === 200 && seen.length === 1 && j1.choices[0].message.content === '余额 0.9830',
      `(上游 ${seen.length} 次, 正文 ${JSON.stringify(j1.choices[0].message.content)})`);

    seen = setup('余额 0.9830');
    const r2 = await onRequestPost({ request: mkReq(ocrReq('把这张图整理成表格')), env: { ...env, IMAGE_FALLBACK_MODEL: 'deepseek-ai/DeepSeek-OCR' } });
    check('OCR 模式·要求加工：交给文本模型处理（这解决了"用户原话被官方提示词顶掉"）',
      r2.status === 200 && seen.length === 2 && seen[1] === 'Qwen/Qwen3-8B',
      `(上游 ${seen.length} 次, 依次 ${seen.join(' → ')})`);

    seen = setup('');
    const r3 = await onRequestPost({ request: mkReq(ocrReq('帮我提取这张图里的文字')), env: { ...env, IMAGE_FALLBACK_MODEL: 'deepseek-ai/DeepSeek-OCR' } });
    const j3 = await r3.json();
    check('OCR 抠不出字：如实提示，不拿空文本去问模型',
      r3.status === 200 && seen.length === 1 && /识别返回为空/.test(j3.choices[0].message.content),
      `(上游 ${seen.length} 次)`);
    __resetUpstreamHealth();
  }

  // ═══ 识图路径必须也有超时：以前是裸 fetch，上游挂起会一直悬着 ═══
  // 识图默认是 3 候选链，超时**按候选类型**取：VLM 流式等首字节 5s（IMAGE_FIRST_BYTE_MS），
  // 两个 OCR 兜底是非流式、等整段生成 12s（IMAGE_OCR_TIMEOUT_MS）→ 最坏 ≈ 29s。
  // 这个上界必须留在前端 `config/ai-chat-config.js` 的 timeouts.firstByteMs(35s) 之内 ——
  // 往链里再加候选就会越界，本断言会立刻失败，逼你同步调前端预算。
  {
    __resetUpstreamHealth();
    globalThis.fetch = (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
    const t0 = Date.now();
    const res = await onRequestPost({
      request: mkReq({ image: 'data:image/png;base64,AAAA', imageMode: 'understand', stream: true, messages: [{ role: 'user', content: 'x' }] }),
      env
    });
    const dt = Date.now() - t0;
    check('识图上游全挂 → 在「5s + 12s + 12s = 29s」预算内返回错误（且 ≤ 前端 35s）',
      res.status === 500 && dt >= 28000 && dt < 33000,
      `(状态 ${res.status}, 耗时 ${dt}ms)`);
    __resetUpstreamHealth();
  }

  // ═══ 第二段（文本模型）全挂时不得丢掉已经抠到的文字 ═══
  // "有输出好过报错"：OCR 已经成功拿到文字，文本模型挂了也应该把文字交给用户，而不是回 500。
  {
    __resetUpstreamHealth();
    globalThis.fetch = async (url, opts) => {
      const b = JSON.parse(opts.body);
      if (b.model === 'Qwen/Qwen3.5-4B') return errRes(503);
      if (Array.isArray(b.messages[0].content)) return okJson('余额 0.9830');  // OCR 段成功
      return errRes(503);                                                     // 文本段全挂
    };
    const res = await onRequestPost({
      request: mkReq({
        image: 'data:image/png;base64,AAAA', imageMode: 'understand', stream: true,
        messages: [{ role: 'user', content: '这张图里有什么？' }]
      }),
      env: { ...env, IMAGE_FALLBACK_MODEL: 'deepseek-ai/DeepSeek-OCR' }
    });
    const j = await res.json();
    check('第二段全挂 → 退回 OCR 原文（不是 500）',
      res.status === 200 && j.choices[0].message.content === '余额 0.9830',
      `(状态 ${res.status}, 正文 ${JSON.stringify(j.choices?.[0]?.message?.content)})`);
    __resetUpstreamHealth();
  }

  // ═══ 识图降级后也要走知识库检索 ═══
  // 用户发一张 App 报错截图问"这个怎么解决"，答案就在 kb.md 里；不检索只能让 8B 凭常识瞎猜。
  // ⚠️ 本块必须放在**最后**：知识库是模块级缓存（KNOWLEDGE_BASE_CACHE），一旦加载就会影响后续用例。
  {
    __resetUpstreamHealth();
    __resetKnowledgeBaseCache();
    const KB_FIXTURE = [
      '# 测试知识库',
      '',
      '## 99. 设备绑定失败排查',
      '错误码 E204 表示设备绑定失败。处理办法：先在 App 里解绑设备，再重新绑定；若仍失败，重启蓝牙后重试。',
      ''
    ].join('\n');
    const stage2Bodies = [];
    globalThis.fetch = async (url, opts) => {
      const u = typeof url === 'string' ? url : String(url && url.url);
      if (u.includes('Markdown/kb.md')) return new Response(KB_FIXTURE, { status: 200 });
      const b = JSON.parse(opts.body);
      if (b.model === 'Qwen/Qwen3.5-4B') return errRes(503);            // 主 VLM 挂掉 → 走兜底
      if (Array.isArray(b.messages[0].content)) return okJson('错误码 E204 设备绑定失败'); // OCR 段
      stage2Bodies.push(b);                                            // 第二段：文本模型
      return okJson('请先在 App 里解绑设备再重新绑定。');
    };
    const res = await onRequestPost({
      request: mkReq({
        image: 'data:image/png;base64,AAAA', imageMode: 'understand', stream: true, injectKnowledge: true,
        messages: [{ role: 'system', content: '你是健康助手' }, { role: 'user', content: '这个怎么解决？' }]
      }),
      env: { ...env, IMAGE_FALLBACK_MODEL: 'deepseek-ai/DeepSeek-OCR' }
    });
    const sys = stage2Bodies.length ? stage2Bodies[0].messages[0].content : '';
    check('识图兜底后命中知识库：片段注入进了第二段的 system',
      res.status === 200 && stage2Bodies.length === 1 &&
      sys.includes('99. 设备绑定失败排查') && sys.includes('解绑设备'),
      `(状态 ${res.status}, system ${sys.length} 字)`);
    check('检索 query 用「用户原话 + OCR 文字」合成（两样都在）',
      stage2Bodies.length === 1 &&
      stage2Bodies[0].messages[1].content.includes('这个怎么解决') &&
      stage2Bodies[0].messages[1].content.includes('E204'),
      '');
    check('知识库注入带上了使用说明（防止编造型号/参数）',
      sys.includes('--- 使用说明 ---'), '');
    __resetUpstreamHealth();
  }

  // ═══ 识图降级不得改写业务规则：injectKnowledge=false 时不许检索 ═══
  // 前端「自动续写」刻意发 false（避免拿"请从中断处继续"去检索污染上下文），识图路径同样要守。
  {
    __resetUpstreamHealth();
    __resetKnowledgeBaseCache();   // 清掉缓存，下面 kbFetched 才是有意义的计数
    let kbFetched = 0;
    let stage2Body = null;
    globalThis.fetch = async (url, opts) => {
      const u = typeof url === 'string' ? url : String(url && url.url);
      if (u.includes('Markdown/kb.md')) { kbFetched++; return new Response('# 测试知识库\n\n## 1. 标题\n内容', { status: 200 }); }
      const b = JSON.parse(opts.body);
      if (b.model === 'Qwen/Qwen3.5-4B') return errRes(503);
      if (Array.isArray(b.messages[0].content)) return okJson('错误码 E204 设备绑定失败');
      stage2Body = b;
      return okJson('回答');
    };
    await onRequestPost({
      request: mkReq({
        image: 'data:image/png;base64,AAAA', imageMode: 'understand', stream: true, injectKnowledge: false,
        messages: [{ role: 'user', content: '这个怎么解决？' }]
      }),
      env: { ...env, IMAGE_FALLBACK_MODEL: 'deepseek-ai/DeepSeek-OCR' }
    });
    check('injectKnowledge=false → 识图第二段不检索知识库',
      kbFetched === 0 && stage2Body && !stage2Body.messages[0].content.includes('使用说明'),
      `(kb.md 请求 ${kbFetched} 次)`);
    __resetUpstreamHealth();
  }
}

// ═══ 4. 两个后端实现的常量一致性（重复代码，靠断言防漂移）═══
function testBackendParity() {
  console.log('\n═══ 4. 两个后端关键常量一致 ═══');
  const pages = fs.readFileSync(path.join(ROOT, 'functions', 'api', 'chat.js'), 'utf8');
  const worker = fs.readFileSync(path.join(ROOT, 'workers', 'index.js'), 'utf8');
  const grab = (src, name) => {
    const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*([^;]+);'));
    return m ? m[1].replace(/\s+/g, '') : null;
  };
  // 上游超时/故障转移/熔断常量必须两后端同步（一处改了另一处没改，两边行为会静默分叉）
  const names = ['MAX_MESSAGES', 'MAX_IMAGE_CHARS', 'MAX_BODY_BYTES', 'IMAGE_HISTORY_LIMIT',
    'IMAGE_HISTORY_MAX_CHARS', 'IMAGE_PROMPT_MAX_CHARS',
    'PRIMARY_FIRST_BYTE_MS', 'FALLBACK_FIRST_BYTE_MS', 'IMAGE_FIRST_BYTE_MS',
    'NON_STREAM_TIMEOUT_MS', 'MODEL_FAIL_THRESHOLD', 'MODEL_COOLDOWN_MS',
    'FALLBACK_MODEL_DEFAULT', 'IMAGE_MODEL_DEFAULT',
    'IMAGE_FALLBACK_MODELS_DEFAULT', 'IMAGE_FALLBACK_PROMPTS', 'OCR_PROCESS_HINT_RE',
    'OCR_TEXT_MAX_CHARS', 'OCR_ANSWER_SYSTEM', 'OCR_TIDY_SYSTEM', 'IMAGE_OCR_TIMEOUT_MS',
    'SECOND_FALLBACK_MODEL_DEFAULT', 'SECOND_FALLBACK_FIRST_BYTE_MS'];
  const bad = [];
  for (const n of names) {
    const a = grab(pages, n), b = grab(worker, n);
    if (!a || !b || a !== b) bad.push(`${n}(pages=${a}, worker=${b})`);
  }
  check('两后端关键常量一致', bad.length === 0, bad.length ? bad.join(' | ') : `(${names.length} 项)`);
}

(async () => {
  console.log('═══ AI 链路加固回归 ═══');
  testFormatContent();
  testTrim();
  await testChatHandler();
  testBackendParity();
  console.log(`\n总计 ${pass + fail} 项 | 通过 ${pass} | 失败 ${fail}`);
  if (fail) {
    console.log('❌ 存在失败项，加固可能被回退，请检查。');
    process.exit(1);
  }
  console.log('✅ 全部通过。');
})();
