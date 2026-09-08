// scripts/test-context-budget.js — 上下文超窗降级裁剪本地验证（node scripts/test-context-budget.js）
// 校验：token 粗估规则、超窗从最旧丢弃、system 与最新提问保留、预算内不误裁
const kb = require('../shared/kb-retrieval.js');

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}`);
  if (!cond) failed++;
}

// ── 1. estimateTokens 粗估规则 ──
check('纯中文 4 字 ≈ 4 token', kb.estimateTokens('你好世界') === 4);
check('纯英文 8 字符 ≈ 2 token', kb.estimateTokens('abcdefgh') === 2);
check('空/无效输入 = 0', kb.estimateTokens('') === 0 && kb.estimateTokens(null) === 0);
check('中英混合：中文按字 + 英文按 4 字符', kb.estimateTokens('你好hello') === 2 + 2);

// ── 2. trimMessagesToBudget ──
const sys = { role: 'system', content: '系统提示' }; // 4 token + 4
const mk = (i, len) => ({ role: i % 2 ? 'assistant' : 'user', content: '内'.repeat(len) });

// 2.1 预算内：原样返回，不误裁
const small = [sys, mk(1, 50), mk(2, 50), mk(3, 50)];
check('预算内不裁剪', kb.trimMessagesToBudget(small, 10000).length === 4);

// 2.2 超预算：从最旧的非 system 消息丢弃，保留 system 与最后一条
const big = [sys, mk(1, 500), mk(2, 500), mk(3, 500), mk(4, 500)];
const trimmed = kb.trimMessagesToBudget(big, 1100); // 约容纳 system + 2 条 500 字
check('超窗后条数减少', trimmed.length < big.length);
check('system 始终保留', trimmed[0] === sys);
check('最新提问始终保留', trimmed[trimmed.length - 1] === big[big.length - 1]);
check('丢弃的是最旧的（保留尾部）', trimmed.every(m => m === sys || big.slice(2).includes(m)));
check('裁剪后不超预算', trimmed.reduce((s, m) => s + kb.estimateTokens(m.content) + 4, 0) <= 1100);

// 2.3 极端：仅剩 system + 最后一条仍超预算 → 不再裁（不把当前问题裁没）
const extreme = [sys, mk(1, 99999)];
check('仅剩最新提问时不再裁', kb.trimMessagesToBudget(extreme, 100).length === 2);

// 2.4 幂等/健壮：非数组、空数组原样返回
check('空数组原样返回', kb.trimMessagesToBudget([], 100).length === 0);
check('非数组原样返回', kb.trimMessagesToBudget(null, 100) === null);

// ── 3. 模拟真实场景：24 条历史 + KB 注入不超 26000 预算 ──
const history = [sys];
for (let i = 0; i < 24; i++) history.push(mk(i + 1, 300)); // 每条 300 字的正常对话
const est = history.reduce((s, m) => s + kb.estimateTokens(m.content) + 4, 0);
check(`24 条×300 字（≈${est} token）在 26000 预算内不触发裁剪`, est < 26000 && kb.trimMessagesToBudget(history, 26000).length === 25);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
