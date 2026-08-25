// scripts/test-kb-retrieval.js — 知识库检索本地验证脚本（node scripts/test-kb-retrieval.js）
// 校验：切块统计、命中用例、不命中用例、追问兜底、注入段生成
const fs = require('fs');
const path = require('path');
const kb = require('../shared/kb-retrieval.js');

const KB_FILE = path.join(__dirname, '../Markdown/kb.md');
const text = fs.readFileSync(KB_FILE, 'utf8');
console.log('知识库文件大小:', text.length, '字符');

// ── 1. 切块统计 ──
const chunks = kb.buildChunks(text);
const sizes = chunks.map(c => c.text.length).sort((a, b) => a - b);
const sum = sizes.reduce((x, y) => x + y, 0);
console.log(`\n[切块] 共 ${chunks.length} 块 | 最小 ${sizes[0]} | 最大 ${sizes[sizes.length - 1]} | 平均 ${Math.round(sum / sizes.length)} 字符`);
console.log('[切块] 前 5 块标题:', chunks.slice(0, 5).map(c => c.title).join(' || '));
console.log('[切块] 目录是否跳过:', !chunks.some(c => /^目录/.test(c.title)) ? '是' : '否，异常!');
const big = chunks.filter(c => c.text.length > 1500);
console.log('[切块] 超过 1500 字符的块数:', big.length, big.length ? '（' + big.map(c => c.title).join('; ') + '）' : '');

// ── 2. 命中 / 不命中用例 ──
const cases = [
  '睡眠监测仪怎么连蓝牙？',
  '导航ROOM支持几个人？',
  '后台怎么创建机构账号？',
  '测评报告怎么看？',
  '你们有什么产品？',
  '促醒监护仪报警阈值是多少？',
  '你好',
  '今天天气怎么样',
  '谢谢',
  '产品知识库的目录',
  '睡眠',
  '你们有什么产品？',   // 泛化产品清单：应命中"产品体系总览"兜底
  '有哪些产品？'
];
console.log('\n[检索用例]（minScore=' + kb.KB_CONFIG_DEFAULTS.minScore + ', topK=' + kb.KB_CONFIG_DEFAULTS.topK + '）');
for (const q of cases) {
  const hits = kb.retrieve(q, chunks, kb.KB_CONFIG_DEFAULTS);
  const hitTitles = hits.length
    ? hits.map(h => `  ${h.score.toFixed(3)} ${h.chunk.title}`).join('\n')
    : '  （无命中，不注入）';
  console.log(`\nQ: ${q}\n${hitTitles}`);
}

// ── 3. 追问兜底 ──
const msgs = [
  { role: 'system', content: 'system-prompt' },
  { role: 'user', content: '睡眠监测仪怎么连蓝牙？' },
  { role: 'assistant', content: '蓝牙连接步骤：...' },
  { role: 'user', content: '那血氧呢？' }
];
const r = kb.buildKnowledgeInjection(msgs, text, kb.KB_CONFIG_DEFAULTS);
console.log('\n[追问兜底] 历史=睡眠监测仪蓝牙 → 追问"那血氧呢？"');
if (r.hits.length) {
  r.hits.forEach(h => console.log(`  命中: ${h.score.toFixed(3)} ${h.title}`));
  console.log('  注入段长度:', r.injection.length, '字符');
} else {
  console.log('  未命中');
}

// ── 4. 闲聊跳过 ──
const chatMsg = [{ role: 'user', content: '你好' }];
const r2 = kb.buildKnowledgeInjection(chatMsg, text, kb.KB_CONFIG_DEFAULTS);
console.log('\n[闲聊跳过] "你好" → 注入:', r2.injection ? '有（异常!）' : '无（正确）');

// ── 5. 产品清单兜底（完整流程） ──
for (const q of ['你们有什么产品？', '有哪些产品？', '介绍一下你们的产品']) {
  const r5 = kb.buildKnowledgeInjection([{ role: 'user', content: q }], text, kb.KB_CONFIG_DEFAULTS);
  console.log(`\n[产品清单兜底] "${q}"`);
  if (r5.hits.length) {
    r5.hits.forEach(h => console.log(`  命中: ${h.score.toFixed(3)} ${h.title}`));
  } else {
    console.log('  未命中（异常!）');
  }
}

// ── 5. 空知识库容错 ──
const r3 = kb.buildKnowledgeInjection([{ role: 'user', content: '睡眠监测仪怎么连蓝牙？' }], '');
console.log('[容错] 知识库为空 → 注入:', r3.injection ? '有（异常!）' : '无（正确）');
