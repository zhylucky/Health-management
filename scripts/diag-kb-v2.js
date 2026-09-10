// scripts/diag-kb-v2.js — 知识库检索体检脚本
// 用法：node scripts/diag-kb-v2.js [知识库md路径]
// 默认体检部署用的 Markdown/kb.md；传入新版本路径可对比新旧表现。
// 输出：体积/切块统计、检索命中、产品清单兜底是否失效。
const fs = require('fs');
const path = require('path');
const kb = require('../shared/kb-retrieval.js');

const DEFAULT_KB = path.join(__dirname, '../Markdown/kb.md');
const files = process.argv[2]
  ? [[process.argv[2], fs.readFileSync(process.argv[2], 'utf8')]]
  : [[DEFAULT_KB, fs.readFileSync(DEFAULT_KB, 'utf8')]];

const est = t => {
  const cjk = (t.match(/[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  return cjk + Math.ceil((t.length - cjk) / 4);
};

const CASES = [
  '睡眠监测仪怎么充电？', '脑电监测仪怎么贴？', 'App连不上设备怎么办', '为什么没生成报告',
  '导航ROOM支持几个人', '矩阵式系统能用多久', '促醒监护仪心率报警上限是多少',
  '产品符合哪些EMC标准', '后台默认账号是什么', 'App在哪里下载',
  '主机防水等级是多少', '清洁皮肤用多少度酒精', '睡眠监测仪能用多久（寿命）',
  '血氧测不出来怎么办', '小程序叫什么名字', '主机重量多少', '体温报警阈值',
  '设备怎么跨机构转移', '导航要多久', '睡眠监测仪适用儿童吗'
];

for (const [file, text] of files) {
  const chunks = kb.buildChunks(text);
  const sizes = chunks.map(c => c.text.length).sort((a, b) => a - b);
  console.log(`\n${'='.repeat(60)}\n${file}\n${'='.repeat(60)}`);
  console.log(`体积: ${text.length} 字符 / 约 ${est(text)} token`);
  console.log(`切块: ${chunks.length} 块 | 最小 ${sizes[0]} | 中位 ${sizes[sizes.length >> 1]} | 最大 ${sizes[sizes.length - 1]}`);

  // 结构假设体检：产品清单兜底依赖存在以「二、产品体系总览」开头的块（前缀匹配）
  const overviewHit = chunks.find(c => c.title.indexOf('二、产品体系总览') === 0);
  console.log(`\n[结构假设] 产品清单兜底目标块: ${overviewHit ? overviewHit.title : '无 ← 兜底失效!'}`);
  console.log(`[结构假设] 噪声章降权命中: ${chunks.filter(c => /已知差异|待确认/.test(c.title)).map(c => c.title).join(' | ') || '无'}`);

  console.log('\n[产品清单兜底]');
  for (const q of ['你们有什么产品？', '有哪些产品？', '介绍一下你们的产品']) {
    const r = kb.buildKnowledgeInjection([{ role: 'user', content: q }], text, kb.KB_CONFIG_DEFAULTS);
    console.log(`  "${q}" -> ${r.hits.length ? r.hits.map(h => h.title.slice(0, 30)).join(' ; ') : '未命中'}`);
  }

  console.log('\n[检索命中] top-4 / minScore 0.18');
  for (const q of CASES) {
    const hits = kb.retrieve(q, chunks, kb.KB_CONFIG_DEFAULTS);
    console.log(`\n  Q: ${q}`);
    if (!hits.length) console.log('     x 无命中（降级通用模型，不带知识库）');
    hits.forEach(h => console.log(`     ${h.score.toFixed(3)}  ${h.chunk.title}`));
  }
}
