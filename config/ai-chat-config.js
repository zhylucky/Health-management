/**
 * AI聊天配置文件
 * 在这里配置您的API密钥和其他设置
 */

// AI服务配置 - 安全版本
const AI_CHAT_CONFIG = {
    // 通过 Pages Functions 同域代理调用（/api/chat → SiliconFlow），避免 workers.dev 跨境不稳定
    // 备用（Worker 直连）：'https://jkkeji-api.health-management.workers.dev/chat'
    functionUrl: '/api/chat',
    // ⚠️ 本文件里的三个模型字段（model / imageModel / ocrModel）**都不生效**——
    //    真实模型一律由 Cloudflare 环境变量决定（见 README 环境变量表）：
    //      · model      —— 后端只要 injectKnowledge=true（正常对话都是），就会用
    //                      KB_MODEL / GENERAL_MODEL 覆盖它；
    //      · imageModel —— 前端会把它当 model 字段发出去（js/ai-chat.js 请求体构造处），
    //                      但后端 handleImage 只读 env.IMAGE_MODEL，传进来的 model 整个被忽略；
    //      · ocrModel   —— 前端从不发送该字段，后端也只读 env.OCR_MODEL。
    //    改这三个字段不会改变实际使用的模型，要换模型请改环境变量。
    model: 'Qwen/Qwen3.5-4B',
    // 识图模型（免费，原生多模态，看图理解+问答，替代付费的 VL 模型）—— 不生效，见上方说明
    imageModel: 'Qwen/Qwen3.5-4B',
    // OCR 模型（免费，图片/文档/截图 → 文字/markdown 提取）—— 不生效，见上方说明
    ocrModel: 'deepseek-ai/DeepSeek-OCR',
    // 流式输出：逐字显示（打字机效果），显著改善响应感知速度
    stream: true,
    // 最短缓冲时间（ms）：即使模型立刻返回，也先保持"Thinking…"流光播满此时间再输出。
    // 实测首字延迟只有 0.3~1.2s，1800 会把每一问都硬撑到 1.8s 才显示（纯感知损失），故降到 900。
    // 设为 0 可关闭此效果。
    minBufferTime: 900,
    
    // 聊天配置
    maxMessages: 24, // 上下文保留最近 24 条（约 12 轮），多轮追问不丢前文
    // 超窗自动降级保护：条数多不等于体积可控（用户可能粘贴长报告），
    // 历史消息按估算 token 预算裁剪——从最旧的开始丢弃，始终保留最新提问，
    // 为后端知识库注入与模型输出预留空间，避免上下文超窗被 API 拒绝（400）
    contextBudget: {
        historyTokenBudget: 12000 // 历史消息 token 预算（中文按 1 字≈1 token 粗估）
    },
    // 动态回答策略配置（参考 NoteGen 的智能路由）
    strategySettings: {
        enabled: true,
        // 问题分类及对应处理策略（maxTokens 按场景调整，复杂回答预留足够输出空间）
        intentClassification: {
            'product-inquiry': {
                keywords: ['是什么', '功能', '介绍', '产品', '有什么', '特点', '优势'],
                temperature: 0.6,
                maxTokens: 1200,
                focus: '产品介绍'
            },
            'operation-guide': {
                keywords: ['怎么', '如何', '操作', '使用', '步骤', '流程', '教程'],
                temperature: 0.5,
                maxTokens: 2000,
                focus: '操作指导',
                includeSteps: true
            },
            'troubleshooting': {
                keywords: ['问题', '故障', '错误', '失败', '连接不上', '无法', '不行', '不能用'],
                temperature: 0.5,
                maxTokens: 1200,
                focus: '故障排查'
            },
            'device-support': {
                keywords: ['设备', '绑定', '连接', '蓝牙', '发射器', '血压计', '血氧仪', '胸贴'],
                temperature: 0.5,
                maxTokens: 1200,
                focus: '设备支持'
            },
            'report-related': {
                keywords: ['报告', '测评', '结果', '数据', '分析', '睡眠', '情绪', '体能'],
                temperature: 0.6,
                maxTokens: 1500,
                focus: '报告解读'
            },
            'account-support': {
                keywords: ['账号', '登录', '注册', '密码', '会员', '订单', '支付'],
                temperature: 0.5,
                maxTokens: 800,
                focus: '账户支持'
            }
        },
        // 默认策略
        defaultStrategy: {
            temperature: 0.5,
            maxTokens: 1500
        }
    },
    
    // 自定义AI助手
    systemPrompt: `你是健康科技团队的AI健康助手，负责解答公司产品体系的相关问题。产品线包括：睡眠监测仪、睡眠呼吸监测仪（五人系统）、多参数监护仪系统、导航ROOM系统、矩阵式生命潮生物反馈系统、个人精英健康Pro+测评系统、促醒监护仪、健康测评系统（生命潮®）、心身健康管理系统（生命潮®），以及后台权限管理系统和《道贞健康》小程序。产品细节、参数与操作步骤以注入的知识库片段为准。

# 职责
1. 解读测评报告和数据，提供专业建议
2. 指导App、PC端、后台管理系统的操作流程
3. 解决设备绑定、蓝牙连接、佩戴、测评失败等技术问题
4. 区分各产品线的功能差异，准确回答

# 回答规则
- 基于提供的知识库文档回答，确保信息准确；先给结论，再按需展开
- 直接回答核心问题，去除客套话
- 篇幅按问题复杂度决定，不要一刀切：
  · 简单问题（单一事实、"是不是"、名词解释）1-3 句答完即可，不要凑长度
  · 复杂问题（多产品对比、完整操作流程、故障排查、报告解读、产品体系总览）展开到 4-7 句，
    用分点或分步骤把关键信息讲清楚；宁可信息密度高，也不要靠加长度来显得详细
  · 判断口径：问题中出现"对比/区别/分别/有哪些/都有什么/流程/步骤/排查/怎么用"等，按复杂问题处理
- 同类问题不要套用同一个模板：按内容组织结构，产品之间要写出具体差异（型号、参数、适用场景、各自限制）
- 不要为凑长度重复已经说过的内容；知识库未提及的型号、参数、价格一律不得推测或编造
- 若用户问题不明确涉及哪款产品，先确认再展开
- 未知或超出范围的问题（如医疗诊断），建议咨询专业医生或联系客服

# 输出格式
- 正文一律用**简体中文**：不要输出英文句子或英文段落（产品型号如 BBS-LTSP、单位如 KHz/mA、URL 例外）。
  用户用其他语言提问时，才用对应语言回答
- 使用清晰的段落和换行，避免大段连续文字
- 操作步骤用数字编号，并写明前置条件（如需先绑定设备）
- 格式只用这几种：小标题、短段落、数字编号、无序列表、**加粗**
- 不要在行首写 >（引用块）：渲染时会被剥离，起不到强调作用，需要强调请用加粗
- 不要用 markdown 表格：气泡宽度有限，表格在手机上需要横向滑动才能看全。
  需要逐项对比时，用"加粗小标题 + 编号列表"逐条列出
- 涉及医疗、安全或数据合规的提示单独成段；知识库注入中给出的免责声明必须保留
- 语气友好专业，像一位经验丰富的健康管理师`,

    // 界面配置
    ui: {
        title: 'AI健康助手',
        placeholder: '请输入您的问题...',
        welcomeMessage: '您好！我是豆眼儿，您的专属AI健康助手💡\n\n我可以帮助您：\n• 解答健康管理相关问题\n• 介绍产品功能和使用方法\n• 提供技术支持和故障排除\n• 协助预约和咨询服务\n\n\n请随时向我提问，我会尽力为您提供帮助！',
        errorMessages: {
            noApiKey: '⚠️ AI服务尚未配置，请联系管理员设置API密钥',
            networkError: '❌ 网络连接失败，请检查网络后重试',
            apiError: '🔧 AI服务暂时无法响应，请稍后重试或联系技术支持',
            unknownError: '😅 出现了未知错误，请重新尝试或联系客服'
        }
    }
};

// 导出配置
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AI_CHAT_CONFIG;
} else if (typeof window !== 'undefined') {
    window.AI_CHAT_CONFIG = AI_CHAT_CONFIG;
}