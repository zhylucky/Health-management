/**
 * ECharts 统一加载器
 * 避免重复加载，提供统一的ECharts初始化方法
 */

window.EChartsLoader = (function() {
	let echartsPromise = null;
	// 多CDN候选（按优先级）——bootcdn 优先（国内访问快，之前验证过可达）；cdnjs 备用
	const CDN_CANDIDATES = [
		'https://cdn.bootcdn.net/ajax/libs/echarts/5.4.3/echarts.min.js',
		'https://cdnjs.cloudflare.com/ajax/libs/echarts/5.4.3/echarts.min.js',
		'https://npm.elemecdn.com/echarts@5.4.3/dist/echarts.min.js',
		'https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js',
		'https://unpkg.com/echarts@5.4.3/dist/echarts.min.js' // 最后备用
	];
	const LOAD_TIMEOUT_MS = 12000; // 单个CDN加载超时
	const MAX_RETRIES_PER_CDN = 1; // 每个CDN的重试次数
	
	function preconnectOnce(url) {
		try {
			const u = new URL(url);
			if (!document.querySelector(`link[rel="preconnect"][href="${u.origin}"]`)) {
				const link = document.createElement('link');
				link.rel = 'preconnect';
				link.href = u.origin;
				link.crossOrigin = 'anonymous';
				document.head.appendChild(link);
			}
			if (!document.querySelector(`link[rel="dns-prefetch"][href="//${u.host}"]`)) {
				const dns = document.createElement('link');
				dns.rel = 'dns-prefetch';
				dns.href = `//${u.host}`;
				document.head.appendChild(dns);
			}
		} catch (_) {}
	}

	function loadScriptWithTimeout(src) {
		return new Promise((resolve, reject) => {
			const script = document.createElement('script');
			script.src = src;
			script.async = true;
			script.crossOrigin = 'anonymous';
			script.referrerPolicy = 'no-referrer';
			let done = false;

			const clear = () => {
				script.onload = null;
				script.onerror = null;
				if (timer) clearTimeout(timer);
			};

			script.onload = () => {
				if (done) return; done = true; clear(); resolve();
			};
			script.onerror = (e) => {
				if (done) return; done = true; clear(); reject(new Error(`加载失败: ${src}`));
			};

			const timer = setTimeout(() => {
				if (done) return; done = true; clear();
				reject(new Error(`加载超时: ${src}`));
			}, LOAD_TIMEOUT_MS);

			document.head.appendChild(script);
		});
	}

	/**
	 * 加载ECharts库（带多CDN容错与超时重试）
	 * @returns {Promise}
	 */
	function loadECharts() {
		// 如果已经加载过，直接返回
		if (typeof echarts !== 'undefined') {
			return Promise.resolve();
		}
		// 如果正在加载中，返回现有的Promise
		if (echartsPromise) {
			return echartsPromise;
		}

		// 预连接候选CDN，提升首包建立速度
		CDN_CANDIDATES.forEach(preconnectOnce);

		echartsPromise = new Promise(async (resolve, reject) => {
			console.time('ECharts加载时间');
			let lastError = null;
			for (let i = 0; i < CDN_CANDIDATES.length; i++) {
				const src = CDN_CANDIDATES[i];
				for (let attempt = 0; attempt <= MAX_RETRIES_PER_CDN; attempt++) {
					try {
						await loadScriptWithTimeout(src);
						if (typeof echarts !== 'undefined') {
							console.timeEnd('ECharts加载时间');
							console.log(`✨ ECharts库加载成功 (CDN: ${new URL(src).host})`);
							return resolve();
						}
						// 极端情况下脚本加载但全局未暴露
						throw new Error('脚本已加载但未找到echarts');
					} catch (err) {
						lastError = err;
						console.warn(`⚠️ ECharts加载失败: ${src} (尝试 ${attempt + 1})`, err?.message || err);
						// 指数退避后再试下一个
						await new Promise(r => setTimeout(r, 400 * Math.pow(2, attempt)));
					}
				}
			}
			console.timeEnd('ECharts加载时间');
			console.error('❌ ECharts库所有CDN均加载失败');
			echartsPromise = null; // 重置，允许后续再试
			reject(lastError || new Error('ECharts加载失败'));
		});

		return echartsPromise;
	}
	
	/**
	 * 初始化图表
	 * @param {string} elementId - 图表容器ID
	 * @param {Object} option - 图表配置选项
	 * @param {boolean} autoResize - 是否自动调整大小（默认true）
	 * @returns {Promise<Object>} 返回图表实例
	 */
	async function initChart(elementId, option, autoResize = true) {
		try {
			// 确保ECharts已加载
			await loadECharts();
			const element = document.getElementById(elementId);
			if (!element) {
				throw new Error(`找不到图表容器: ${elementId}`);
			}
			// 初始化图表
			const chart = echarts.init(element);
			chart.setOption(option);
			// 自动调整大小
			if (autoResize) {
				const resizeHandler = () => chart.resize();
				window.addEventListener('resize', resizeHandler);
				// 返回销毁方法
				const originalDispose = chart.dispose;
				chart.dispose = function() {
					window.removeEventListener('resize', resizeHandler);
					originalDispose.call(this);
				};
			}
			return chart;
		} catch (error) {
			console.error('图表初始化失败:', error);
			throw error;
		}
	}
	
	/**
	 * 批量初始化多个图表
	 * @param {Array} chartsConfig - 图表配置数组 [{id, option}, ...]
	 * @returns {Promise<Array>} 返回图表实例数组
	 */
	async function initCharts(chartsConfig) {
		try {
			await loadECharts();
			const charts = [];
			for (const config of chartsConfig) {
				const chart = await initChart(config.id, config.option, true);
				charts.push(chart);
			}
			return charts;
		} catch (error) {
			console.error('批量初始化图表失败:', error);
			throw error;
		}
	}
	
	// 公开API
	return {
		loadECharts,
		initChart,
		initCharts,
		// 检查是否已加载
		isLoaded: () => typeof echarts !== 'undefined',
		// 检查是否正在加载
		isLoading: () => echartsPromise !== null && typeof echarts === 'undefined',
		// 获取加载状态
		getStatus: () => {
			if (typeof echarts !== 'undefined') return 'loaded';
			if (echartsPromise) return 'loading';
			return 'not-loaded';
		}
	};
})();