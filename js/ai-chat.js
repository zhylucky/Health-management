/**
 * AI 助手 v3
 * - 仿 Perplexity / Claude / ChatGPT 网页聊天布局
 * - 流式输出（打字机）
 * - Markdown 渲染（标题/列表/代码块）
 * - 图片：上传按钮 + 剪贴板粘贴
 * - 发送图片自动切换多模态模型
 */

// ═══ ThinkingOrb "connecting" (web/network) 动画引擎（泛化版，可挂到任意 canvas）═══
const _lerp = (a, b, t) => a + (b - a) * t;
const _fract = (x) => x - Math.floor(x);
// E: 哈希 (确定性随机)
const _hash = (x, y) => {
    const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return h - Math.floor(h);
};
// G: 平滑值噪声 (双线性插值 + smoothstep)
function _noise(x, y) {
    const t = Math.floor(x), r = Math.floor(y);
    let a = x - t, o = y - r;
    a = a * a * (3 - 2 * a);
    o = o * o * (3 - 2 * o);
    const c = _hash(t, r), M = _hash(t + 1, r), h = _hash(t, r + 1), m = _hash(t + 1, r + 1);
    return c + (M - c) * a + (h - c) * o + (c - M - h + m) * a * o;
}
// J: 斐波那契球面点
function _fibSphere(i, n) {
    const phi = Math.PI * (3 - Math.sqrt(5));
    const y = 1 - 2 * (i + 0.5) / n;
    const r = Math.sqrt(1 - y * y);
    const theta = phi * i;
    return [Math.cos(theta) * r, y, Math.sin(theta) * r];
}
// 旋转变换: yaw/pitch → (x,y,z)→[cx,cy,z2]
function _makeRot(yaw, pitch, cx, cy, r) {
    const sa = Math.sin(pitch), ca = Math.cos(pitch);
    const sy = Math.sin(yaw), cyy = Math.cos(yaw);
    return (x, y, z) => {
        const e = x * cyy + z * sy;
        const l = -x * sy + z * cyy;
        const R = y * ca - l * sa;
        const w = y * sa + l * ca;
        return [cx + e * r, cy - R * r, w];
    };
}
// 在指定 canvas 上启动点云球动画；把停止函数挂到 canvas.__orbStop 上
function startOrbCanvas(canvas) {
    if (!canvas) return;
    const container = canvas.parentElement;
    const size = container.clientWidth || 64;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const orbStartTime = performance.now();

    // 颜色: 深蓝渐变 (背面 #0d3366 → 正面 #2673d9)
    const c1 = { r: 0.05, g: 0.20, b: 0.52 };
    const c2 = { r: 0.15, g: 0.45, b: 0.85 };

    // web 模式参数 (thinking-orbs@64px preset: speed=3.315, nodeN=30, thr=0.72, signals=5)
    const cx = size / 2, cy = size / 2;
    const R = size / 2 * 0.8;
    const M = Math.pow(size / 300, 0.6);
    const nodeN = 30;
    const thr = 0.72;
    const nodeR = 1.4, nodeRDepth = 1.8;
    const signalN = 5;
    const speed = 2.25;

    let orbId = null;
    function draw(time) {
        const elapsed = (time - orbStartTime) / 1000;
        const s = elapsed * speed;
        const rot = _makeRot(s * 0.12, 0.32, cx, cy, R);

        // 生成节点: 斐波那契球 + 随时间抖动的噪声
        const nodes = [];
        for (let i = 0; i < nodeN; i++) {
            const u = _fibSphere(i, nodeN);
            const y = u[0] + 0.3 * (_noise(i * 0.31 + 9, s * 0.24) - 0.5) * 2;
            const b = u[1] + 0.3 * (_noise(i * 0.53 + 27, s * 0.21) - 0.5) * 2;
            const f = u[2] + 0.3 * (_noise(i * 0.77 + 55, s * 0.27) - 0.5) * 2;
            const P = Math.sqrt(y * y + b * b + f * f);
            nodes.push([y / P, b / P, f / P]);
        }

        // 投影 (z 为未缩放的单位向量分量, 范围≈[-1,1], 深度用 (w+1)/2)
        const proj = nodes.map(n => {
            const [x, y, z] = rot(n[0], n[1], n[2]);
            return { x, y, z, depth: (z + 1) / 2 };
        });

        ctx.clearRect(0, 0, size, size);

        // 1. 连线 (距离 < thr 的节点相连)
        for (let i = 0; i < nodeN; i++) {
            for (let j = i + 1; j < nodeN; j++) {
                const dx = nodes[i][0] - nodes[j][0];
                const dy = nodes[i][1] - nodes[j][1];
                const dz = nodes[i][2] - nodes[j][2];
                const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
                if (dist >= thr) continue;
                const z = ((proj[i].z + proj[j].z) / 2 + 1) / 2;
                const alpha = (1 - dist / thr) * (0.3 + 0.55 * z);
                if (alpha < 0.02) continue;
                const cr = _lerp(c1.r, c2.r, z);
                const cg = _lerp(c1.g, c2.g, z);
                const cb = _lerp(c1.b, c2.b, z);
                ctx.beginPath();
                ctx.moveTo(proj[i].x, proj[i].y);
                ctx.lineTo(proj[j].x, proj[j].y);
                ctx.strokeStyle = `rgba(${cr*255|0},${cg*255|0},${cb*255|0},${alpha * 0.6})`;
                ctx.lineWidth = Math.max(0.6, 0.8 * M);
                ctx.stroke();
            }
        }

        // 2. 收集所有点 (节点 + 信号), 按 z 从远到近排序后绘制
        const dots = [];

        // 节点 (近大远小, 带呼吸脉冲)
        for (let i = 0; i < nodeN; i++) {
            const p = proj[i];
            const pulse = 1 + 0.25 * Math.sin(s * 1.4 + i * 2.7);
            dots.push({
                x: p.x, y: p.y, z: p.z,
                r: (nodeR + nodeRDepth * p.depth) * pulse * M,
                d: p.depth
            });
        }

        // 信号脉冲 (5 条沿随机节点连线流动, 亮蓝点)
        for (let i = 0; i < signalN; i++) {
            const phase = s * 0.55 + i * 7.31;
            const fi = Math.floor(phase);
            const frac = _fract(phase);
            const a = Math.floor(_hash(fi, i * 3.1 + 1.7) * nodeN);
            let b = Math.floor(_hash(fi, i * 5.7 + 4.2) * nodeN);
            if (a === b) continue;
            // 沿弦插值并投影到球面
            const px = _lerp(nodes[a][0], nodes[b][0], frac);
            const py = _lerp(nodes[a][1], nodes[b][1], frac);
            const pz = _lerp(nodes[a][2], nodes[b][2], frac);
            const len = Math.max(1e-6, Math.sqrt(px*px + py*py + pz*pz));
            const [sx, sy, sz] = rot(px/len, py/len, pz/len);
            const sd = (sz + 1) / 2;
            dots.push({
                x: sx, y: sy, z: sz,
                r: (nodeR * 1.5 + nodeRDepth * sd) * M,
                d: sd,
                signal: true
            });
        }

        // 画家算法: 远→近
        dots.sort((a, b) => a.z - b.z);
        for (const p of dots) {
            const f = p.d;
            const alpha = p.signal ? 0.5 + 0.5 * f : 0.15 + 0.8 * f;
            const cr = _lerp(c1.r, c2.r, f);
            const cg = _lerp(c1.g, c2.g, f);
            const cb = _lerp(c1.b, c2.b, f);
            const color = p.signal ? `rgba(30,144,255,${alpha * 0.95})` : `rgba(${cr*255|0},${cg*255|0},${cb*255|0},${alpha})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(0.3, p.r), 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
        }

        // 中心辉光
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.5);
        grad.addColorStop(0, 'rgba(38,115,217,0.08)');
        grad.addColorStop(1, 'rgba(38,115,217,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, R * 0.5, 0, Math.PI * 2);
        ctx.fill();

        orbId = requestAnimationFrame(draw);
    }
    orbId = requestAnimationFrame(draw);

    canvas.__orbStop = () => {
        if (orbId) {
            cancelAnimationFrame(orbId);
            orbId = null;
        }
        const c = canvas.getContext('2d');
        if (c) c.clearRect(0, 0, canvas.width, canvas.height);
    };
}
function stopOrbCanvas(canvas) {
    if (canvas && typeof canvas.__orbStop === 'function') {
        canvas.__orbStop();
        canvas.__orbStop = null;
    }
}

class AIChatWidget {
    constructor() {
        this.isOpen = false;
        this.messages = [];
        this.pendingImage = null;
        this.pendingImageName = null;
        this.isRequestPending = false;
        this._isStreaming = false;
        this.waitForConfigAndInit();
    }

    async waitForConfigAndInit() {
        let attempts = 0;
        while (!window.AI_CHAT_CONFIG && attempts < 50) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }
        if (window.AI_CHAT_CONFIG) {
            this.config = window.AI_CHAT_CONFIG;
        } else {
            this.config = {
                functionUrl: '/api/chat',
                model: 'Qwen/Qwen3.5-4B',
                imageModel: 'Qwen/Qwen3.5-4B',
                ocrModel: 'deepseek-ai/DeepSeek-OCR',
                stream: true,
                systemPrompt: '你是健康科技团队的AI健康助手。',
                maxMessages: 9,
                ui: {}
            };
        }
        this.functionUrl = this.config.functionUrl;
        this.model = this.config.model;
        this.systemPrompt = this.config.systemPrompt;
        this.maxMessages = this.config.maxMessages || 9;
        this.init();
    }

    init() {
        this.createHTML();
        this.bindEvents();
        this.showWelcomeMessage();
    }

    createHTML() {
        // 悬浮按钮
        const floatBtn = document.createElement('button');
        floatBtn.className = 'ai-chat-float-btn';
        floatBtn.title = 'AI 健康助手';
        document.body.appendChild(floatBtn);

        // 遮罩（全屏窗口下隐藏，仅保留元素兼容）
        const overlay = document.createElement('div');
        overlay.className = 'ai-chat-overlay';
        document.body.appendChild(overlay);

        // 聊天窗口
        const chatContainer = document.createElement('div');
        chatContainer.className = 'ai-chat-container';
        chatContainer.innerHTML = `
            <header class="ai-chat-header">
                <button class="ai-chat-close" title="关闭">
                    <i data-lucide="x"></i>
                </button>
                <div class="ai-chat-title">
                    <span class="ai-chat-name">豆眼儿</span>
                    <span class="ai-chat-subtitle">健康科技 AI 助手</span>
                </div>
                <div class="ai-chat-actions">
                    <button class="ai-chat-clear" title="清空对话">
                        <i data-lucide="trash-2"></i>
                    </button>
                </div>
            </header>
            <div class="ai-chat-messages" id="chatMessages"></div>
            <div class="ai-chat-composer">
                <div class="ai-chat-composer-inner">
                    <div class="ai-chat-img-preview" id="chatImgPreview" hidden>
                        <img id="chatImgPreviewImg" alt="预览">
                        <div class="ai-chat-img-info" id="chatImgInfo"></div>
                        <button class="ai-chat-img-remove" title="移除">
                            <i data-lucide="x"></i>
                        </button>
                    </div>
                    <div class="ai-chat-input">
                        <input type="file" id="chatImgInput" accept="image/*" hidden>
                        <button class="ai-chat-attach" id="chatImgBtn" title="发送图片（也可直接粘贴）">
                            <i data-lucide="image"></i>
                        </button>
                        <textarea class="chat-input-field" id="chatInput"
                            placeholder="输入消息，回车发送，Shift+回车换行..." rows="1"></textarea>
                        <button class="ai-chat-send" id="chatSendBtn" title="发送">
                            <i data-lucide="send"></i>
                        </button>
                    </div>
                    <div class="ai-chat-hint">Enter 发送 · Shift+Enter 换行 · 支持图片粘贴</div>
                </div>
            </div>
        `;
        document.body.appendChild(chatContainer);

        // 渲染 Lucide 图标（动态插入的 DOM 需要手动触发）
        if (typeof lucide !== 'undefined') {
            lucide.createIcons({ nodes: [chatContainer] });
        }

        // 图片灯箱（点击聊天中的图片放大查看）
        const lightbox = document.createElement('div');
        lightbox.className = 'image-lightbox';
        lightbox.innerHTML = `
            <button class="image-lightbox-close" title="关闭"><i data-lucide="x"></i></button>
            <img class="image-lightbox-img" alt="放大预览">
        `;
        document.body.appendChild(lightbox);
        if (typeof lucide !== 'undefined') {
            lucide.createIcons({ nodes: [lightbox] });
        }
        this.lightbox = lightbox;
        this.lightboxImg = lightbox.querySelector('.image-lightbox-img');
        this.lightboxClose = lightbox.querySelector('.image-lightbox-close');
        lightbox.addEventListener('click', (e) => {
            // 点击遮罩或大图本身均关闭（但点大图时不冒泡到遮罩造成闪烁）
            if (e.target === lightbox || e.target === this.lightboxImg || e.target === this.lightboxClose || this.lightboxClose.contains(e.target)) {
                this.closeLightbox();
            }
        });

        this.floatBtn = floatBtn;
        this.overlay = overlay;
        this.chatContainer = chatContainer;
        this.messagesContainer = document.getElementById('chatMessages');
        // 智能跟随滚动（beUI message-scroller 的 followOutput 逻辑）
        this._followThreshold = 56;   // 距底部多少像素内视为"正在跟随"
        this._nearBottom = true;      // 用户是否贴近底部
        this.inputField = document.getElementById('chatInput');
        this.sendBtn = document.getElementById('chatSendBtn');
        this.closeBtn = chatContainer.querySelector('.ai-chat-close');
        this.imgBtn = document.getElementById('chatImgBtn');
        this.imgInput = document.getElementById('chatImgInput');
        this.imgPreview = document.getElementById('chatImgPreview');
        this.imgPreviewImg = document.getElementById('chatImgPreviewImg');
        this.imgInfo = document.getElementById('chatImgInfo');
        this.clearBtn = chatContainer.querySelector('.ai-chat-clear');
    }

    bindEvents() {
        this.floatBtn.addEventListener('click', () => this.toggleChat());
        this.closeBtn.addEventListener('click', () => this.closeChat());
        this.overlay.addEventListener('click', () => this.closeChat());
        this.sendBtn.addEventListener('click', () => this.sendMessage());

        this.inputField.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                this.sendMessage();
            }
        });
        this.inputField.addEventListener('input', () => this.autoResizeTextarea());

        // 智能跟随滚动：用户上翻（超过阈值）则解除跟随，回到底部重新跟随
        this.messagesContainer.addEventListener('scroll', () => {
            const c = this.messagesContainer;
            this._nearBottom = (c.scrollHeight - c.scrollTop - c.clientHeight) <= this._followThreshold;
        }, { passive: true });

        // 图片按钮：触发文件选择
        this.imgBtn.addEventListener('click', () => this.imgInput.click());
        this.imgInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) this.handleImageFile(file);
            e.target.value = '';
        });

        // 粘贴图片支持（Ctrl+V）
        this.inputField.addEventListener('paste', (e) => {
            const items = e.clipboardData && e.clipboardData.items;
            if (!items) return;
            for (const item of items) {
                if (item.type && item.type.startsWith('image/')) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    if (file) this.handleImageFile(file);
                    return;
                }
            }
        });

        // 全局 paste 监听（用户在消息列表里粘贴也能捕获）
        document.addEventListener('paste', (e) => {
            if (!this.isOpen) return;
            const items = e.clipboardData && e.clipboardData.items;
            if (!items) return;
            for (const item of items) {
                if (item.type && item.type.startsWith('image/')) {
                    const file = item.getAsFile();
                    if (file) {
                        e.preventDefault();
                        this.handleImageFile(file);
                        return;
                    }
                }
            }
        });

        // 移除待发送图片
        const removeBtn = this.chatContainer.querySelector('.ai-chat-img-remove');
        if (removeBtn) removeBtn.addEventListener('click', () => this.clearImage());

        // 模型自动切换：发图时 callAIAPI 内已用 imageModel（多模态），无需手动选择

        // 清空对话
        this.clearBtn.addEventListener('click', () => {
            if (this.isRequestPending) {
                this.showError('请等待当前回答完成');
                return;
            }
            this.messages = [];
            this.messagesContainer.innerHTML = '';
            this.showWelcomeMessage();
        });
    }

    openChat() {
        this.isOpen = true;
        document.body.style.overflow = 'hidden';
        this.overlay.classList.add('show');
        requestAnimationFrame(() => this.chatContainer.classList.add('show'));
        this.floatBtn.classList.remove('pulse');
        setTimeout(() => {
            this.inputField.focus();
            this.scrollToBottom(true);
        }, 100);
    }

    closeChat() {
        this.isOpen = false;
        this.chatContainer.classList.remove('show');
        this.overlay.classList.remove('show');
        document.body.style.overflow = '';
    }

    toggleChat() {
        this.isOpen ? this.closeChat() : this.openChat();
    }

    showWelcomeMessage() {
        const welcome = document.createElement('div');
        welcome.className = 'welcome-wrapper';
        welcome.innerHTML = `
            <div class="welcome-avatar-row">
                <div class="welcome-avatar"></div>
                <div class="welcome-name">豆眼儿</div>
            </div>
            <div class="welcome-desc">您好！我是豆眼儿，健康科技 AI 助手。可以问我产品功能、操作方法、设备问题，或直接发送图片让我看图回答。</div>
            <div class="quick-actions">
                <button class="quick-action-btn" data-action="sleep">睡眠测评流程</button>
                <button class="quick-action-btn" data-action="device">设备绑定步骤</button>
                <button class="quick-action-btn" data-action="report">健康报告解读</button>
                <button class="quick-action-btn" data-action="support">设备连接不上</button>
            </div>
        `;
        this.messagesContainer.appendChild(welcome);
        this.scrollToBottom(true);

        const map = {
            sleep: '请问睡眠测评的具体操作流程是什么？',
            device: '如何绑定血压计、血氧仪等配套设备？',
            report: '如何查看历史测评报告？',
            support: '设备连接不上，一直显示搜索中怎么办？'
        };
        welcome.querySelectorAll('.quick-action-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.inputField.value = map[btn.dataset.action] || '';
                this.sendMessage();
            });
        });
    }

    // 统一处理图片文件（上传 / 粘贴）
    handleImageFile(file) {
        if (!file.type.startsWith('image/')) {
            this.showError('仅支持图片文件');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            this.showError('图片大小不能超过 5MB');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            this.pendingImage = reader.result;
            this.pendingImageName = file.name || 'pasted-image';
            this.imgPreviewImg.src = this.pendingImage;
            this.imgInfo.textContent = `${this.pendingImageName} · ${(file.size / 1024).toFixed(1)} KB`;
            this.imgPreview.hidden = false;
            this.openChat();
            this.inputField.focus();
        };
        reader.readAsDataURL(file);
    }

    clearImage() {
        this.pendingImage = null;
        this.pendingImageName = null;
        this.imgPreview.hidden = true;
        this.imgPreviewImg.src = '';
        this.imgInfo.textContent = '';
    }

    autoResizeTextarea() {
        const t = this.inputField;
        t.style.height = 'auto';
        t.style.height = Math.min(t.scrollHeight, 160) + 'px';
    }

    scrollToBottom(force = false) {
        // 用户上翻（超过阈值）时解除自动跟随，不抢滚动控制权
        if (!force && !this._nearBottom) return;
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    async sendMessage() {
        const message = this.inputField.value.trim();
        const hasImage = !!this.pendingImage;
        if (!message && !hasImage) return;
        if (this.isRequestPending) {
            this.showError('请等待上一个问题回答完成...');
            return;
        }
        this.isRequestPending = true;

        // 移除欢迎区
        const welcome = this.messagesContainer.querySelector('.welcome-wrapper');
        if (welcome) welcome.remove();

        const userMsg = {
            role: 'user',
            content: message || '请看这张图片',
            image: this.pendingImage,
            imageName: this.pendingImageName
        };
        this.addMessage(userMsg);
        this.messages.push(userMsg);

        this.inputField.value = '';
        this.autoResizeTextarea();
        this.clearImage();

        const originalHtml = this.sendBtn.innerHTML;
        this.sendBtn.disabled = true;
        this.sendBtn.innerHTML = '<span class="sending-spinner">◌</span>';

        // 流式渲染 rAF 句柄：需在 try 外声明，报错路径也要能取消
        let rafId = null;

        try {
            this.validateAndCleanMessages();
            const strategy = this.classifyIntent(message || '');

            const aiMsg = { role: 'assistant', content: '', reasoningContent: '' };
            this.addMessage(aiMsg);
            this.scrollToBottom(true);

            // 图片/OCR 请求为非流式：先显示加载状态，避免用户无感知
            if (hasImage) {
                const lastDiv = this.messagesContainer.querySelector('.chat-message.assistant:last-child');
                const bubble = lastDiv && lastDiv.querySelector('.chat-bubble');
                if (bubble) {
                    const loading = document.createElement('div');
                    loading.className = 'message-loading';
                    const orbWrap = document.createElement('div');
                    orbWrap.className = 'message-loading-orb';
                    const canvas = document.createElement('canvas');
                    orbWrap.appendChild(canvas);
                    const loadingText = document.createElement('div');
                    loadingText.className = 'message-loading-text';
                    loadingText.textContent = '⏳ 正在识别图片...';
                    loading.appendChild(orbWrap);
                    loading.appendChild(loadingText);
                    bubble.appendChild(loading);
                    startOrbCanvas(canvas);
                    this.scrollToBottom(true);
                }
            }

            // 流式渲染节流：requestAnimationFrame 对齐屏幕刷新（~16.7ms），
            // 同帧内到达的增量合并渲染一次，避免固定定时器"攒批蹦出"的生硬感；
            // 附加 30ms 最小间隔守卫，高刷屏（120/144Hz）上避免全量重排空转 CPU
            let renderScheduled = false;
            let lastRender = 0;

            // 思考模式：创建思考内容区域（像 DeepSeek 网页一样先显示思考再输出回答）
            let thinkingEl = null;
            let thinkingDone = false;
            const thinkingBubble = (() => {
                const divs = this.messagesContainer.querySelectorAll('.chat-message.assistant');
                const lastDiv = divs[divs.length - 1];
                return lastDiv ? lastDiv.querySelector('.chat-bubble') : null;
            })();

            const content = await this.callAIAPI(message, {
                strategy,
                image: hasImage ? userMsg.image : null,
                onReasoning: (text) => {
                    // 记录思考内容：SiliconFlow 思考模式要求下一轮请求必须原样回传 reasoning_content
                    aiMsg.reasoningContent += text;
                    if (!thinkingBubble) return;
                    if (!thinkingEl) {
                        thinkingEl = document.createElement('div');
                        thinkingEl.className = 'message-thinking';
                        thinkingEl.textContent = '思考中...';
                        thinkingBubble.insertBefore(thinkingEl, thinkingBubble.firstChild);
                    }
                    thinkingEl.textContent = '思考中...\n' + text;
                    this.scrollToBottom();
                },
                onDelta: (delta) => {
                    // 回答开始：思考区域标记完成（停止闪烁动画）
                    if (thinkingEl && !thinkingDone) {
                        thinkingDone = true;
                        thinkingEl.classList.add('done');
                    }
                    aiMsg.content += delta;
                    if (!renderScheduled) {
                        renderScheduled = true;
                        rafId = requestAnimationFrame(() => {
                            renderScheduled = false;
                            rafId = null;
                            const now = Date.now();
                            if (now - lastRender >= 30) {
                                lastRender = now;
                                this.updateMessageContent(aiMsg, aiMsg.content, true);
                            }
                        });
                    }
                }
            });
            // 流已结束：取消挂起的渲染帧，交给下面的最终渲染兜底
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            aiMsg.content = content;
            this.updateMessageContent(aiMsg, content, false);
            this.messages.push(aiMsg);
        } catch (error) {
            console.error('AI API 调用失败:', error);
            // 取消挂起的渲染帧：报错时气泡可能被移除，防止"幽灵 rAF"把半截内容渲染进上一条气泡
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            // 移除"只有加载提示 / 空内容"的 AI 气泡
            const last = this.messagesContainer.lastElementChild;
            if (last && last.classList.contains('chat-message')) {
                const bubble = last.querySelector('.chat-bubble');
                const textEl = bubble && bubble.querySelector('.message-text');
                const loadingEl = bubble && bubble.querySelector('.message-loading');
                if (!textEl || (!textEl.textContent.trim() && loadingEl)) {
                    stopOrbCanvas(loadingEl ? loadingEl.querySelector('canvas') : null);
                    last.remove();
                }
            }
            let errorMsg;
            if (/Failed to fetch|fetch|Network/i.test(error.message || '')) {
                errorMsg = '⚠️ 无法连接到 AI 服务（可能是网络问题或 Worker 跨境连接超时）。请稍后重试，或检查网络。';
            } else if (/超时|timeout|AbortError/i.test(error.message || '')) {
                errorMsg = '请求超时，请稍后重试';
            } else if (/API|AI|密钥|404|1042/i.test(error.message || '')) {
                errorMsg = this.config?.ui?.errorMessages?.apiError || 'AI 服务暂时无法响应，请稍后再试';
            } else {
                errorMsg = this.config?.ui?.errorMessages?.unknownError || '出现了未知错误，请重新尝试';
            }
            this.showError(errorMsg);
        } finally {
            this.sendBtn.disabled = false;
            this.sendBtn.innerHTML = originalHtml;
            this.isRequestPending = false;
        }
    }

    async callAIAPI(userMessage, options = {}) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            throw new Error('当前网络不可用');
        }
        const { strategy, image, onDelta, onReasoning } = options;
        const hasImage = !!image;
        const thinkingMode = this.config.thinkingMode === true && !hasImage;

        const enhancedSystemPrompt = this.systemPrompt + `\n\n重要提醒：${this.getCurrentTime()}，请确保时间信息的准确性。`;
        // this.messages 已包含刚发送的 userMsg，无需重复追加
        const messageHistory = [
            { role: 'system', content: enhancedSystemPrompt },
            ...this.messages.slice(-this.maxMessages).map(msg => {
                const item = {
                    role: msg.role === 'ai' ? 'assistant' : msg.role,
                    content: typeof msg.content === 'string' ? msg.content : ''
                };
                // SiliconFlow 思考模式要求：上一轮 assistant 的 reasoning_content 必须原样回传，
                // 否则多轮对话报 400："The reasoning_content in the thinking mode must be passed back to the API."
                // 但仅当本轮仍处于思考模式时才回传：关闭思考或识图（enable_thinking=false）时
                // 仍携带 reasoning_content 会被平台判定参数非法
                if (item.role === 'assistant' && thinkingMode && msg.reasoningContent) {
                    item.reasoning_content = msg.reasoningContent;
                }
                return item;
            })
        ];

        // 识图/OCR 为非流式请求，模型需理解图片+一次性生成文本，耗时长，放宽超时；
        // 文本对话走流式逐字输出，30s 足够
        const timeoutMs = hasImage ? 90000 : 30000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const strategyCfg = strategy || {};
        const isStream = this.config.stream !== false && !hasImage;
        this._isStreaming = isStream;

        try {
            const response = await fetch(this.functionUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': isStream ? 'text/event-stream' : 'application/json'
                },
                body: JSON.stringify({
                    messages: messageHistory,
                    // 图片消息自动切换到多模态模型
                    model: hasImage ? this.config.imageModel : this.model,
                    injectKnowledge: true,
                    stream: isStream,
                    temperature: strategyCfg.temperature ?? 0.5,
                    // 思考模式开启时翻倍输出上限（思考+回答都计入 max_tokens），上限 4000
                    max_tokens: thinkingMode
                        ? Math.min((strategyCfg.maxTokens ?? 800) * 2, 4000)
                        : (strategyCfg.maxTokens ?? 800),
                    ...(hasImage ? { image, imageMode: 'understand' } : {}),
                    ...(thinkingMode ? { enable_thinking: true } : {})
                }),
                signal: controller.signal,
                cache: 'no-store'
            });
            clearTimeout(timer);

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                throw new Error(`AI 服务请求失败：${response.status}${errText ? ` ${errText.slice(0, 200)}` : ''}`);
            }

            if (hasImage) {
                const data = await response.json();
                return data?.choices?.[0]?.message?.content
                    || data?.message?.content
                    || '';
            }
            if (isStream) {
                return await this.parseSSE(response, onDelta);
            }
            const data = await response.json();
            return data?.choices?.[0]?.message?.content
                || data?.message?.content
                || '';
        } catch (err) {
            clearTimeout(timer);
            if (err?.name === 'AbortError') throw new Error('请求超时');
            throw err;
        } finally {
            this._isStreaming = false;
        }
    }

    // SSE 流式解析（OpenAI/SiliconFlow 兼容；支持思考模式 reasoning_content）
    async parseSSE(response, onDelta, onReasoning) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let fullText = '';
        let reasoningLen = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let lineEnd;
            while ((lineEnd = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, lineEnd).trim();
                buffer = buffer.slice(lineEnd + 1);
                if (!line || !line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (payload === '[DONE]') continue;
                try {
                    const json = JSON.parse(payload);
                    const frame = json.choices?.[0]?.delta || {};
                    // 思考内容（Qwen3.5 思考模式）
                    const reasoning = frame.reasoning_content;
                    if (typeof reasoning === 'string' && reasoning) {
                        reasoningLen += reasoning.length;
                        if (onReasoning) onReasoning(reasoning);
                    }
                    // 正式回答
                    const delta = frame.content;
                    if (typeof delta === 'string' && delta) {
                        fullText += delta;
                        if (onDelta) onDelta(delta);
                    }
                } catch (e) { /* 忽略无法解析的帧 */ }
            }
        }
        if (!fullText) {
            // 思考完成但未输出回答（思考可能耗尽了输出上限）——给友好提示
            throw new Error(reasoningLen > 0
                ? '模型思考完成但未输出回答（可能输出超限），请重试或关闭思考模式'
                : 'AI 流式响应为空，请稍后重试');
        }
        return fullText;
    }

    addMessage(message) {
        const messageDiv = document.createElement('div');
        const displayRole = message.role === 'assistant' ? 'assistant' : 'user';
        messageDiv.className = `chat-message ${displayRole}`;

        const avatar = document.createElement('div');
        avatar.className = `chat-avatar ${displayRole}`;
        avatar.innerHTML = displayRole === 'user'
            ? '<i data-lucide="user"></i>'
            : '';
        // 渲染头像中的 Lucide 图标
        if (displayRole === 'user' && typeof lucide !== 'undefined') {
            lucide.createIcons({ nodes: [avatar] });
        }

        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';

        if (message.image) {
            const imgContainer = document.createElement('div');
            imgContainer.className = 'message-image-container';
            const img = document.createElement('img');
            img.src = message.image;
            img.className = 'message-image';
            img.alt = message.imageName || '图片';
            img.title = '点击查看大图';
            img.addEventListener('click', () => this.openLightbox(message.image));
            imgContainer.appendChild(img);
            bubble.appendChild(imgContainer);
        }

        if (message.content) {
            const textEl = document.createElement('div');
            textEl.className = 'message-text';
            textEl.innerHTML = this.formatContent(message.content);
            bubble.appendChild(textEl);
        }

        messageDiv.appendChild(avatar);
        messageDiv.appendChild(bubble);
        this.messagesContainer.appendChild(messageDiv);
        this.scrollToBottom(true);
    }

    // 图片灯箱：打开
    openLightbox(src) {
        this.lightboxImg.src = src;
        this.lightbox.classList.add('show');
        document.body.style.overflow = 'hidden';
    }

    // 图片灯箱：关闭
    closeLightbox() {
        this.lightbox.classList.remove('show');
        this.lightboxImg.src = '';
        document.body.style.overflow = '';
    }

    // 流式更新最后一条 AI 气泡
    updateMessageContent(msg, content, isStream) {
        const msgDivs = this.messagesContainer.querySelectorAll('.chat-message.assistant');
        const lastDiv = msgDivs[msgDivs.length - 1];
        if (!lastDiv) return;
        const bubble = lastDiv.querySelector('.chat-bubble');
        if (!bubble) return;
        // 移除加载提示
        const loadingEl = bubble.querySelector('.message-loading');
        if (loadingEl) {
            stopOrbCanvas(loadingEl.querySelector('canvas'));
            loadingEl.remove();
        }
        let textEl = bubble.querySelector('.message-text');
        if (!textEl) {
            textEl = document.createElement('div');
            textEl.className = 'message-text';
            bubble.appendChild(textEl);
        }
        textEl.innerHTML = this.formatContent(content || '');
        if (isStream) this.scrollToBottom();
    }

    // ═══ 轻量 Markdown 渲染（避免显示原始符号） ═══
    formatContent(content) {
        if (!content) return '';
        let text = content;

        // 1. 转义 HTML 特殊字符
        text = text.replace(/&/g, '&amp;')
                   .replace(/</g, '&lt;')
                   .replace(/>/g, '&gt;');

        // 2. 代码块（```...```）
        text = text.replace(/```([\s\S]*?)```/g, (m, code) =>
            `<pre><code>${code.trim()}</code></pre>`);

        // 3. 行内代码 `...`
        text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');

        // 4. 标题
        text = text.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
        text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
        text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
        text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');

        // 5. 水平线
        text = text.replace(/^---+$/gm, '<hr>');

        // 6. 无序列表（合并连续行）
        text = text.replace(/(^|\n)((?:[-*] [^\n]+(?:\n|$))+)/g, (m, prefix, list) => {
            const items = list.trim().split('\n').map(l => l.replace(/^[-*] /, '')).filter(Boolean);
            return `${prefix}<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
        });

        // 7. 有序列表
        text = text.replace(/(^|\n)((?:\d+\. [^\n]+(?:\n|$))+)/g, (m, prefix, list) => {
            const items = list.trim().split('\n').map(l => l.replace(/^\d+\. /, '')).filter(Boolean);
            return `${prefix}<ol>${items.map(i => `<li>${i}</li>`).join('')}</ol>`;
        });

        // 8. 加粗
        text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

        // 9. 斜体（无 lookbehind，兼容所有浏览器）
        text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

        // 10. 链接
        text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
            '<a href="$2" target="_blank" rel="noopener">$1</a>');

        // 11. 段落：空行分段，单换行换 <br>
        const blocks = text.split(/\n{2,}/);
        text = blocks.map(b => {
            const trimmed = b.trim();
            if (!trimmed) return '';
            if (/^<(h[1-6]|ul|ol|hr|pre|div)/.test(trimmed)) return b;
            return `<p>${b.replace(/\n/g, '<br>')}</p>`;
        }).join('');

        return text;
    }

    validateAndCleanMessages() {
        this.messages = this.messages.filter(m => m && m.role &&
            ['user', 'assistant', 'system'].includes(m.role) &&
            (m.content || m.image))
            .map(m => {
                const item = {
                    role: m.role === 'ai' ? 'assistant' : m.role,
                    content: typeof m.content === 'string' ? m.content : ''
                };
                // 保留思考内容：SiliconFlow 思考模式要求下一轮请求原样回传 reasoning_content
                if (m.reasoningContent) item.reasoningContent = m.reasoningContent;
                return item;
            });
    }

    getCurrentTime() {
        const now = new Date();
        return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
    }

    classifyIntent(message) {
        const sc = this.config?.strategySettings;
        if (!sc || !sc.enabled) return sc?.defaultStrategy || { temperature: 0.5, maxTokens: 800 };
        const cls = sc.intentClassification || {};
        const lower = (message || '').toLowerCase();
        for (const [name, cfg] of Object.entries(cls)) {
            if (cfg.keywords?.some(k => lower.includes(k.toLowerCase()))) {
                return { temperature: cfg.temperature, maxTokens: cfg.maxTokens, focus: cfg.focus };
            }
        }
        return sc.defaultStrategy || { temperature: 0.5, maxTokens: 800 };
    }

    showError(msg) {
        const err = document.createElement('div');
        err.className = 'error-message';
        err.textContent = msg;
        this.messagesContainer.appendChild(err);
        this.scrollToBottom(true);
        // 网络错误延长显示时间，便于用户看到重试建议
        const ttl = /⚠️|网络|连接/.test(msg) ? 6000 : 3000;
        setTimeout(() => err.remove(), ttl);
    }

    addPulseEffect() {
        if (this.floatBtn) this.floatBtn.classList.add('pulse');
    }

    removePulseEffect() {
        if (this.floatBtn) this.floatBtn.classList.remove('pulse');
    }
}

// 初始化
let aiChatWidget = null;
document.addEventListener('DOMContentLoaded', function() {
    setTimeout(() => {
        aiChatWidget = new AIChatWidget();
        setTimeout(() => aiChatWidget?.addPulseEffect?.(), 2000);
    }, 500);
});
window.AIChatWidget = AIChatWidget;
window.getAIChatWidget = () => aiChatWidget;