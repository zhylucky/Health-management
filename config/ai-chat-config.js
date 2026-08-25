/**
 * AI聊天配置文件
 * 在这里配置您的API密钥和其他设置
 */

// AI服务配置 - 安全版本
const AI_CHAT_CONFIG = {
    // 通过 Pages Functions 同域代理调用（/api/chat → SiliconFlow），避免 workers.dev 跨境不稳定
    // 备用（Worker 直连）：'https://jkkeji-api.health-management.workers.dev/chat'
    functionUrl: '/api/chat',
    // 对话模型（免费）：Qwen3.5-4B 更快 + 原生多模态；Qwen3-8B 质量更好但免费档生成慢
    // 2026-08-19 已从 Qwen3-8B 切换为 Qwen3.5-4B 提速
    model: 'Qwen/Qwen3.5-4B',
    // 识图模型（免费，原生多模态，看图理解+问答，替代付费的 VL 模型）
    imageModel: 'Qwen/Qwen3.5-4B',
    // OCR 模型（免费，图片/文档/截图 → 文字/markdown 提取）
    ocrModel: 'deepseek-ai/DeepSeek-OCR',
    // 流式输出：逐字显示（打字机效果），显著改善响应感知速度
    stream: true,
    // 思考模式：true 时像 DeepSeek 网页一样先流式显示思考内容，再输出正式回答
    // 注意：开启思考模式会显著增加响应时间（思考也消耗 token 与时间），嫌慢可改 false
    thinkingMode: false,
    
    // 聊天配置
    maxMessages: 6, // 上下文裁剪到最近 6 条，控制 prompt 体积以提速
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
- 基于提供的知识库文档回答，确保信息准确
- 直接回答核心问题，去除客套话
- 若用户问题不明确涉及哪款产品，可适当询问确认
- 未知或超出范围的问题（如医疗诊断），建议咨询专业医生或联系客服

# 输出格式
- 回答尽量简洁：一般问题 3-5 句话内说清，操作步骤控制在 6 步内，不要重复、不要说空话
- 使用清晰的段落和换行，避免大段连续文字
- 操作步骤用数字编号
- 重要提示单独成段
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