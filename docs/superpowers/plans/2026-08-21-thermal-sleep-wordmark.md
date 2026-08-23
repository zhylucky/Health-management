# 首页热熔睡眠 Wordmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在首页 Hero 左侧标题区域加入黑色响应式 thermal wordmark canvas，让 `SLEEP`、`REST`、`HEALTH` 每 3000ms 共享同步地热熔切换，同时保留中文标题与现有白色/浅蓝页面背景。

**Architecture:** 继续使用现有静态 HTML/CSS/JavaScript 结构。`index.html` 只提供 canvas、中文标题和无障碍文本；`css/index.css` 负责黑色标题舱的比例与响应式尺寸；`js/index.js` 在 DOMContentLoaded 回调之外定义模块级共享时钟与渲染 helpers，在回调内部挂载 canvas，使用每次布局预渲染的 20 级 blur alpha、160×256 LUT 和 requestAnimationFrame 逐像素合成。

**Tech Stack:** 原生 HTML、CSS、Canvas 2D、Uint8Array、requestAnimationFrame、ResizeObserver、现有 `js/index.js` 初始化流程。

---

## 文件结构与边界

- Modify: `index.html:84-87` — 将现有 Hero 标题替换为黑色标题舱结构，保留中文语义和屏幕阅读器文本。
- Modify: `css/index.css:371-388` 以及 Hero 响应式区 — 增加标题舱、canvas 尺寸和 reduced-motion 降级样式，不改全站背景。
- Modify: `js/index.js` — 在现有 DOMContentLoaded 初始化末尾加入 wordmark 模块；共享时钟、布局、预渲染、LUT 和绘制逻辑均限制在此模块中。
- Verify: `package.json` — 使用现有 `build` 脚本和 Node 语法检查，不新增依赖。

### Task 1: 更新 Hero 标题结构和可访问内容

**Files:**
- Modify: `index.html:84-87`

- [ ] **Step 1: 替换现有标题节点**

将现有：

```html
<h1 id="hero-title">
    <span class="hero-label">AI睡眠健康分析平台</span>
    <span class="hero-headline">用一夜的数据<br>读懂你的睡眠与健康</span>
</h1>
```

替换为：

```html
<h1 id="hero-title" class="hero-title-panel">
    <span class="thermal-wordmark" data-thermal-wordmark>
        <canvas class="thermal-wordmark-canvas" width="800" height="800" aria-hidden="true"></canvas>
        <span class="sr-only">SLEEP、REST、HEALTH 热熔循环</span>
    </span>
    <span class="hero-label">AI睡眠健康分析平台</span>
    <span class="hero-headline">用一夜的数据<br>读懂你的睡眠与健康</span>
</h1>
```

`canvas` 初始尺寸固定为 800×800，脚本后续根据实际 CSS 尺寸设置 backing store；`sr-only` 保证 canvas 动效不会成为唯一信息来源。

- [ ] **Step 2: 检查 DOM 结构没有改变 Hero 后续内容**

运行：

```powershell
rg -n -C 3 "hero-title|thermal-wordmark|hero-desc|hero-actions" index.html
```

预期：`hero-desc`、`hero-actions`、`hero-stats` 仍在原有标题之后，手机报告结构保持不变。

- [ ] **Step 3: 提交结构变更**

```powershell
git add -- index.html
git commit -m "feat: add thermal wordmark hero structure"
```

### Task 2: 建立黑色标题舱的响应式尺寸

**Files:**
- Modify: `css/index.css:371-388`、`css/index.css:1297-1335`

- [ ] **Step 1: 将现有 Hero 标题样式迁移到标题舱内部**

在 `.hero-label` 前增加以下样式，并保留 `.hero-label`、`.hero-headline` 的字体层级：

```css
.hero-title-panel {
    display: block;
    width: min(100%, 620px);
    min-height: 340px;
    margin: 0;
    padding: clamp(24px, 3.2vw, 42px);
    border-radius: 28px;
    background: #050505;
    color: #d6d5d6;
    overflow: hidden;
}

.thermal-wordmark {
    display: block;
    width: 100%;
    aspect-ratio: 800 / 210;
    margin: -4px 0 20px;
}

.thermal-wordmark-canvas {
    display: block;
    width: 100%;
    height: 100%;
}

.hero-title-panel .hero-label {
    margin-bottom: 10px;
    color: #8ba5ff;
}

.hero-title-panel .hero-headline {
    color: #f4f4f5;
    font-size: clamp(1.8rem, 4.7vw, 3rem);
    line-height: 1.12;
    letter-spacing: -0.04em;
}
```

The canvas remains visually wide enough to read as a wordmark, while the title panel owns the black background. Do not add CSS `text-shadow`, `filter`, `outline`, gradient, or separate glow to the thermal layer.

- [ ] **Step 2: Add mobile sizing without distorting the wordmark**

Inside the existing `@media (max-width: 768px)` and `@media (max-width: 480px)` blocks add:

```css
.hero-title-panel {
    width: 100%;
    min-height: 0;
    padding: 24px 20px 28px;
    border-radius: 22px;
    text-align: left;
}

.thermal-wordmark {
    aspect-ratio: 800 / 250;
    margin-bottom: 16px;
}

@media (max-width: 480px) {
    .hero-title-panel .hero-headline { font-size: 1.8rem; }
}
```

The existing mobile `text-align: center` applies to `.hero-grid-layout`; override only the panel so the Chinese title keeps a stable left edge and the canvas remains optically aligned.

- [ ] **Step 3: Add reduced-motion and screen-reader helper styles**

```css
.sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
}

@media (prefers-reduced-motion: reduce) {
    .hero-title-panel,
    .hero-title-panel * { animation: none !important; }
}
```

- [ ] **Step 4: Verify layout-only change**

```powershell
node --check js/index.js
npm run build
```

Expected: Node syntax check passes and the static build prints `Static site - no build needed`.

- [ ] **Step 5: Commit CSS layout**

```powershell
git add -- css/index.css
git commit -m "style: size thermal hero title panel responsively"
```

### Task 3: 建立共享 word cycle 和确定性的布局模型

**Files:**
- Modify: `js/index.js` before the existing `document.addEventListener('DOMContentLoaded', ...)`，并在回调末尾挂载

- [ ] **Step 1: Add one module-level coordinator**

Add a single coordinator before the DOMContentLoaded callback so multiple `[data-thermal-wordmark]` mounts share one index and one timer. The existing mobile-menu, nav, reveal, counter, and carousel code stays inside its current callback:

```js
var thermalWordCycle = (function() {
    var WORDS = ['SLEEP', 'REST', 'HEALTH'];
    var INTERVAL = 3000;
    var REVEAL_LOOP = 4000;
    var index = 0;
    var cycleStartedAt = 0;
    var timerId = null;
    var subscribers = [];

    function tick() {
        var now = performance.now();
        var elapsed = now - cycleStartedAt;
        if (elapsed >= INTERVAL) {
            var steps = Math.floor(elapsed / INTERVAL);
            index = (index + steps) % WORDS.length;
            cycleStartedAt += steps * INTERVAL;
        }
        subscribers.slice().forEach(function(render) { render(now); });
        timerId = window.requestAnimationFrame(tick);
    }

    function subscribe(render) {
        subscribers.push(render);
        if (!cycleStartedAt) cycleStartedAt = performance.now();
        if (!timerId) timerId = window.requestAnimationFrame(tick);
        return function() {
            subscribers = subscribers.filter(function(item) { return item !== render; });
            if (!subscribers.length && timerId) {
                window.cancelAnimationFrame(timerId);
                timerId = null;
            }
        };
    }

    return {
        words: WORDS,
        revealLoop: REVEAL_LOOP,
        subscribe: subscribe,
        getState: function(now) {
            return { index: index, elapsed: now - cycleStartedAt, word: WORDS[index] };
        }
    };
}());
```

The interval is 3000ms but `revealLoop` is 4000ms. The renderer clamps reveal progress to its current word's 0–1 window and resets to zero when `state.index` changes; it must never independently advance the word index.

- [ ] **Step 2: Add smooth interpolation helpers and fixed curves**

```js
function thermalClamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function thermalSmoothstep(edge0, edge1, value) {
    var x = thermalClamp((value - edge0) / (edge1 - edge0), 0, 1);
    return x * x * (3 - 2 * x);
}
function thermalLerp(a, b, t) { return a + (b - a) * t; }
function thermalSampleCurve(points, value) {
    if (value <= points[0][0]) return points[0][1];
    for (var i = 1; i < points.length; i += 1) {
        if (value <= points[i][0]) {
            var left = points[i - 1];
            var right = points[i];
            return thermalLerp(left[1], right[1], (value - left[0]) / (right[0] - left[0]));
        }
    }
    return points[points.length - 1][1];
}

var IGNITE = [[-0.1,520],[0,280],[0.15,390],[0.3,470],[0.5,570],[0.7,660],[0.85,725],[1,790],[1.12,862]];
var RIPEN = [[0,400],[0.25,230],[0.5,170],[0.75,200],[1,330]];
var HEAT = 1.3;
var HS = HEAT / 1.6;
var EXPOSURE = [[0,0],[0.04,0.5],[0.1,1],[0.18,1.4 * HS],[0.28,HEAT],[0.38,1.35 * HS],[0.48,1.05],[0.56,1],[1,1]];
var RAMP = [[0.055,120,200,190,0],[0.105,165,235,222,0.45],[0.19,181,240,216,0.9],[0.3,187,242,197,1],[0.4,205,247,140,1],[0.48,225,251,92,1],[0.59,232,200,85,1],[0.665,240,140,88,1],[0.735,249,50,90,1],[0.87,250,30,95,1],[0.93,253,150,190,1],[0.97,255,252,252,1],[1,214,213,214,1]];

function sampleThermalRamp(stops, value) {
    if (value <= stops[0][0]) return stops[0].slice(1);
    for (var i = 1; i < stops.length; i += 1) {
        if (value <= stops[i][0]) {
            var left = stops[i - 1];
            var right = stops[i];
            var t = (value - left[0]) / (right[0] - left[0]);
            return [
                Math.round(thermalLerp(left[1], right[1], t)),
                Math.round(thermalLerp(left[2], right[2], t)),
                Math.round(thermalLerp(left[3], right[3], t)),
                thermalLerp(left[4], right[4], t)
            ];
        }
    }
    return stops[stops.length - 1].slice(1);
}
```

- [ ] **Step 3: Add the 800×800 word layout function**

For each word layout, measure with the loaded 800-weight sans context, draw at caps size `75 * s * 1.36`, horizontally scale the glyph by `1.25`, fit the ink span to at most 74% of the reference width, and center it optically. Use baseline `400 + em * 0.36` in reference coordinates. Re-run this function from `document.fonts.load('800 100px Inter')` and from the canvas `ResizeObserver` callback.

Return one layout object containing `word`, `width`, `height`, `inkLeft`, `inkRight`, `rawAlpha`, exactly 20 `blurLevels`, and the 160×256 `lut`. Render into a padded offscreen canvas so the `x = -0.1` and `x = 1.12` ignite samples have room; the raw alpha stays anti-aliased and is never thresholded.

- [ ] **Step 4: Verify timing/layout code parses**

```powershell
node --check js/index.js
```

Expected: no syntax errors. Browser rendering is verified in Task 6.

- [ ] **Step 5: Commit the timing/layout layer**

```powershell
git add -- js/index.js
git commit -m "feat: add shared thermal wordmark timing model"
```

### Task 4: Add blur-level precomputation, LUT generation, and pixel composition

**Files:**
- Modify: `js/index.js` in the thermal wordmark module from Task 3

- [ ] **Step 1: Pre-render exactly 20 blur levels per layout**

For blur level `i` from 0 through 19, draw the stretched glyph into an offscreen canvas and store its alpha channel in a flat `Uint8Array`. Apply the per-column model from the prompt:

```js
var q = (timeInWord - igniteMs) / ripenMs;
var s = thermalSmoothstep(0.18, 0.65, q);
var sigma = (1 - s) * (1 - 0.35 * q) + s * 0.06 * (1 - q);
var blurPx = Math.max(0, sigma * 0.22 * emPx);
```

Use a vertical stretch transform before blurring and squash it back afterward so the tail is anisotropic and biased along the sweep. If `blurPx < 1.5`, use the direct raw-alpha layer for the final crisp state.

- [ ] **Step 2: Build a 160×256 LUT for each layout**

For each q row `0..159` and blurred alpha byte `0..255`, compute:

```js
var exposure = thermalSampleCurve(EXPOSURE, q);
var normalized = Math.min(1, exposure * Math.pow(alpha / 255, 1.4));
var stop = sampleThermalRamp(RAMP, normalized);
```

Store four bytes per entry: `r`, `g`, `b`, `a`. In the crisp range, use `w = thermalSmoothstep(0.65, 1, q)` and blend thermal RGBA with `(214, 213, 214, rawAlpha)` using `w`, preserving raw anti-aliasing.

- [ ] **Step 3: Compose each complete frame per pixel**

For each device pixel `(x, y)`, normalize x against the padded ink span `-0.1..1.12`, sample `IGNITE` and `RIPEN`, compute q, and write transparent black when `q <= 0`. Otherwise select two neighboring blur levels, interpolate their alpha bytes, clamp q to 0..1, map it to `Math.round(q * 159)`, and read the LUT RGBA. Reuse a single `ImageData` buffer per resize and call `putImageData` once after the full buffer is populated; never assemble vertical strips.

- [ ] **Step 4: Hold the settled word until the shared swap**

The last column completes at `862 + 330 = 1192ms`. From then until the 3000ms swap, render the settled gray-white wordmark from the LUT/raw alpha. At the next shared index, rebuild the layout for the new word and restart q at zero. Do not allow the 4000ms reveal loop to wrap.

- [ ] **Step 5: Commit the thermal renderer**

```powershell
git add -- js/index.js
git commit -m "feat: render thermal wordmark from blur alpha LUT"
```

### Task 5: Mount, resize, load fonts, and honor reduced motion

**Files:**
- Modify: `js/index.js` at the end of the existing DOMContentLoaded callback

- [ ] **Step 1: Mount every canvas through the shared coordinator**

Query all `[data-thermal-wordmark]` elements. Each canvas gets its own layout cache and `render(now)` closure, but subscribes to `thermalWordCycle`; it rebuilds only when `state.index` changes. No `setInterval` or per-mount `requestAnimationFrame` is allowed.

- [ ] **Step 2: Resize the backing store with device pixels**

On each panel resize, run:

```js
var rect = canvas.getBoundingClientRect();
var dpr = Math.min(window.devicePixelRatio || 1, 2);
var pixelWidth = Math.max(1, Math.round(rect.width * dpr));
var pixelHeight = Math.max(1, Math.round(rect.height * dpr));
canvas.width = pixelWidth;
canvas.height = pixelHeight;
renderer.resize(pixelWidth, pixelHeight);
```

Map the 800×800 reference space with `s = Math.min(pixelWidth, pixelHeight) / 800`; leave the CSS dimensions unchanged so backing-store resolution does not alter visual proportions.

- [ ] **Step 3: Re-run layout after font load**

```js
document.fonts.load('800 100px Inter').then(function() {
    renderers.forEach(function(renderer) { renderer.invalidateLayout(); });
});
```

Also invalidate from `document.fonts.ready` if the requested face is unavailable, so synchronous fallback measurements are refreshed.

- [ ] **Step 4: Implement the reduced-motion branch**

Use one `matchMedia('(prefers-reduced-motion: reduce)')` query. When true, render `HEALTH` once in the settled state and do not subscribe to the coordinator. On media-query changes, unsubscribe before switching back to animation and subscribe only once.

- [ ] **Step 5: Commit mounting and accessibility behavior**

```powershell
git add -- js/index.js
git commit -m "feat: mount responsive thermal wordmark animation"
```

### Task 6: Verify the finished Hero at desktop, mobile, and reduced-motion sizes

**Files:**
- Verify: `index.html`, `css/index.css`, `js/index.js`

- [ ] **Step 1: Run static checks**

```powershell
node --check js/index.js
npm run build
```

Expected: both commands exit successfully.

- [ ] **Step 2: Run the local site**

```powershell
npm run dev:legacy
```

Open the local URL and inspect the home page at approximately 1440×900, 1024×768, 768×1024, and 390×844.

- [ ] **Step 3: Check visual acceptance criteria**

Confirm:

- The page outside the title panel remains white/light blue.
- The black title panel fills the left title region without becoming a tiny card.
- The English wordmark is prominent and never stretches, clips, or becomes narrower than the Chinese title's readable block.
- `SLEEP`, `REST`, and `HEALTH` remain synchronized if more than one wordmark mount exists.
- Switching words restarts the heat reveal cleanly, with no black flash at 3000ms.
- The panel, Chinese title, buttons, stats, and right-side phone report remain in proportion.

- [ ] **Step 4: Check reduced motion**

Enable `prefers-reduced-motion: reduce` in browser rendering settings or DevTools. Reload and confirm the wordmark is static, settled, and no longer repaints continuously.

- [ ] **Step 5: Review the final diff**

```powershell
git status --short
git diff --check
git diff --stat
```

Expected: only the requested Hero HTML/CSS/JS changes remain unstaged, with no whitespace errors and no changes to unrelated page sections.
