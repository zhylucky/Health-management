#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// scripts/bench-models.js — 模型对照自测（真打 SiliconFlow，消耗少量额度）
//
// 目的：把「挂起」拆成四个可分别测量的量，避免把「生成慢」误判成「连接挂起」：
//   ttfb  首字节        —— 响应头/第一帧到达时间（连接是否健康）
//   ttfc  首个内容 token —— 用户真正开始看到字的时间（感知延迟）
//   gap   最长停顿       —— 相邻两帧之间的最大间隔（真正的"卡住"）
//   total 总时长         + 思考帧字数（reasoning_content，判断 enable_thinking 是否被忽略）
//
// 两格 prompt：短/寒暄（312 token）与 带知识库注入的长 prompt（2153 token，真实
// buildKnowledgeInjection 生成）。两格 × 两个模型，用来区分「模型坏了」还是「长 prompt 会卡」。
//
// 用法：NODE_NO_WARNINGS=1 NODE_USE_ENV_PROXY=1 node scripts/bench-models.js [每格轮数=3]
//   需 .dev.vars 内有 SILICONFLOW_API_KEY（只读取，不打印）
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const kb = require('../shared/kb-retrieval.js');

const ROOT = path.join(__dirname, '..');
const ENDPOINT = 'https://api.siliconflow.cn/v1/chat/completions';
const MODELS = ['Qwen/Qwen3.5-4B', 'Qwen/Qwen3-8B'];
const QUESTION = '睡眠监测的原理是什么';   // 本地实测命中 4 块，注入约 2.9k 字符

const IDLE_CAP_MS = 20000;    // 相邻帧间隔超过此值 = 真的卡住（生产前端空闲上限是 45s）
const TOTAL_CAP_MS = 45000;   // 无任何响应帧的上限：超过它在生产里也一定是失败（前端首字节上限 35s）
const MAX_TOKENS = 120;       // 生产典型答案长度

const RUNS = Math.max(1, parseInt(process.argv[2], 10) || 3);

function loadKey() {
  const raw = fs.readFileSync(path.join(ROOT, '.dev.vars'), 'utf8');
  const m = raw.match(/SILICONFLOW_API_KEY\s*=\s*(\S+)/);
  if (!m) throw new Error('.dev.vars 里没找到 SILICONFLOW_API_KEY');
  return m[1];
}

function buildShapes() {
  const kbText = fs.readFileSync(path.join(ROOT, 'Markdown', 'kb.md'), 'utf8');
  const sys = kb.GENERAL_SYSTEM_PROMPT;
  const shortMessages = [
    { role: 'system', content: sys },
    { role: 'user', content: '你好' }
  ];
  const longMessages = [
    { role: 'system', content: sys },
    { role: 'user', content: QUESTION }
  ];
  const { injection, hits } = kb.buildKnowledgeInjection(longMessages, kbText, kb.KB_CONFIG_DEFAULTS);
  if (!injection) throw new Error(`问题「${QUESTION}」没命中知识库，无法构造长 prompt`);
  longMessages[0].content += injection;

  return {
    hits: hits.map(h => h.title),
    shapes: [
      { name: '短/寒暄', messages: shortMessages },
      { name: '长/KB命中', messages: longMessages }
    ].map(s => ({
      ...s,
      tokens: kb.estimateTokens(s.messages.map(m => m.content).join(''))
    }))
  };
}

function bodyFor(model, messages, disableThinking) {
  const body = {
    model,
    messages,
    stream: true,
    max_tokens: MAX_TOKENS,
    temperature: 0.5,
    top_p: 0.8,
    presence_penalty: 0.2,
    frequency_penalty: 0.3
  };
  if (model.includes('Qwen')) {
    body.enable_search = false;
    if (disableThinking) body.enable_thinking = false;
  }
  return body;
}

async function probe(apiKey, model, messages, disableThinking) {
  const ac = new AbortController();
  const t0 = Date.now();
  let timer = null;
  let abortReason = null;
  let ttfb = null, ttfc = null, chars = 0, reasoning = 0, frames = 0;
  let lastFrameAt = t0, maxGap = 0;

  const arm = (ms, reason) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { abortReason = reason; ac.abort(); }, ms);
  };
  const markFrame = () => {
    const now = Date.now();
    if (frames > 0) maxGap = Math.max(maxGap, now - lastFrameAt);
    lastFrameAt = now; frames++;
    arm(IDLE_CAP_MS, 'idle');   // 每个数据帧都重置空闲计时
  };

  try {
    arm(TOTAL_CAP_MS, 'total');
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(bodyFor(model, messages, disableThinking)),
      signal: ac.signal
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      if (timer) clearTimeout(timer);
      return { status: resp.status, err: `HTTP ${resp.status} ${txt.slice(0, 120)}`, total: Date.now() - t0 };
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (ttfb === null) ttfb = Date.now() - t0;
      markFrame();
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const delta = (j.choices && j.choices[0] && j.choices[0].delta) || {};
          if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content.length;
          if (typeof delta.content === 'string' && delta.content) {
            if (ttfc === null) ttfc = Date.now() - t0;
            chars += delta.content.length;
          }
        } catch (e) { /* 非 JSON 帧 */ }
      }
    }
    if (timer) clearTimeout(timer);
    return { status: 200, ttfb, ttfc, total: Date.now() - t0, chars, reasoning, frames, maxGap };
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (e.name === 'AbortError') {
      return {
        status: 0, ttfb, ttfc, total: Date.now() - t0, chars, reasoning, frames, maxGap,
        err: abortReason === 'idle'
          ? `卡住：${maxGap}ms 无数据（已收 ${chars} 字）`
          : ttfb === null
            ? `无任何响应（${TOTAL_CAP_MS}ms 零字节，连接挂起）`
            : `超总上限 ${TOTAL_CAP_MS}ms（已收 ${chars} 字）`
      };
    }
    return { status: 0, err: e.message, total: Date.now() - t0 };
  }
}

const median = (a) => {
  const s = a.filter(v => typeof v === 'number' && v > 0).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const fmt = (v) => (v === null || v === undefined ? '—' : `${v}ms`);

(async () => {
  const apiKey = loadKey();
  const { shapes, hits } = buildShapes();

  console.log('═══ 模型对照自测（真打 SiliconFlow）═══');
  console.log(`每格 ${RUNS} 轮｜max_tokens=${MAX_TOKENS}｜空闲判定 ${IDLE_CAP_MS}ms`);
  console.log(`长 prompt 命中：${hits.join(' | ')}`);
  for (const s of shapes) console.log(`  ${s.name}: ≈${s.tokens} token`);
  console.log(`代理 HTTPS_PROXY=${process.env.HTTPS_PROXY || '(none)'}\n`);

  const rows = [];
  for (const model of MODELS) {
    for (const shape of shapes) {
      for (let i = 0; i < RUNS; i++) {
        const r = await probe(apiKey, model, shape.messages, true);
        rows.push({ model, shape: shape.name, run: i + 1, ...r });
        const tag = r.status === 200
          ? `200 首字节 ${fmt(r.ttfb)}｜首内容 ${fmt(r.ttfc)}｜总 ${fmt(r.total)}｜${r.chars}字${r.reasoning ? `(思考${r.reasoning})` : ''}｜最长停顿 ${fmt(r.maxGap)}`
          : `${r.err}`;
        console.log(`  ${model.padEnd(16)} ${shape.name.padEnd(10)} #${i + 1}  ${tag}`);
      }
      const ok = rows.filter(r => r.model === model && r.shape === shape.name && r.status === 200);
      console.log(`  └ 成功 ${ok.length}/${RUNS}｜首内容中位 ${fmt(median(ok.map(r => r.ttfc)))}｜总时长中位 ${fmt(median(ok.map(r => r.total)))}｜最长停顿中位 ${fmt(median(ok.map(r => r.maxGap)))}\n`);
    }
  }

  console.log('═══ 判定 ═══');
  for (const model of MODELS) {
    for (const shape of shapes) {
      const cells = rows.filter(r => r.model === model && r.shape === shape.name);
      const ok = cells.filter(r => r.status === 200);
      console.log(`  ${model.padEnd(16)} ${shape.name.padEnd(10)} ${ok.length === RUNS ? '全部正常' : ok.length === 0 ? '全部失败' : `${ok.length}/${RUNS} 成功`}`);
    }
  }
  const stalled = rows.filter(r => r.status === 0);
  if (stalled.length) {
    console.log(`\n失败明细（${stalled.length} 格）：`);
    for (const r of stalled) console.log(`  ${r.model} / ${r.shape} #${r.run}: ${r.err}`);
  }
  const thinking = rows.filter(r => (r.reasoning || 0) > 0);
  console.log(`\n思考帧：${thinking.length ? `${thinking.length} 格出现了 reasoning_content（enable_thinking:false 未被遵守）` : '未出现（enable_thinking:false 生效）'}`);
})().catch(e => { console.error('自测失败：' + e.message); process.exit(1); });
