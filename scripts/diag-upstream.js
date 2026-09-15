#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// scripts/diag-upstream.js — 判定「上游/平台故障」还是「我方请求问题」（零依赖，只读诊断）
//
// 背景：2026-09-15 `Qwen/Qwen3.5-4B` 出现间歇性零字节挂起，当时很难判断是平台问题
// 还是请求参数问题。本脚本把当时的排除法固化下来，一条命令给结论。
//
// 三步法：
//   1) 对照模型（默认 Qwen/Qwen3-8B）发最小请求 → 正常即说明 key / 额度 / 网络都没问题
//   2) 疑似模型发**最小请求**（纯文本 + max_tokens=1）→ 零字节挂起 = 与请求形状无关
//   3) 疑似模型发**生产形状请求**（temperature/top_p/enable_* 等）→ 两者都挂 = 该模型部署的问题
//
// 判读规则：**4xx 且带 message 才是我方请求/参数问题**（例如给文本模型发图片会回
// `The model is not a VLM`——这恰恰说明图片载荷本身是合法的）；
// 零字节挂起（连响应头都没有）= 平台侧该模型不可用。
//
// 用法：
//   node scripts/diag-upstream.js                    # 诊断默认的免费模型（4B / 8B）
//   node scripts/diag-upstream.js 模型A 模型B          # 诊断指定模型
//   node scripts/diag-upstream.js --image 模型X       # 发一张真实 PNG，判断能否识图
//   node scripts/diag-upstream.js --runs 3 --cap 20000 模型X
// 需 .dev.vars 内有 SILICONFLOW_API_KEY（只读取、不打印）。一次诊断消耗个位数请求。
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const ENDPOINT = 'https://api.siliconflow.cn/v1/chat/completions';
const CONTROL_MODEL = 'Qwen/Qwen3-8B';          // 已知可用的对照模型（免费）
const DEFAULT_SUSPECTS = ['Qwen/Qwen3.5-4B'];   // 默认要诊断的模型

// ── 参数解析 ──
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  if (i === -1) return def;
  const v = argv[i + 1];
  argv.splice(i, v && !v.startsWith('--') ? 2 : 1);
  return v === undefined ? true : v;
};
const withImage = !!flag('--image', false);
const runs = Math.max(1, parseInt(flag('--runs', '1'), 10) || 1);
const capMs = Math.max(3000, parseInt(flag('--cap', '15000'), 10) || 15000);
const models = argv.filter(a => !a.startsWith('--'));
const suspects = models.length ? models : DEFAULT_SUSPECTS;

function loadKey() {
  const raw = fs.readFileSync(path.join(ROOT, '.dev.vars'), 'utf8');
  const m = raw.match(/SILICONFLOW_API_KEY\s*=\s*(\S+)/);
  if (!m) throw new Error('.dev.vars 里没找到 SILICONFLOW_API_KEY');
  return m[1];
}

// 生成一张合法的 64×64 纯色 PNG（手搓，避免依赖；之前用错的 base64 会被上游拒为 broken PNG）
function makePng() {
  const crc32 = (buf) => {
    let c, crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = (crc ^ buf[i]) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const w = 64, h = 64, ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = [];
  for (let y = 0; y < h; y++) {
    raw.push(Buffer.from([0]));
    for (let x = 0; x < w; x++) raw.push(Buffer.from([30, 90, 200]));
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(raw))), chunk('IEND', Buffer.alloc(0))
  ]);
  return 'data:image/png;base64,' + png.toString('base64');
}

// 最小请求：只有 model / messages / max_tokens
const minimalBody = (model) => ({
  model, max_tokens: 1,
  messages: [{ role: 'user', content: '你好' }]
});
// 生产形状：与 functions/api/chat.js 的 requestBody 同参数（含 Qwen 文本模型的两个开关）
const productionBody = (model) => {
  const b = {
    model, stream: false, max_tokens: 20, temperature: 0.5, top_p: 0.8,
    presence_penalty: 0.2, frequency_penalty: 0.3,
    messages: [{ role: 'user', content: '你好' }]
  };
  if (/^Qwen\//i.test(model) && !/-VL-|omni|OCR/i.test(model)) {
    b.enable_search = false;
    b.enable_thinking = false;
  }
  return b;
};
const imageBody = (model) => {
  const b = {
    model, stream: false, max_tokens: 30, temperature: 0.4, top_p: 0.8,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: makePng() } },
        { type: 'text', text: '这张图是什么颜色？只回答颜色' }
      ]
    }]
  };
  // 与生产同规则（functions/api/chat.js 的 applyModelFlags）：两个开关只给「Qwen 文本模型」，
  // VL/Omni/OCR 收到 enable_thinking 会直接 400 —— 否则诊断会给 VLM 一个假的 400，
  // 被误读成"图片载荷不合法"。**这段必须与 productionBody 的判据保持一致。**
  if (/^Qwen\//i.test(model) && !/-VL-|omni|OCR/i.test(model)) {
    b.enable_search = false;
    b.enable_thinking = false;
  }
  return b;
};

async function probe(key, body) {
  const ac = new AbortController();
  const t0 = Date.now();
  const timer = setTimeout(() => ac.abort(), capMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    const txt = await res.text();
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (res.ok) {
      let content = '';
      try { content = JSON.parse(txt).choices[0].message.content || ''; } catch (e) { }
      return { kind: 'ok', ms, content: content.replace(/\s+/g, ' ').slice(0, 40) };
    }
    let msg = txt.replace(/\s+/g, ' ').slice(0, 150);
    return { kind: 'status', status: res.status, ms, msg };
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') return { kind: 'hang', ms: Date.now() - t0 };
    return { kind: 'error', ms: Date.now() - t0, msg: e.message };
  }
}

const describe = (r) => r.kind === 'ok' ? `200 正常 ${r.ms}ms${r.content ? ' 「' + r.content + '」' : ''}`
  : r.kind === 'hang' ? `⚠️ 零字节挂起（>${capMs}ms 无任何响应）`
    : r.kind === 'status' ? `HTTP ${r.status} ${r.msg}`
      : `请求异常：${r.msg}`;

(async () => {
  const key = loadKey();
  console.log('═══ 上游诊断：平台问题 还是 我方请求问题 ═══');
  console.log(`形状：${withImage ? '图片请求（真 PNG）' : '文本请求'}｜每格 ${runs} 次｜单次上限 ${capMs}ms\n`);

  // 预热：本机代理/连接的首个请求实测偶发挂起（与模型无关），先打一发丢弃的请求，
  // 否则它会被误判成"对照模型也不正常"。
  console.log(`【预热·结果丢弃】${CONTROL_MODEL}（排除本机代理首连抖动）`);
  for (let i = 1; i <= 3; i++) {
    const r = await probe(key, minimalBody(CONTROL_MODEL));
    console.log(`  #${i}  ${describe(r)}`);
    if (r.kind === 'ok') break;
  }
  console.log('');

  const stats = new Map();   // model -> { ok, hang, status, error, samples: [] }
  const record = (model, r) => {
    const s = stats.get(model) || { ok: 0, hang: 0, status: 0, error: 0, samples: [] };
    s[r.kind] = (s[r.kind] || 0) + 1;
    s.samples.push(r);
    stats.set(model, s);
  };

  console.log(`【对照】${CONTROL_MODEL} 最小请求`);
  for (let i = 1; i <= runs; i++) {
    const r = await probe(key, minimalBody(CONTROL_MODEL));
    record(CONTROL_MODEL, r);
    console.log(`  #${i}  ${describe(r)}`);
  }

  for (const model of suspects) {
    console.log(`\n【疑似】${model}`);
    const shapes = withImage
      ? [['图片请求', imageBody(model)]]
      : [['最小请求(纯文本, max_tokens=1)', minimalBody(model)], ['生产形状请求', productionBody(model)]];
    for (const [label, body] of shapes) {
      for (let i = 1; i <= runs; i++) {
        const r = await probe(key, body);
        record(model, r);
        console.log(`  ${label.padEnd(30)} #${i}  ${describe(r)}`);
      }
    }
  }

  const control = stats.get(CONTROL_MODEL) || { ok: 0 };
  const total = (s) => (s.ok || 0) + (s.hang || 0) + (s.status || 0) + (s.error || 0);

  console.log('\n═══ 成功率 ═══');
  for (const [model, s] of stats) {
    console.log(`  ${model.padEnd(28)} 成功 ${s.ok || 0}/${total(s)}｜零字节挂起 ${s.hang || 0}｜4xx ${s.status || 0}｜异常 ${s.error || 0}`);
  }

  console.log('\n═══ 结论 ═══');
  if (!control.ok) {
    console.log('  ❌ 对照模型也不正常 → 问题在 key / 额度 / 网络 / 平台整体，不在被诊断的模型。');
    console.log('     先查账户余额与控制台（402=账户欠费；401=key 无效；429=触发 rate limits，会说明是 RPM/RPD/TPM/TPD）。');
  } else {
    for (const model of suspects) {
      const s = stats.get(model) || { ok: 0 };
      const n = total(s);
      // 必须把 4xx 排除在“成功”之外：否则模型不存在（400 Model does not exist）也会被印成
      // 「✅ 可识图（0/2 成功）」——自相矛盾，还盖掉下面真正的 message 判读。
      if (!s.hang && !s.error && !s.status) {
        console.log(`  ✅ ${model}：${withImage ? '可识图' : '正常'}（${s.ok}/${n} 成功）。`);
      } else if (s.status) {
        console.log(`  ⚠️ ${model}：${s.ok || 0}/${n} 成功，${s.status} 次被上游拒绝（4xx/5xx）——`);
        console.log('     这不是"平台崩了"，是请求/参数/账户或**模型 ID 不存在**，看下面的 message。');
      } else if ((s.ok || 0) === 0) {
        console.log(`  🔴 ${model}：${n} 次全部零字节挂起，而对照模型 ${control.ok} 次正常 → **平台侧该模型不可用**，`);
        console.log('     不是你的代码/参数/key。处理：等平台恢复，或换模型（换之前先确认是否免费）。');
      } else {
        console.log(`  🟡 ${model}：${s.ok}/${n} 成功 —— **间歇性故障**（平台侧）。`);
        console.log('     这正是"之前可行、现在时好时坏"的成因；建议稍后再跑一次确认，别据此改代码。');
      }
    }
    const paramIssue = [...stats.entries()].flatMap(([m, s]) => s.samples
      .filter(r => r.kind === 'status' && r.status < 500).map(r => ({ m, r })));
    if (paramIssue.length) {
      console.log('\n  ⚠️ 同时出现 4xx（带 message）—— 那部分才是**我方请求/参数或账户**问题，按 message 修正：');
      for (const { m, r } of paramIssue.slice(0, 4)) console.log(`     ${m} → HTTP ${r.status} ${r.msg}`);
      console.log('     例：给文本模型发图片会回 "The model is not a VLM"，说明图片载荷本身合法，是选错了模型。');
    }
  }
})().catch(e => { console.error('诊断失败：' + e.message); process.exit(1); });
