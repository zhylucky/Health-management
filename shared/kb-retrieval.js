// ═══════════════════════════════════════════════════════════════════
// shared/kb-retrieval.js — 知识库检索共享模块（零依赖纯函数）
// 用途：把《kb.md》按标题切块，根据用户问题打分检索 top-K，
//       生成带【来源】标注的注入段，供 AI 助手使用。
// 被三处函数通道共用（Pages Functions / Worker / Netlify Functions），
// 用 CommonJS 写法保证 require 与 import 两种加载形态都兼容。
// 注意：本文件不可引入任何 Node 内置模块或第三方包（Worker 环境限制）。
// ═══════════════════════════════════════════════════════════════════

const KB_CONFIG_DEFAULTS = {
  topK: 4,            // 注入片段数
  minScore: 0.18,     // 注入阈值（queryCoverage 主导，按真实用例实测调优）
  maxChunkChars: 1500 // 大块保护：块正文超过该长度时二次切分
};

// 内部整理说明块（如"十七、已知差异与待确认项"）：该章罗列全部产品名与型号，
// 正文命中会系统性抢占 top-K，挤掉真正的产品概述块。处理：仅当查询自身指向该章节
// （含"待确认/已知差异"等词）时保留正常分参与检索，否则压到阈值以下不注入。
const NOISE_CHAPTER_TITLE_RE = /已知差异|待确认/;
const NOISE_CHAPTER_QUERY_RE = /待确认|已知差异|文档差异|不一致/;

// 切块缓存：同一份知识库文本只切一次。三通道每次请求都会走 buildKnowledgeInjection，
// 25.8KB 全文切块 + 全量 bigram 是纯重复劳动；文本不变（引用/值相等）时复用上次结果。
// 纯 JS 模块级变量，无 Node 依赖；Worker 冷启动后文本是常量，命中率最高。
let _chunksCacheText = null;
let _chunksCacheResult = null;

// 寒暄/闲聊词：消息"整句等于"其中一词时直接跳过检索
const CHITCHAT_WORDS = [
  '你好','您好','你好呀','嗨','哈喽','hello','hi',
  '谢谢','感谢','辛苦','再见','拜拜','在吗','早上好','下午好','晚上好',
  '哈哈','嘿嘿','好的','嗯嗯','哦','ok','好的好的','明白了','知道了'
];

// KB 门控实现：纯靠"寒暄词表跳过 + 打分阈值（minScore=0.18）"，不再维护意图关键词表。
// 前端 config/ai-chat-config.js 的 intentClassification 仅用于 temperature/maxTokens 策略，与检索无关；
// 若将来需要前端 intent 字段参与门控，再另行设计。

// 泛化"产品清单"类问题的命中模式：关键词检索通常匹配不到"产品体系总览"表格块，
// 此类问题在无命中时直接注入总览块作为兜底
const PRODUCT_INTRO_PATTERNS = [
  '有什么产品','有哪些产品','什么产品','产品有哪些','产品有什么',
  '产品介绍','介绍产品','产品都有','有哪几款','有几种产品','产品线','几款产品'
];

/**
 * 分词：中文字符二元组（bigram）+ 英文/数字/型号词元（如 LT-BBSSP、room）
 * 中文无空格，二元组是低成本且对专有名词敏感的切分方式。
 */
function tokenize(text) {
  const tokens = new Set();
  const s = String(text || '').toLowerCase();
  const ascii = s.match(/[a-z0-9][a-z0-9-]*/g);
  if (ascii) for (const m of ascii) tokens.add(m);
  const cjkSegs = s.match(/[\u4e00-\u9fff]+/g);
  if (cjkSegs) {
    for (const seg of cjkSegs) {
      for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2));
    }
  }
  return tokens;
}

/**
 * 切块：按 ## / ### 标题为边界，跳过"目录"章节，文件头作为前置说明块。
 * 每个块携带完整标题路径（如"九、产品六：个人精英健康Pro+测评系统 > 9.3 五大测评项目"），
 * 既用于打分加权，也用于注入段的【来源】标注。
 */
function buildChunks(markdown) {
  if (!markdown) return [];
  const lines = String(markdown).split(/\r?\n/);
  const chunks = [];
  let current = null;
  let headingPath = [];
  let inToc = false;

  const pushCurrent = () => {
    if (current && current.text.trim()) chunks.push(current);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = line.match(/^## (.+)$/);
    const h3 = line.match(/^### (.+)$/);

    if (h2) {
      pushCurrent();
      const title = h2[1].trim();
      inToc = /^目录/.test(title); // 目录章节罗列全部产品名，会污染打分，整章跳过
      headingPath = [title];
      current = { title, headingPath: title, text: '', startLine: i + 1 };
      continue;
    }
    if (h3) {
      pushCurrent();
      const title = h3[1].trim();
      if (headingPath.length === 0) headingPath = [title];
      else headingPath[1] = title;
      const pathStr = headingPath.join(' > ');
      current = { title: pathStr, headingPath: pathStr, text: '', startLine: i + 1 };
      continue;
    }
    if (!current) {
      // 首个标题前的文件头（# 主标题 + 用途说明）作为前置说明块
      current = { title: '文件说明', headingPath: '文件说明', text: '', startLine: i + 1 };
    }
    if (inToc) continue;
    if (/^\s*---\s*$/.test(line)) continue; // 剔除分隔线
    current.text += line + '\n';
  }
  pushCurrent();

  // 大块保护：先按空行切，仍超长再按行切（Markdown 表格无空行，必须兜底）
  const result = [];
  const cap = KB_CONFIG_DEFAULTS.maxChunkChars;
  const splitOverlong = (chunk) => {
    if (chunk.text.length <= cap) return [chunk];
    const parts = chunk.text.split(/\n\s*\n/);
    const out = [];
    let buffer = '';
    for (const part of parts) {
      if (buffer && (buffer + '\n\n' + part).length > cap) {
        out.push({ title: chunk.title, headingPath: chunk.headingPath, text: buffer });
        buffer = '';
      }
      buffer += (buffer ? '\n\n' : '') + part;
      if (buffer.length > cap) {
        // 无空行可用（如大表格）：按行拆成 ≤cap 的组
        const lines2 = buffer.split('\n');
        buffer = '';
        let group = [];
        let gLen = 0;
        for (const ln of lines2) {
          if (group.length && gLen + ln.length + 1 > cap) {
            out.push({ title: chunk.title, headingPath: chunk.headingPath, text: group.join('\n') });
            group = [];
            gLen = 0;
          }
          group.push(ln);
          gLen += ln.length + 1;
        }
        if (group.length) {
          out.push({ title: chunk.title, headingPath: chunk.headingPath, text: group.join('\n') });
        }
      }
    }
    if (buffer.trim()) {
      out.push({ title: chunk.title, headingPath: chunk.headingPath, text: buffer });
    }
    return out;
  };
  for (const c of chunks) result.push(...splitOverlong(c));
  return result;
}

/** 切块并缓存：文本不变（===）则返回上次结果，避免每次请求重复全量切分 */
function getChunks(kbText) {
  if (_chunksCacheText === kbText && _chunksCacheResult) return _chunksCacheResult;
  const chunks = buildChunks(kbText);
  _chunksCacheText = kbText;
  _chunksCacheResult = chunks;
  return chunks;
}

/** 查询词元与目标文本词元的命中数 */
function tokenOverlap(qt, ct) {
  let hits = 0;
  for (const t of qt) if (ct.has(t)) hits++;
  return hits;
}

/**
 * 打分：queryCoverage（查询词元命中覆盖率）主导 + Dice 辅助 + 标题命中加权。
 * 用覆盖率主导是为了避免短查询（如"睡眠"）被块长度稀释到阈值以下。
 */
function scoreChunk(query, chunk) {
  const qt = tokenize(query);
  if (qt.size === 0) return 0;
  const ct = tokenize(chunk.text);
  const textHits = tokenOverlap(qt, ct);
  const coverage = textHits / qt.size;
  const dice = (qt.size + ct.size) === 0 ? 0 : (2 * textHits) / (qt.size + ct.size);
  let score = 0.65 * coverage + 0.35 * dice;
  // 标题加权：查询词元命中块标题（含产品名/章节名）额外加成
  const tt = tokenize(chunk.title);
  if (tt.size > 0) {
    const titleHits = tokenOverlap(qt, tt);
    if (titleHits > 0) score += 0.25 * (titleHits / qt.size);
  }
  return score;
}

/** 检索：对全部块打分，取 top-K 且分数 ≥ minScore */
function retrieve(query, chunks, cfg) {
  const c = cfg || KB_CONFIG_DEFAULTS;
  if (!query || !chunks || chunks.length === 0) return [];
  return chunks
    .map(chunk => {
      let score = scoreChunk(query, chunk);
      // 内部整理说明块降权：非自指查询时压到阈值以下，避免抢占 top-K（见 NOISE_CHAPTER_* 注释）
      if (NOISE_CHAPTER_TITLE_RE.test(chunk.title) && !NOISE_CHAPTER_QUERY_RE.test(query)) {
        score = Math.min(score, c.minScore * 0.9);
      }
      return { chunk, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, c.topK)
    .filter(s => s.score >= c.minScore);
}

/** 生成注入段（带【来源】标注 + 使用说明）；hits 为空时返回空串 */
function buildInjection(hits) {
  if (!hits || hits.length === 0) return '';
  const parts = hits.map(({ chunk }) =>
    `【来源：${chunk.title}】\n${chunk.text.trim()}\n`
  );
  return (
    '\n\n--- 产品知识库（检索自《kb.md》）---\n\n' +
    parts.join('\n') +
    '\n--- 使用说明 ---\n' +
    '1. 仅当问题涉及公司/产品/设备/操作/后台/小程序等业务范畴时，优先依据上方片段回答；\n' +
    '2. 片段未覆盖的内容，请如实说明"知识库中暂无相关信息"并建议联系客服，不得编造型号、参数或操作步骤；\n' +
    '3. 与业务无关的问题（闲聊、通用知识）按常识回答，不要提及知识库。'
  );
}

/** 寒暄/过短消息：跳过检索 */
function shouldSkipRetrieval(message) {
  const m = String(message || '').trim().toLowerCase();
  if (m.length < 2) return true;
  return CHITCHAT_WORDS.includes(m);
}

/** 泛化产品清单问题兜底：命中"有什么产品/有哪些产品"等模式时，注入产品体系总览块 */
function matchProductIntro(query, chunks) {
  const q = String(query || '');
  const isIntroQuestion = PRODUCT_INTRO_PATTERNS.some(p => q.includes(p)) ||
    (q.includes('产品') && ['有什么', '有哪些', '介绍', '是什么'].some(w => q.includes(w)));
  if (!isIntroQuestion) return null;
  const overview = chunks.find(c => c.title === '二、产品体系总览');
  return overview ? [{ chunk: overview, score: 1 }] : null;
}

/**
 * 完整流程：给定完整 messages（含历史）与知识库文本，返回注入段与命中记录。
 * - 用最后一条用户消息检索；
 * - 追问兜底：本条过短（≤8 字符）或无命中时，合并"上一条用户消息 + 本条"重试，
 *   解决"那蓝牙呢？""它多少钱"这类指代追问检索不到关键词的问题；
 * - 产品清单兜底：泛化"有什么产品"类问题仍无命中时，注入"产品体系总览"块；
 * - 无命中返回空串（不注入，不降级为全量）。
 */
function buildKnowledgeInjection(messages, kbText, cfg) {
  const empty = { injection: '', hits: [] };
  if (!kbText) return empty;
  const chunks = getChunks(kbText);
  if (chunks.length === 0) return empty;

  const userMsgs = (messages || [])
    .filter(m => m && m.role === 'user')
    .map(m => String(m.content || ''));
  const last = userMsgs[userMsgs.length - 1] || '';
  if (shouldSkipRetrieval(last)) return empty;

  const c = cfg || KB_CONFIG_DEFAULTS;
  let hits = retrieve(last, chunks, c);
  if ((hits.length === 0 || last.trim().length <= 8) && userMsgs.length >= 2) {
    const combined = (userMsgs[userMsgs.length - 2] + ' ' + last).trim();
    const retry = retrieve(combined, chunks, c);
    if (retry.length > 0) hits = retry;
  }
  // 产品清单兜底：识别到"有什么产品/有哪些产品"类问题，无论关键词命中强弱，
  // 都把"产品体系总览"块置顶（关键词命中块去重保留）
  const introHit = matchProductIntro(last, chunks);
  if (introHit) {
    const seen = new Set(introHit.map(h => h.chunk.title));
    hits = [...introHit, ...hits.filter(h => !seen.has(h.chunk.title))].slice(0, c.topK);
  }
  return {
    injection: buildInjection(hits),
    hits: hits.map(h => ({ title: h.chunk.title, score: h.score }))
  };
}

// 逐项导出：兼容 Node 原生 ESM 具名导入（cjs-module-lexer）、esbuild 打包器、CommonJS require
exports.KB_CONFIG_DEFAULTS = KB_CONFIG_DEFAULTS;
exports.CHITCHAT_WORDS = CHITCHAT_WORDS;
exports.tokenize = tokenize;
exports.buildChunks = buildChunks;
exports.scoreChunk = scoreChunk;
exports.retrieve = retrieve;
exports.buildInjection = buildInjection;
exports.shouldSkipRetrieval = shouldSkipRetrieval;
exports.buildKnowledgeInjection = buildKnowledgeInjection;
