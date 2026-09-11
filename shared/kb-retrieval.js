// ═══════════════════════════════════════════════════════════════════
// shared/kb-retrieval.js — 知识库检索共享模块（零依赖纯函数）
// 用途：把《kb.md》按标题切块，根据用户问题打分检索 top-K，
//       生成带【来源】标注的注入段，供 AI 助手使用。
// 被两处函数通道共用（Pages Functions / Worker），
// 用 CommonJS 写法保证 require 与 import 两种加载形态都兼容。
// 注意：本文件不可引入任何 Node 内置模块或第三方包（Worker 环境限制）。
// ═══════════════════════════════════════════════════════════════════

const KB_CONFIG_DEFAULTS = {
  topK: 4,            // 注入片段数
  minScore: 0.18,     // 注入阈值（queryCoverage 主导，按真实用例实测调优）
  maxChunkChars: 1500 // 大块保护：块正文超过该长度时二次切分（整表作答的块见 NO_SPLIT_TITLES）
};

// 通用模式系统提示词：RAG 未命中知识库（用户问业务之外的问题）时替换使用。
// 与知识库模式（前端 ai-chat-config.js systemPrompt，要求"3-5句说清/建议客服"）不同，
// 此提示词不限制输出长度，按问题性质自然回答，避免用户感觉"回答被写死、太简短"。
const GENERAL_SYSTEM_PROMPT = `你是"豆眼儿"，一位友好、专业的AI健康助手，同时也是一个乐于助人的通用AI助手。你可以回答健康、产品、生活、常识、知识、创意等各类问题。

# 回答原则
- 根据问题的性质自然回答：简单问题简短回答，复杂或开放式问题请给出完整、详细的回答，不要刻意压缩内容
- 回答友好、专业、条理清晰，需要时可用列表或分点
- 不需要刻意提及"知识库"或"请联系客服"
- 涉及医疗诊断、用药建议等专业医疗问题时，请提示用户咨询专业医生

# 边界
- 用户没有明确问及公司具体产品或设备时，按通用常识正常回答即可，不要强行往产品上引导
- 若用户问的问题你不确定，如实说明，不要编造`;

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

// ═══ 离线编译的意图→章节路由表 ═══
// 词元覆盖率打分处理不了同义/口语映射（"能用多久"≠字面有"寿命"），实测会漏检。
// 本表把人工确认过的"问法 → 该去哪一节找"预编译下来，在打分时给目标小节加权。
// 知识库增删章节后需同步维护本表（每段 hint 说明该行覆盖什么问法）。
// 采用**软加权**而非硬过滤：底层仍是全局打分，路由只把正确小节往上顶，
// 即使路由判断错了也不会丢召回。
const KB_ROUTES = [
  { hint: '续航与充电',     q: /续航|充电|充满|电池|电量|能连续用|连续工作/,              targets: ['> 3.1', '> C.'],   boost: 0.45 },
  { hint: '主机硬件规格',   q: /重量|多重|几克|尺寸|多大|防水|防护等级|供电|功率|IPX/,     targets: ['> 3.1'],           boost: 0.50 },
  { hint: '性能指标与精度', q: /测量范围|精度|误差|分辨率|量程|采样|bpm|rpm/,              targets: ['> 3.2'],           boost: 0.50 },
  { hint: '预期使用寿命',   q: /能用多久|可以用多久|使用寿命|使用年限|寿命|报废/,          targets: ['> 16.6'],          boost: 0.55 },
  { hint: '常见故障排除',   q: /故障|排除|测不出|读不出|没数据|没读数|直线|杂乱|不好使|不工作/, targets: ['> 16.8'],      boost: 0.50 },
  { hint: '促醒报警阈值',   q: /报警|预警|阈值|上限|下限|超限/,                            targets: ['> 10.3'],          boost: 0.50 },
  { hint: '保修与售后',     q: /保修|质保|三包|维修|换新|退货|售后|坏了/,                  targets: ['> 16.7'],          boost: 0.45 },
  { hint: '环境与储运',     q: /环境温度|工作温度|湿度|气压|海拔|运输|贮存/,               targets: ['> 16.4'],          boost: 0.45 },
  { hint: '禁忌与适用人群', q: /禁忌|禁用|慎用|儿童|婴儿|起搏器|不适合|谁不能用/,          targets: ['> 4.1', '> D.'],   boost: 0.40 },
  // 「诊断」单独入词：只写「能做诊断|诊断吗」时，"能用来诊断疾病吗"这类自然说法会全部落空
  { hint: '合规与免责',     q: /免责|诊断|确诊|治病|有病|患病|(指标|数据|结果|报告|读数|数值|心率|血氧|血压|体温|呼吸)[^。？！?!]{0,8}正常/, targets: ['> 16.3'], boost: 0.50 },
  { hint: '标准与认证',     q: /EMC|电磁兼容|GB ?\d|YY ?\d|注册证|认证|符合.*标准/,        targets: ['十五、'],          boost: 0.40 },
  { hint: '软件别名对照',   q: /叫什么|哪个 ?(app|软件)|软件名|包名|别名/,                 targets: ['> 2.2'],           boost: 0.45 },
  { hint: '术语解释',       q: /是什么意思|什么意思|术语|什么叫|何为/,                      targets: ['> 2.3'],           boost: 0.45 },
  { hint: '公司与地址',     q: /公司|厂家|厂商|注册人|生产企业|地址|品牌|官网/,            targets: ['一、公司概况'],    boost: 0.40 },
  { hint: '后台账号与权限', q: /后台|账号|账户|密码|登录|权限|角色|管理员/,                targets: ['十三、'],          boost: 0.35 },
  { hint: '下载与版本',     q: /下载|二维码|最新版|版本号|升级/,                            targets: ['> F.'],            boost: 0.40 }
];

/** 命中则累加路由加权：同一路由的多个目标小节各加一次 */
function routeBoost(query, title) {
  let boost = 0;
  for (const r of KB_ROUTES) {
    if (!r.q.test(query)) continue;
    for (const t of r.targets) if (title.includes(t)) boost += r.boost;
  }
  return boost;
}

// 目录型表格白名单：整张表构成一个完整答案（产品清单、软件别名、术语表），
// 一旦被 maxChunkChars 切断，被切掉的行将永远无法被召回（实测产品清单只能列出 11 个中的 7 个）。
const NO_SPLIT_TITLES = [
  // 公司概况正文 1561 字符,刚好越过 maxChunkChars 被切成 1475+86 两块(尾巴只含"共同技术底座"一句),
  // 两片标题完全相同,命中时会一起占掉 2 个 top-K 名额(实测「公司附近有门店吗」两片同时注入)
  '一、公司概况',
  '2.1 产品清单', '2.2 产品—软件—应用名称对照表', '2.3 术语表',
  // EMC 表同理：被切成两块后两片标题相同，会一起挤掉 FAQ E 的要点汇总
  '15.3 电磁兼容（EMC）'
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
  for (const c of chunks) {
    // 「文件说明」块 = 首个标题前的文件头(H1 + 版本/用途/资料来源/给 AI 的检索约定),
    // 属内部整理说明而非答案内容。实测「这个产品好用吗?」会把它检索出来,把
    // "面向 AI 问答……整体注入型知识库""14 份原始文档"等元信息喂给模型,故不参与检索。
    if (c.title === '文件说明') continue;
    // 目录型表格整张就是答案，切断后后半部分再也不会被召回（实测产品清单只能列出 11 个中的 7 个）
    if (NO_SPLIT_TITLES.some(t => c.title.includes(t))) result.push(c);
    else result.push(...splitOverlong(c));
  }
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
  // 意图路由加权：弥补词元打分无法处理的同义/口语映射（见 KB_ROUTES 注释）
  score += routeBoost(query, chunk.title);
  return score;
}

// ═══ 免责声明常驻 ═══
// 16.3 是知识库里唯一的法定免责条款，体积极小（约 80 token）。此前靠检索命中，
// 触发词覆盖不全时会被漏掉——实测问「能用来诊断疾病吗」注入里没有 16.3，
// 而 4.1 的「为……诊断提供依据」会把模型往"可用于诊断"的方向带，属方向性错误答复。
// 改为无条件追加到每个注入段末尾；已检索到时不重复。
const DISCLAIMER_TITLE_RE = /16\.3.*免责/;
function buildDisclaimer(chunks, hits) {
  const already = hits.some(h => h.chunk.title.includes('16.3'));
  if (already) return '';
  const c = chunks.find(x => DISCLAIMER_TITLE_RE.test(x.title));
  return c ? `【来源：${c.title}】\n${c.text.trim()}\n` : '';
}

/** 检索：对全部块打分取 top-K，分数 ≥ minScore */
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

/** 生成注入段（带【来源】标注 + 使用说明 + 常驻免责声明）；hits 为空时返回空串 */
function buildInjection(hits, disclaimer) {
  if (!hits || hits.length === 0) return '';
  const parts = hits.map(({ chunk }) =>
    `【来源：${chunk.title}】\n${chunk.text.trim()}\n`
  );
  if (disclaimer) parts.push(disclaimer);
  return (
    '\n\n--- 产品知识库（检索自《kb.md》）---\n\n' +
    parts.join('\n') +
    '\n--- 使用说明 ---\n' +
    '1. 仅当问题涉及公司/产品/设备/操作/后台/小程序等业务范畴时，优先依据上方片段回答；\n' +
    '2. 片段未覆盖的内容，请如实说明"知识库中暂无相关信息"并建议联系客服，不得编造型号、参数或操作步骤；\n' +
    '3. 涉及医疗建议时（能否诊断、是否患病、指标是否正常、能否停用/改用药物、特殊人群能否使用等），必须同时说明"本产品对诊断只起辅助作用，最终须由医生结合临床表现判断"；\n' +
    '4. 知识库未提及的信息（如某类人群是否可用、价格与报价等），如实说明暂无相关信息并建议联系客服。不得因"禁忌清单中未列入"反向推断为可用，也不得估算或推测价格；\n' +
    '5. 人数、时长、报警阈值等按产品区分的参数，先确认用户所指的产品；无法确认时应列出各产品取值并说明差异，不要混为一谈；\n' +
    '6. 与业务无关的问题（闲聊、通用知识）按常识回答，不要提及知识库。'
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
  // 前缀匹配：v2.1 起「## 二、产品体系总览」正文为空、标题下紧跟「### 2.1 产品清单」，
  // 不存在裸的「二、产品体系总览」块，精确匹配会取不到而兜底失效。
  const overview = chunks.find(c => c.title.indexOf('二、产品体系总览') === 0);
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
  // 免责块单独命中不算命中:16.3 正文极短,短查询仅凭 Dice 项就能把它顶过阈值;
  // 若按"命中"处理,门控(hits.length > 0)会把通用问题误切到知识库模式——换 4B 模型
  // 且使用说明 2 要求答"知识库中暂无相关信息",而注入里没有任何可答内容。
  // 实测「设备屏幕不亮正常吗?」即为此情形;现按未命中处理,交回通用模式回答。
  if (hits.length > 0 && hits.every(h => DISCLAIMER_TITLE_RE.test(h.chunk.title))) hits = [];
  return {
    injection: buildInjection(hits, buildDisclaimer(chunks, hits)),
    hits: hits.map(h => ({ title: h.chunk.title, score: h.score }))
  };
}

// ═══ 上下文窗口保护：token 估算 + 超窗降级裁剪 ═══
// 粗估规则（无分词器）：CJK 字符约 1 字 = 1 token，其余约 4 字符 = 1 token。
// 只用于"是否可能超窗"的安全判断，不追求精确。
const CJK_TOKEN_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const cjk = (s.match(CJK_TOKEN_RE) || []).length;
  return cjk + Math.ceil((s.length - cjk) / 4);
}

// 超窗降级裁剪：估算总 token 超过预算时，从最旧的非 system 消息开始丢弃，
// 始终保留 system（含知识库注入）与最新一条消息（当前提问），保证请求不因
// 上下文超窗被上游 400 拒绝。仅剩 system + 最后一条仍超预算时不再处理
// （那是当前问题本身超长，交给上游判断，避免把问题裁没）。
//
// 实现为**单次前向遍历 O(n)**：原实现每丢一条就重算一遍全量 token（O(n²)），
// 实测 8000 条消息要 55 秒 CPU——而 /api/chat 是无鉴权端点、后端此前也不限条数，
// 单条请求即可打满 Functions 的 CPU 限额。改为先算总账、再前向丢弃，语义完全等价。
function trimMessagesToBudget(messages, budgetTokens) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const cost = (m) => estimateTokens(typeof m.content === 'string' ? m.content : '') + 4;
  const costs = messages.map(cost);
  const total = costs.reduce((sum, c) => sum + c, 0);
  // 常见路径：未超预算，零拷贝原样返回（调用方不会改写该数组）
  if (total <= budgetTokens) return messages;

  const n = messages.length;
  const keep = new Array(n).fill(true);
  let remaining = total;
  // i 只走到 n-2：最后一条（当前提问）永不丢弃
  for (let i = 0; i < n - 1 && remaining > budgetTokens; i++) {
    if (messages[i].role === 'system') continue;
    keep[i] = false;
    remaining -= costs[i];
  }
  return messages.filter((_, i) => keep[i]);
}

// 逐项导出：兼容 Node 原生 ESM 具名导入（cjs-module-lexer）、esbuild 打包器、CommonJS require
exports.KB_CONFIG_DEFAULTS = KB_CONFIG_DEFAULTS;
// 以下两项导出仅供自检脚本断言"硬编码章节目标是否仍存在于 kb.md":
// 知识库改标题时路由/白名单会静默失效(不报错、只是检索变差),需要可断言的出口。
exports.KB_ROUTES = KB_ROUTES;
exports.NO_SPLIT_TITLES = NO_SPLIT_TITLES;
exports.GENERAL_SYSTEM_PROMPT = GENERAL_SYSTEM_PROMPT;
exports.CHITCHAT_WORDS = CHITCHAT_WORDS;
exports.tokenize = tokenize;
exports.buildChunks = buildChunks;
exports.scoreChunk = scoreChunk;
exports.retrieve = retrieve;
exports.buildInjection = buildInjection;
exports.shouldSkipRetrieval = shouldSkipRetrieval;
exports.buildKnowledgeInjection = buildKnowledgeInjection;
exports.estimateTokens = estimateTokens;
exports.trimMessagesToBudget = trimMessagesToBudget;
