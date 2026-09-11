#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// scripts/test-ai-hardening.js — AI 链路加固回归测试（零依赖，node 直跑）
//
// 覆盖 2026-09-11 加固的四部分，防止将来被改回去：
//   1. js/ai-chat.js formatContent 的链接渲染不得产生 HTML 属性注入 / 危险协议 / 外站跳转
//   2. shared/kb-retrieval.js trimMessagesToBudget 必须 O(n) 且与旧实现语义等价
//   3. functions/api/chat.js 的请求上限、识图历史、重试策略
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
  const { onRequestPost } = await import(
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
    let calls = 0;
    globalThis.fetch = async () => { calls++; return responder(calls); };
    const res = await onRequestPost({ request: mkReq(chatBody), env });
    check(label, res.status === expectStatus && calls === expectCalls,
      `(状态 ${res.status}, 上游 ${calls} 次)`);
  };
  const errRes = (c) => new Response('upstream error', { status: c });
  await retryCase('4xx 不重试（400）', () => errRes(400), 400, 1);
  await retryCase('4xx 不重试（429）', () => errRes(429), 429, 1);
  await retryCase('5xx 重试 3 次后 504', () => errRes(503), 504, 3);
  await retryCase('5xx 后成功 → 200', (n) => (n < 3 ? errRes(503) : okJson()), 200, 3);
  await retryCase('200 但非 JSON → 502', () => new Response('not json', { status: 200 }), 502, 1);
  // 读 body 失败属于网络层：必须和 fetch 失败一样可重试
  await retryCase('body 读取失败 → 重试 3 次后 504',
    () => new Response(new ReadableStream({ start(c) { c.error(new Error('body broken')); } }), { status: 200 }),
    504, 3);
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
  const names = ['MAX_MESSAGES', 'MAX_IMAGE_CHARS', 'IMAGE_HISTORY_LIMIT', 'IMAGE_HISTORY_MAX_CHARS', 'IMAGE_PROMPT_MAX_CHARS'];
  const bad = [];
  for (const n of names) {
    const a = grab(pages, n), b = grab(worker, n);
    if (!a || !b || a !== b) bad.push(`${n}(pages=${a}, worker=${b})`);
  }
  if (grab(pages, 'maxRetries') !== grab(worker, 'maxRetries')) {
    bad.push(`maxRetries(pages=${grab(pages, 'maxRetries')}, worker=${grab(worker, 'maxRetries')})`);
  }
  check('两后端关键常量一致', bad.length === 0, bad.length ? bad.join(' | ') : `(${names.length + 1} 项)`);
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
