// scripts/kb-selftest.js — AI 助手回答自测
// 跑真实检索管线：对每个自测问法取 buildKnowledgeInjection 的实际注入命中，
// 检查「标准答案所在小节」是否被检索到（决定助手能否答对），并把命中清单落盘供人工核对。
// 用法：node scripts/kb-selftest.js
const fs = require('fs');
const path = require('path');
const kb = require('../shared/kb-retrieval.js');

const KB = path.join(__dirname, '../Markdown/kb.md');
const text = fs.readFileSync(KB, 'utf8');

// gold = 该问法在知识库中的权威依据小节；命中即认为助手有机会答对
// gold 为 null 表示知识库无此信息，期望助手如实说"暂未提供"而非编造
const CASES = [
  // ── 核心知识点 ──
  { id: 1,  cat: '核心', q: '你们有哪些产品？',                     gold: ['2.1 产品清单'] },
  { id: 2,  cat: '核心', q: '睡眠监测仪适用于儿童吗？',             gold: ['4.1 产品概述'] },
  { id: 3,  cat: '核心', q: '主机的预期使用寿命是多久？',           gold: ['16.6 预期使用寿命'] },
  { id: 4,  cat: '核心', q: '促醒监护仪心率报警上限是多少？',       gold: ['10.3 监测配置与报警阈值'] },
  { id: 5,  cat: '核心', q: 'App 在哪里下载？',                     gold: ['F. 账号与下载'] },
  { id: 6,  cat: '核心', q: '后台管理系统默认账号是什么？',         gold: ['F. 账号与下载', '13.4 安全与访问控制'] },
  { id: 7,  cat: '核心', q: '主机充满电能连续用多久？',             gold: ['C. 参数与指标', '3.1 通用硬件'] },
  { id: 8,  cat: '核心', q: '为什么测评完没有生成报告？',           gold: ['B. 报告生成'] },
  { id: 9,  cat: '核心', q: '你们的公司地址在哪里？厂家是谁？',   gold: ['一、公司概况'] },

  // ── 边界情况 ──
  { id: 10, cat: '边界', q: '脉搏血氧仪测不出血氧怎么办？',         gold: ['16.8 常见故障及排除'] },
  { id: 11, cat: '边界', q: '这个设备能用来诊断疾病吗？',           gold: ['16.3 免责声明'] },
  { id: 12, cat: '边界', q: '孕妇可以使用睡眠监测仪吗？',           gold: null },
  { id: 13, cat: '边界', q: '睡眠监测仪一台多少钱？',               gold: null },
  { id: 14, cat: '边界', q: '今天天气怎么样？',                     gold: null },
  { id: 15, cat: '边界', q: '设备的保修期是多久？',                 gold: ['16.7 质量保证'] },

  // ── 易混淆场景 ──
  { id: 16, cat: '易混', q: '睡眠监测仪和睡眠呼吸监测仪有什么区别？', gold: ['2.1 产品清单', '4.1 产品概述', '5.1 产品概述'] },
  { id: 17, cat: '易混', q: '你们的 App 都叫什么名字？',            gold: ['2.2 产品—软件—应用名称对照表'] },
  { id: 18, cat: '易混', q: '产品主机有多重？尺寸多大？',           gold: ['3.1 通用硬件'] },
  { id: 19, cat: '易混', q: '导航ROOM最多支持多少人同时使用？',     gold: ['C. 参数与指标', '2.1 产品清单', '7.3 核心功能模块'] },
  { id: 20, cat: '易混', q: '清洁皮肤应该用多少度的酒精？',         gold: ['D. 佩戴与皮肤'] },
  { id: 21, cat: '易混', q: '设备怎么从一个机构转到另一个机构？',   gold: ['A. 设备连接与绑定', '13.3 设备全生命周期流程'] },
  { id: 22, cat: '易混', q: '矩阵式生命潮生物反馈系统能用多久？',   gold: ['16.6 预期使用寿命'] }
];

// ── 前置断言:硬编码章节目标是否仍存在于当前 kb.md ──
// KB_ROUTES / NO_SPLIT_TITLES / 免责正则 / 产品清单兜底都直接依赖 kb.md 的标题文字。
// 知识库改标题时它们会静默失效(不报错,只是检索悄悄变差),人工很难发现,
// 故在此断言:每条路由目标、每个白名单条目都必须解析到 ≥1 个块,否则直接退出。
const chunkTitles = kb.buildChunks(text).map(c => c.title);
const brokenTargets = [];
for (const r of kb.KB_ROUTES) {
  for (const t of r.targets) {
    if (!chunkTitles.some(x => x.includes(t))) brokenTargets.push(`KB_ROUTES「${r.hint}」目标 ${JSON.stringify(t)} 已不存在`);
  }
}
for (const t of kb.NO_SPLIT_TITLES) {
  if (!chunkTitles.some(x => x.includes(t))) brokenTargets.push(`NO_SPLIT_TITLES 条目 ${JSON.stringify(t)} 已不存在`);
}
if (!chunkTitles.some(t => /16\.3.*免责/.test(t))) brokenTargets.push('16.3 免责声明块未找到(免责常驻将失效)');
if (!chunkTitles.some(t => t.indexOf('二、产品体系总览') === 0)) brokenTargets.push('产品清单兜底目标「二、产品体系总览 > …」未找到');

if (brokenTargets.length) {
  console.error('[硬编码目标失效] kb.md 标题已改动,请同步维护 shared/kb-retrieval.js:');
  for (const b of brokenTargets) console.error('  ★ ' + b);
  process.exit(1);
}
console.log(`[前置断言] 硬编码目标全部存活:${kb.KB_ROUTES.length} 条路由 / ${kb.NO_SPLIT_TITLES.length} 条白名单 / 免责正则 / 产品清单兜底`);
console.log(`[前置断言] 当前 kb.md 切块 ${chunkTitles.length} 块\n`);

let hitCount = 0, goldCases = 0, noHitCount = 0;
const rows = [];

for (const c of CASES) {
  const r = kb.buildKnowledgeInjection([{ role: 'user', content: c.q }], text, kb.KB_CONFIG_DEFAULTS);
  const titles = r.hits.map(h => h.title);
  let status;
  if (r.hits.length === 0) {
    noHitCount++;
    status = c.gold === null ? 'OK(未注入→通用模式)' : 'MISS(未命中)';
  } else if (c.gold === null) {
    status = 'NOISE(应无依据却注入)';
  } else {
    goldCases++;
    const ok = c.gold.some(g => titles.some(t => t.includes(g)));
    if (ok) hitCount++;
    status = ok ? 'OK(命中依据)' : 'MISS(未命中依据)';
  }
  rows.push({ ...c, status, titles, n: r.hits.length });
}

console.log('自测问题\t类别\t期望依据\t检索结果\t命中数\t实际命中小节');
for (const r of rows) {
  console.log([
    `Q${r.id} ${r.q}`,
    r.cat,
    r.gold ? r.gold.join(' 或 ') : '（知识库无此信息）',
    r.status,
    r.n,
    r.titles.map(t => t.replace(/^.*?>\s*/, '')).join(' | ') || '—'
  ].join('\t'));
}

console.log(`\n总计 ${CASES.length} 题 | 有依据题 ${goldCases} 中命中依据 ${hitCount} (${(hitCount / goldCases * 100).toFixed(0)}%)`);
console.log(`无依据题 ${CASES.length - goldCases} 题，其中未注入(走通用模式) ${noHitCount} 题`);

fs.writeFileSync(
  path.join(__dirname, 'selftest-hits.json'),
  JSON.stringify(rows, null, 2), 'utf8'
);
console.log('\n明细已写入 scripts/selftest-hits.json');
