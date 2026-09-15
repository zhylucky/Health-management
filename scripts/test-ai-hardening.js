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
  const { onRequestPost, __resetUpstreamHealth } = await import(
    'file://' + path.join(ROOT, 'functions', 'api', 'chat.js').replace(/\\/g, '/')
  );

  const env = { SILICONFLOW_API_KEY: 'sk-test-not-real' };
  const mkReq = (body) => ({ json: async () => body, url: 'https://health.bbroot.com/api/chat' });
  let captured = null;
  const okJson = () => new Response(
    JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
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
  await retryCase('5xx 换备用模型后仍失败 → 504', () => errRes(503), 504, 2);
  await retryCase('5xx 后换备用模型成功 → 200', (n) => (n === 1 ? errRes(503) : okJson()), 200, 2);
  await retryCase('200 但非 JSON → 502', () => new Response('not json', { status: 200 }), 502, 1);
  // 读 body 失败：不再重试。首字节之后的中断发生在"已经生成内容"的阶段，且此刻换模型
  // 重发会把已生成的半截内容作废；前端默认走流式（本分支只是兜底路径），直接报错更可预测。
  await retryCase('body 读取失败 → 504（不重试）',
    () => new Response(new ReadableStream({ start(c) { c.error(new Error('body broken')); } }), { status: 200 }),
    504, 1);
  // 主备同名（未配 FALLBACK_MODEL / 主模型就是备用模型）时不得"假装故障转移"：
  // 只有一个候选，上游 5xx 就该 1 次调用直接 504（用 8B 当主模型即可复现同名场景）。
  {
    __resetUpstreamHealth();
    let calls = 0;
    globalThis.fetch = async () => { calls++; return errRes(503); };
    const res = await onRequestPost({ request: mkReq({ ...chatBody, model: 'Qwen/Qwen3-8B' }), env });
    check('主模型=备用模型时 → 只调用 1 次并 504', res.status === 504 && calls === 1,
      `(状态 ${res.status}, 上游 ${calls} 次)`);
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
    check('识图默认模型是 VLM 且不携带 enable_thinking',
      vlBody.model === 'Qwen/Qwen3-VL-8B-Instruct' && vlBody.enable_thinking === undefined && vlBody.enable_search === undefined,
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

  // ═══ 识图必须能自愈：生产的 IMAGE_MODEL 可能被 env 显式设成坏模型，覆盖代码默认值 ═══
  // 这时只能靠 IMAGE_MODEL_DEFAULT 充当兜底 VLM，否则"改了默认值也不生效"。
  {
    __resetUpstreamHealth();
    const seen = [];
    globalThis.fetch = async (url, opts) => {
      const b = JSON.parse(opts.body);
      seen.push(b.model);
      return seen.length === 1 ? errRes(503) : okJson();
    };
    const res = await onRequestPost({
      request: mkReq({ image: 'data:image/png;base64,AAAA', imageMode: 'understand', stream: true, messages: [{ role: 'user', content: 'x' }] }),
      env: { ...env, IMAGE_MODEL: 'Qwen/Qwen3.5-4B' }
    });
    check('识图主模型 5xx → 自动换到 VLM 兜底',
      res.status === 200 && seen.length === 2 &&
      seen[0] === 'Qwen/Qwen3.5-4B' && seen[1] === 'Qwen/Qwen3-VL-8B-Instruct',
      `(状态 ${res.status}, 依次 ${seen.join(' → ')})`);
    __resetUpstreamHealth();
  }

  // ═══ 识图路径必须也有超时：以前是裸 fetch，上游挂起会一直悬着 ═══
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
    check('识图上游挂起 → 10s 内返回错误（不再无限悬挂）',
      res.status === 500 && dt >= 9000 && dt < 14000,
      `(状态 ${res.status}, 耗时 ${dt}ms)`);
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
    'FALLBACK_MODEL_DEFAULT', 'IMAGE_MODEL_DEFAULT'];
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
