/* ═══════════════════════════════════════════════════════════════
 * thermal-wordmark.js — 热熔字标渲染器（自包含，自初始化）
 *
 * 按规格实现（spec: wordmark resolves out of its own heat）：
 *  - 词表从 `[data-thermal-wordmark][data-words="A|B|C"]` 读取，`|` 分隔
 *  - 800×800 参考空间，s = min(w,h)/800；canvas 由容器宽度决定，aspect 800/240
 *  - THE CYCLE：3000ms 换词、内部 loop 4000ms（永不 self-wrap）；
 *    最右列 H(1.12)=862ms 点燃、R 330ms 成熟，词完成于 ~1192ms
 *  - THE CLOCK：q = (t - H(x)) / R(x)，x 归一化到词 ink span；
 *    H 表延伸到 x=-0.1..1.12（halo 有自己的时钟，避免截止线）
 *  - THE RAMP：13 锚点 (n,r,g,b,a)，颜色与覆盖率都来自 n = min(1, expo·(A/255)^1.4)
 *  - EXPOSURE：9 点表从 0 精确起，中段凸起到 heat=1.3，之后稳定在 1
 *  - BLUR：sigma(q) = ((1-s)(1-0.35q) + s·0.06(1-q)) · 0.22 · em，
 *    预渲染 20 级，逐像素选相邻两级亚像素混合；<1.5px 直接画原字
 *  - CRISP：over q，w = smoothstep((q-0.65)/0.35)，淡到 settled 灰白 214,213,214，
 *    coverage 淡到字形 raw AA alpha
 *  - TYPE：800-weight sans；em = 75·s·1.55（lowercase）/ 1.36（caps）；
 *    baseline = 400·s + em·0.28 / 0.36；水平拉伸 1.25；fit 74% 宽
 *  - prefers-reduced-motion：画最后一词（loop-1）settled 帧，永不动画
 *  - 开发钩子 `?thermalT=NNN`：冻结动画时钟到 NNN ms，渲染一帧即停
 * ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── 常量 ──────────────────────────────────────────────
  var SWAP_MS = 3000;                 // 换词间隔
  var ANIM_MS = 4000;                 // 内部 loop（比 swap 长，永不 self-wrap）
  var SETTLE_MS = 1250;               // 稳定期阈值（词完成于 ~1192ms，此后只画一帧）
  var STRETCH_Y = 1.5;                // pad 垂直拉伸（各向异性模糊）
  var STRETCH_X = 1.25;               // 字形水平拉伸
  var LUT_Q = 160;                    // LUT q 行数（高密度，防列线）
  var BLUR_LEVELS = 20;               // 预渲染模糊级数
  var CRISP_START = 0.65;             // crisp crossfade 起点（over q）
  var GREY = [37, 99, 235];         // settled 品牌蓝 #2563EB（8-23 决定：浅底高对比度）
  var HEAT = 1.3;                     // exposure 峰值
  var GHOST_TAIL = 0.06;              // ghost 拖尾系数
  var BLUR_FACTOR = 0.22;             // blur 相对 em 的比例
  var GAMMA = 1.4;                    // alpha gamma
  var DIRECT_PX = 1.5;                // 低于此 blur（CSS px）直接画原字
  var ASPECT = 240 / 800;             // canvas 高宽比（800/240 窄横幅）
  var FIT_W = 0.74;                   // fit 74% 画布宽度
  var TYPE_EM = 75;                   // TYPE 字号基准（800 参考）
  var SIZE = 2.6;                     // 字号乘数：8-23 中文长词 em≈48px（fit 74% 兜底）
  var DPR_CAP = 2;                    // devicePixelRatio 上限（性能）
  var FONT_FAMILY = "'Inter','Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif";
  var FONT_WEIGHT = 800;

  // THE CLOCK — H 点燃时刻（ms），x 归一化到 ink span，向两端继续延伸
  var H_XS = [-0.1, 0, 0.15, 0.3, 0.5, 0.7, 0.85, 1, 1.12];
  var H_YS = [520, 280, 390, 470, 570, 660, 725, 790, 862];
  // R 成熟时长（ms）：U 形，首字慢燃、中间快、末字长收尾
  var R_XS = [0, 0.25, 0.5, 0.75, 1];
  var R_YS = [400, 230, 170, 200, 330];

  // THE RAMP — (n, r, g, b, alpha)，线性插值，两端 clamp
  var RAMP = [
    [0.055, 120, 200, 190, 0.0],
    [0.105, 165, 235, 222, 0.45],
    [0.19, 181, 240, 216, 0.9],
    [0.3, 187, 242, 197, 1.0],
    [0.4, 205, 247, 140, 1.0],
    [0.48, 225, 251, 92, 1.0],
    [0.59, 232, 200, 85, 1.0],
    [0.665, 240, 140, 88, 1.0],
    [0.735, 249, 50, 90, 1.0],
    [0.87, 250, 30, 95, 1.0],
    [0.93, 253, 150, 190, 1.0],
    [0.97, 255, 252, 252, 1.0],
    [1.0, 214, 213, 214, 1.0]
  ];

  // EXPOSURE — over q，从 0 精确起，中段凸起，之后稳定在 1
  var EXPO_XS = [0, 0.04, 0.1, 0.18, 0.28, 0.38, 0.48, 0.56, 1];
  var EXPO_YS = [0, 0.5, 1.0, 1.4 * (HEAT / 1.6), HEAT, 1.35 * (HEAT / 1.6), 1.05, 1.0, 1.0];

  // ── 工具函数 ──────────────────────────────────────────
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(x) { x = clamp01(x); return x * x * (3 - 2 * x); }

  // Catmull-Rom 一维插值（p0..p3 控制点，t∈[0,1]）
  function catmullRom(t, p0, p1, p2, p3) {
    var t2 = t * t, t3 = t2 * t;
    return 0.5 * (
      (2 * p1) +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
  }

  // 曲线采样：Catmull-Rom 过锚点，两端线性外推
  function curveSample(xs, ys, x) {
    var n = xs.length;
    if (x <= xs[0]) {
      return ys[0] - (xs[1] > xs[0] ? ((ys[1] - ys[0]) / (xs[1] - xs[0])) * (xs[0] - x) : 0);
    }
    if (x >= xs[n - 1]) {
      return ys[n - 1] + ((ys[n - 1] - ys[n - 2]) / (xs[n - 1] - xs[n - 2])) * (x - xs[n - 1]);
    }
    for (var i = 0; i < n - 1; i++) {
      if (x >= xs[i] && x <= xs[i + 1]) {
        var t = (x - xs[i]) / (xs[i + 1] - xs[i]);
        var p0 = ys[Math.max(i - 1, 0)];
        var p1 = ys[i];
        var p2 = ys[i + 1];
        var p3 = ys[Math.min(i + 2, n - 1)];
        return catmullRom(t, p0, p1, p2, p3);
      }
    }
    return ys[n - 1];
  }

  function ignite(nx) { return curveSample(H_XS, H_YS, nx); }
  function ripen(nx) { return curveSample(R_XS, R_YS, nx); }
  function exposure(q) { return curveSample(EXPO_XS, EXPO_YS, clamp01(q)); }

  // ramp 采样（Catmull-Rom 4 通道），n 越界两端 clamp
  function rampSample(n) {
    n = clamp01(n);
    if (n <= RAMP[0][0]) {
      return [RAMP[0][1], RAMP[0][2], RAMP[0][3], RAMP[0][4]];
    }
    if (n >= RAMP[RAMP.length - 1][0]) {
      var last = RAMP[RAMP.length - 1];
      return [last[1], last[2], last[3], last[4]];
    }
    var i;
    for (i = 0; i < RAMP.length - 1; i++) {
      if (n >= RAMP[i][0] && n <= RAMP[i + 1][0]) break;
    }
    var p0 = RAMP[Math.max(i - 1, 0)];
    var p1 = RAMP[i];
    var p2 = RAMP[i + 1];
    var p3 = RAMP[Math.min(i + 2, RAMP.length - 1)];
    var t = (n - p1[0]) / (p2[0] - p1[0] || 1);
    return [
      catmullRom(t, p0[1], p1[1], p2[1], p3[1]),
      catmullRom(t, p0[2], p1[2], p2[2], p3[2]),
      catmullRom(t, p0[3], p1[3], p2[3], p3[3]),
      catmullRom(t, p0[4], p1[4], p2[4], p3[4])
    ];
  }

  // ── LUT：160 q 行 × 256 alpha → [r,g,b,cov] ───────────
  var LUT = null;
  function buildLUT() {
    LUT = new Uint8Array(LUT_Q * 256 * 4);
    for (var qi = 0; qi < LUT_Q; qi++) {
      var q = qi / (LUT_Q - 1);
      var expo = exposure(q);
      var w = smoothstep((q - CRISP_START) / (1 - CRISP_START));   // crisp over q
      for (var a = 0; a < 256; a++) {
        var n = Math.min(1, expo * Math.pow(a / 255, GAMMA));
        var t = rampSample(n);              // [r,g,b,a] 热色
        var r = t[0], g = t[1], b = t[2], cov = t[3];
        if (w > 0) {
          // crisp：颜色淡到 settled 灰白，coverage 淡到 raw AA alpha
          r = lerp(r, GREY[0], w);
          g = lerp(g, GREY[1], w);
          b = lerp(b, GREY[2], w);
          cov = lerp(cov, a / 255, w);
        }
        var idx = (qi * 256 + a) * 4;
        LUT[idx] = r;
        LUT[idx + 1] = g;
        LUT[idx + 2] = b;
        LUT[idx + 3] = Math.round(cov * 255);
      }
    }
  }

  // ── 高斯模糊（3 遍 box blur 近似，作用于 Uint8Array）──
  function boxBlurH(src, dst, w, h, r) {
    var inv = 1 / (2 * r + 1);
    for (var y = 0; y < h; y++) {
      var row = y * w;
      var sum = 0;
      for (var x = -r; x <= r; x++) sum += src[row + (x < 0 ? 0 : x >= w ? w - 1 : x)];
      for (var x = 0; x < w; x++) {
        dst[row + x] = sum * inv;
        var xIn = x + r + 1, xOut = x - r;
        sum += src[row + (xIn < 0 ? 0 : xIn >= w ? w - 1 : xIn)];
        sum -= src[row + (xOut < 0 ? 0 : xOut >= w ? w - 1 : xOut)];
      }
    }
  }
  function boxBlurV(src, dst, w, h, r) {
    var inv = 1 / (2 * r + 1);
    for (var x = 0; x < w; x++) {
      var sum = 0;
      for (var y = -r; y <= r; y++) {
        var yy = y < 0 ? 0 : y >= h ? h - 1 : y;
        sum += src[yy * w + x];
      }
      for (var y = 0; y < h; y++) {
        dst[y * w + x] = sum * inv;
        var yIn = y + r + 1, yOut = y - r;
        var yyIn = yIn < 0 ? 0 : yIn >= h ? h - 1 : yIn;
        var yyOut = yOut < 0 ? 0 : yOut >= h ? h - 1 : yOut;
        sum += src[yyIn * w + x];
        sum -= src[yyOut * w + x];
      }
    }
  }
  function blurAlpha(src, w, h, sigma) {
    var r = Math.max(1, Math.round(sigma * 1.2));
    var tmp = new Uint8Array(src.length);
    var out = new Uint8Array(src.length);
    boxBlurH(src, tmp, w, h, r);
    boxBlurV(tmp, out, w, h, r);
    boxBlurH(out, tmp, w, h, r);
    return tmp;
  }

  // ── 共享时钟（多实例订阅制，单 module-level index + timer）──
  var clock = {
    index: 0,
    cycleStart: 0,
    rafId: null,
    swapTimer: null,
    frozenT: null,           // ?thermalT=NNN 冻结值
    subscribers: [],
    running: false,

    start: function () {
      if (this.running) return;
      this.running = true;
      this.cycleStart = performance.now();
      this.tick();
    },
    stop: function () {
      this.running = false;
      if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
      if (this.swapTimer) { clearTimeout(this.swapTimer); this.swapTimer = null; }
    },
    tick: function () {
      if (!this.running) return;
      var t = performance.now() - this.cycleStart;
      for (var i = 0; i < this.subscribers.length; i++) this.subscribers[i].render(t);
      if (t >= SETTLE_MS) {
        // 稳定期：只画这一帧，等 SWAP_MS 换词
        this.rafId = null;
        this.swapTimer = setTimeout(function () { clock.next(); }, Math.max(16, SWAP_MS - t));
      } else {
        this.rafId = requestAnimationFrame(function () { clock.tick(); });
      }
    },
    next: function () {
      this.swapTimer = null;
      this.index++;
      this.cycleStart = performance.now();
      for (var i = 0; i < this.subscribers.length; i++) {
        this.subscribers[i].prepareWord(this.index);
      }
      this.tick();
    }
  };

  // ── 实例 ─────────────────────────────────────────────
  function Wordmark(hostEl) {
    this.host = hostEl;
    this.canvas = hostEl.querySelector('canvas.thermal-wordmark-canvas');
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.words = [];
    this.dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    this.cssW = 0;
    this.cssH = 0;
    this.em = 0;
    this.inkLeft = 0;
    this.inkSpan = 0;        // 字 ink 宽度（含水平拉伸）
    this.buildId = 0;
    this.padW = 0;
    this.padH = 0;
    this.blurStack = [];

    var wordsAttr = hostEl.getAttribute('data-words');
    this.words = wordsAttr ? wordsAttr.split('|').filter(function (s) { return s.trim(); }) : [];

    if (!this.canvas || !this.ctx || this.words.length === 0) return;

    this.alignLeft = !window.matchMedia('(max-width: 767px)').matches;
    this.invalidateLayout = this.invalidateLayout.bind(this);
    this.prepareWord(clock.index);
  }

  function isCapsWord(w) { return /^[A-Z0-9\s'\-]+$/.test(w); }

  // 计算布局并重建 pad + 模糊栈
  Wordmark.prototype.buildLayout = function (wordIdx) {
    var word = this.words[wordIdx % this.words.length];
    if (!word) return;

    this.cssW = Math.max(this.host.clientWidth || 320, 160);
    this.cssH = Math.round(this.cssW * ASPECT);
    var dpr = this.dpr;
    var W = Math.max(1, Math.round(this.cssW * dpr));
    var H = Math.max(1, Math.round(this.cssH * dpr));

    this.canvas.style.width = this.cssW + 'px';
    this.canvas.style.height = this.cssH + 'px';
    this.canvas.width = W;
    this.canvas.height = H;

    var ctx = this.ctx;
    var sRef = Math.min(this.cssW, this.cssH) / 800;   // 800 参考空间缩放

    // TYPE：em = 75·s·1.55（lowercase）/ 1.36（caps）；统一按所有词最宽 fit 74%
    var caps = isCapsWord(word);
    this.em = TYPE_EM * sRef * (caps ? 1.36 : 1.55) * SIZE;
    if (this.em <= 0) this.em = this.cssH * 0.1;

    // 测所有词（含水平拉伸后的 ink 宽），找最宽者统一字号
    ctx.font = FONT_WEIGHT + ' ' + this.em + 'px ' + FONT_FAMILY;
    var maxInk = 0;
    for (var i = 0; i < this.words.length; i++) {
      var iw = ctx.measureText(this.words[i]).width * STRETCH_X;
      if (iw > maxInk) maxInk = iw;
    }
    if (maxInk > 0 && maxInk > FIT_W * this.cssW) {
      this.em *= FIT_W * this.cssW / maxInk;
      ctx.font = FONT_WEIGHT + ' ' + this.em + 'px ' + FONT_FAMILY;
    }

    // 当前词 ink 几何（水平拉伸后）
    var textW = ctx.measureText(word).width;
    this.inkSpan = textW * STRETCH_X;
    this.inkLeft = this.alignLeft ? this.cssW * 0.06 : (this.cssW - this.inkSpan) / 2;

    // baseline：光学校准 400·s + em·0.28（lowercase）/ 0.36（caps）
    var baselineY = 400 * sRef + this.em * (caps ? 0.36 : 0.28);

    // pad：物理像素，垂直拉伸 STRETCH_Y，字形水平拉伸 STRETCH_X
    this.padW = W;
    this.padH = Math.max(1, Math.round(H * STRETCH_Y));
    var pad = document.createElement('canvas');
    pad.width = this.padW;
    pad.height = this.padH;
    var pctx = pad.getContext('2d');
    pctx.clearRect(0, 0, this.padW, this.padH);
    pctx.font = FONT_WEIGHT + ' ' + (this.em * dpr) + 'px ' + FONT_FAMILY;
    pctx.textAlign = 'left';
    pctx.textBaseline = 'alphabetic';
    pctx.fillStyle = '#fff';
    pctx.translate(this.inkLeft * dpr, baselineY * dpr * STRETCH_Y);
    pctx.scale(STRETCH_X, 1);
    pctx.fillText(word, 0, 0);

    // 提取 alpha 通道
    var imgData = pctx.getImageData(0, 0, this.padW, this.padH);
    var alpha = new Uint8Array(this.padW * this.padH);
    var d = imgData.data;
    for (var p = 0, n = alpha.length; p < n; p++) alpha[p] = d[p * 4 + 3];

    // 预渲染 20 级各向异性模糊：sigma_k 从 maxSigma 递减到 0
    // maxSigma = sigma(0) = 0.22·em；< 1.5px 的级直接画原字（避免往返软化）
    var maxSigma = BLUR_FACTOR * this.em;
    this.blurStack = [];
    for (var k = 0; k < BLUR_LEVELS; k++) {
      var sk = (BLUR_LEVELS - 1 - k) / (BLUR_LEVELS - 1) * maxSigma;
      if (sk < DIRECT_PX || k === BLUR_LEVELS - 1) {
        this.blurStack.push(alpha);
      } else {
        this.blurStack.push(blurAlpha(alpha, this.padW, this.padH, sk * dpr));
      }
    }
  };

  // 动态 blur sigma（CSS px）
  function sigmaAt(q, em) {
    var s = smoothstep((q - 0.18) / 0.47);
    var sig = (1 - s) * (1 - 0.35 * q) + s * GHOST_TAIL * (1 - q);
    return sig * BLUR_FACTOR * em;
  }

  Wordmark.prototype.prepareWord = function (wordIdx) {
    this.buildId++;
    this.lastWordIndex = wordIdx % this.words.length;
    this.buildLayout(this.lastWordIndex);
  };

  // 逐像素合成主渲染
  Wordmark.prototype.render = function (tMs) {
    if (!this.ctx || !this.blurStack.length) return;
    if (clock.frozenT !== null) tMs = clock.frozenT;

    var W = this.canvas.width, H = this.canvas.height;
    var padW = this.padW, padH = this.padH;
    var dpr = this.dpr;
    var imgData = this.ctx.createImageData(W, H);
    var out = imgData.data;
    var stack = this.blurStack;            // Array of Uint8Array（每级独立）
    var maxSigma = BLUR_FACTOR * this.em;
    var maxLevel = BLUR_LEVELS - 1;

    for (var py = 0; py < H; py++) {
      var padY = py * STRETCH_Y;
      var padYi = padY | 0;
      if (padYi >= padH) padYi = padH - 1;
      var padYf = padY - padYi;
      var rowA = padYi * padW;
      var rowB = Math.min(padYi + 1, padH - 1) * padW;

      for (var px = 0; px < W; px++) {
        // x 归一化到 ink span（0 = 字左缘，1 = 字右缘；halo 延伸到词外）
        var cssX = px / dpr;
        var nx = (cssX - this.inkLeft) / (this.inkSpan || 1);
        var tH = ignite(nx);
        var tR = ripen(nx);
        var q = (tMs - tH) / tR;
        if (q <= 0) continue;              // 未点燃列不画
        if (q > 1) q = 1;

        // blur 级：目标 sigma(q) → 相邻两级亚像素混合
        var sig = sigmaAt(q, this.em);
        var bf = (1 - sig / maxSigma) * maxLevel;
        var b0 = bf | 0;
        var b1 = b0 + 1 <= maxLevel ? b0 + 1 : b0;
        var fbf = bf - b0;
        var lev0 = stack[b0];
        var lev1 = stack[b1];

        var a0 = lev0[rowA + px];
        var a0b = lev0[rowB + px];
        var a1 = lev1[rowA + px];
        var a1b = lev1[rowB + px];
        var aY0 = a0 + (a0b - a0) * padYf;
        var aY1 = a1 + (a1b - a1) * padYf;
        var alpha = aY0 + (aY1 - aY0) * fbf;
        if (alpha <= 1) continue;

        // LUT 行双线性（q 亚像素）
        var qr = q * (LUT_Q - 1);
        var q0 = qr | 0;
        var q1 = q0 + 1 < LUT_Q ? q0 + 1 : q0;
        var fq = qr - q0;
        var li0 = (q0 * 256 + alpha) * 4;
        var li1 = (q1 * 256 + alpha) * 4;

        var idx = (py * W + px) * 4;
        out[idx] = LUT[li0] + (LUT[li1] - LUT[li0]) * fq;
        out[idx + 1] = LUT[li0 + 1] + (LUT[li1 + 1] - LUT[li0 + 1]) * fq;
        out[idx + 2] = LUT[li0 + 2] + (LUT[li1 + 2] - LUT[li0 + 2]) * fq;
        out[idx + 3] = LUT[li0 + 3] + (LUT[li1 + 3] - LUT[li0 + 3]) * fq;
      }
    }
    this.ctx.putImageData(imgData, 0, 0);
  };

  // settled 帧：reduced-motion 画最后一词（loop - 1），永不动画
  Wordmark.prototype.renderSettled = function () {
    this.prepareWord(this.words.length - 1);
    this.render(SETTLE_MS + 1000);
  };

  Wordmark.prototype.invalidateLayout = function () {
    var self = this;
    var id = ++this.buildId;
    // 同步响应式状态（跨 767px 阈值 / 跨屏 dpr 变化）
    this.alignLeft = !window.matchMedia('(max-width: 767px)').matches;
    this.dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    // 防抖：尺寸/字体变化后重建
    setTimeout(function () {
      if (id !== self.buildId) return;
      self.prepareWord(clock.index);
      if (clock.frozenT !== null) {
        self.render(clock.frozenT);
      } else if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        self.renderSettled();
      } else if (clock.running) {
        self.render(performance.now() - clock.cycleStart);
      }
    }, 60);
  };

  // ── 初始化 ────────────────────────────────────────────
  function init() {
    var hosts = document.querySelectorAll('[data-thermal-wordmark]');
    if (!hosts.length) return;

    buildLUT();

    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var params = new URLSearchParams(window.location.search);
    var freezeParam = params.get('thermalT');
    clock.frozenT = freezeParam !== null && freezeParam !== '' ? Number(freezeParam) : null;

    var inst;
    for (var i = 0; i < hosts.length; i++) {
      inst = new Wordmark(hosts[i]);
      if (inst.ctx && inst.words.length) {
        clock.subscribers.push(inst);

        // 离屏暂停
        if ('IntersectionObserver' in window) {
          (function (it) {
            var io = new IntersectionObserver(function (entries) {
              entries.forEach(function (e) {
                if (e.isIntersecting) {
                  if (!clock.running && clock.frozenT === null && !reduceMotion) clock.start();
                } else {
                  clock.stop();
                }
              });
            }, { rootMargin: '100px' });
            io.observe(it.host);
          })(inst);
        }

        // 尺寸变化 + 字体加载后重排
        if ('ResizeObserver' in window) {
          new ResizeObserver(function () { inst.invalidateLayout(); }).observe(inst.host);
        }
      }
    }

    // 字体加载完成后重跑布局（canvas 同步测量，字体未载会静默 fallback）
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        for (var j = 0; j < clock.subscribers.length; j++) clock.subscribers[j].invalidateLayout();
      });
    }

    if (clock.frozenT !== null) {
      // 开发钩子：渲染一帧即停
      clock.cycleStart = 0;
      for (var k = 0; k < clock.subscribers.length; k++) {
        clock.subscribers[k].prepareWord(clock.index);
        clock.subscribers[k].render(clock.frozenT);
      }
      return;
    }

    if (reduceMotion) {
      for (var m = 0; m < clock.subscribers.length; m++) clock.subscribers[m].renderSettled();
      return;
    }

    clock.start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
