// 性能优化配置和工具
(function() {
    'use strict';
    
    // 检查是否支持现代特性
    const supports = {
        webp: (function() {
            const canvas = document.createElement('canvas');
            canvas.width = 1;
            canvas.height = 1;
            return canvas.toDataURL('image/webp').indexOf('data:image/webp') === 0;
        })(),
        intersectionObserver: 'IntersectionObserver' in window,
        requestIdleCallback: 'requestIdleCallback' in window,
        preload: (function() {
            const link = document.createElement('link');
            return link.relList && link.relList.supports && link.relList.supports('preload');
        })()
    };
    
    // 图片懒加载优化
    function initLazyLoading() {
        if (!supports.intersectionObserver) return;
        
        const imageObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    if (img.dataset.src) {
                        // 创建新的图片元素进行预加载
                        const newImg = new Image();
                        newImg.onload = function() {
                            img.src = this.src;
                            img.classList.add('loaded');
                            img.removeAttribute('data-src');
                        };
                        newImg.onerror = function() {
                            img.classList.add('error');
                        };
                        newImg.src = img.dataset.src;
                        observer.unobserve(img);
                    }
                }
            });
        }, {
            rootMargin: '50px',
            threshold: 0.1
        });
        
        // 观察所有懒加载图片
        document.querySelectorAll('img[data-src]').forEach(img => {
            imageObserver.observe(img);
        });
    }
    
    // 关键资源预加载
    function preloadCriticalResources() {
        const criticalImages = [
            '../images/dzlogo.png',
            '../images/health-pro-qr.png'
        ];
        
        criticalImages.forEach(src => {
            if (supports.preload) {
                const link = document.createElement('link');
                link.rel = 'preload';
                link.as = 'image';
                link.href = src;
                document.head.appendChild(link);
            } else {
                // 降级处理
                const img = new Image();
                img.src = src;
            }
        });
    }
    
    // 字体加载优化（已改用系统字体栈，无外部字体可加载；仅保留兜底钩子）
    function optimizeFontLoading() {
        if ('fonts' in document) {
            // 使用Font Loading API
            const fontLoadPromises = [
                document.fonts.load('400 16px "PingFang SC"'),
                document.fonts.load('600 16px "PingFang SC"'),
                document.fonts.load('700 16px "PingFang SC"')
            ];
            
            Promise.all(fontLoadPromises).then(() => {
                document.body.classList.add('fonts-loaded');
            }).catch(() => {
                // 字体加载失败时的降级处理
                document.body.classList.add('fonts-error');
            });
        }
    }
    
    // 防抖函数
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }
    
    // 节流函数
    function throttle(func, limit) {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }
    
    // 性能监控
    function initPerformanceMonitoring() {
        if ('performance' in window && 'getEntriesByType' in performance) {
            window.addEventListener('load', function() {
                // 使用 requestIdleCallback 或 setTimeout 延迟收集性能数据
                const collectMetrics = () => {
                    const navigation = performance.getEntriesByType('navigation')[0];
                    const paint = performance.getEntriesByType('paint');
                    
                    const metrics = {
                        // 页面加载时间
                        loadTime: navigation.loadEventEnd - navigation.loadEventStart,
                        // DOM 解析时间
                        domParseTime: navigation.domContentLoadedEventEnd - navigation.domContentLoadedEventStart,
                        // 首次内容绘制
                        fcp: paint.find(p => p.name === 'first-contentful-paint')?.startTime || 0,
                        // 首次绘制
                        fp: paint.find(p => p.name === 'first-paint')?.startTime || 0
                    };
                    
                    // 在开发环境下输出性能指标
                    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
                        console.table(metrics);
                    }
                };
                
                if (supports.requestIdleCallback) {
                    requestIdleCallback(collectMetrics);
                } else {
                    setTimeout(collectMetrics, 0);
                }
            });
        }
    }
    
    // 视口优化
    function optimizeViewport() {
        // 添加视口元标签的动态调整
        const viewport = document.querySelector('meta[name="viewport"]');
        if (viewport) {
            // 根据设备调整视口设置
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
            if (isIOS) {
                viewport.content = viewport.content + ', user-scalable=no';
            }
        }
    }
    
    // 资源提示优化
    function addResourceHints() {
        const hints = [
            { rel: 'dns-prefetch', href: '//cdnjs.cloudflare.com' },
            { rel: 'preconnect', href: 'https://lifetide.oss-cn-beijing.aliyuncs.com' }
        ];
        
        hints.forEach(hint => {
            const link = document.createElement('link');
            link.rel = hint.rel;
            link.href = hint.href;
            if (hint.rel === 'preconnect') {
                link.crossOrigin = 'anonymous';
            }
            document.head.appendChild(link);
        });
    }
    
    // 初始化所有优化
    function init() {
        // 尽早执行的优化
        preloadCriticalResources();
        optimizeViewport();
        addResourceHints();
        
        // DOM 就绪后执行
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function() {
                initLazyLoading();
                optimizeFontLoading();
            });
        } else {
            initLazyLoading();
            optimizeFontLoading();
        }
        
        // 页面加载完成后执行
        window.addEventListener('load', function() {
            initPerformanceMonitoring();
        });
    }
    
    // 导出到全局供其他脚本使用
    window.PerformanceOptimizer = {
        supports,
        debounce,
        throttle,
        init
    };
    
    // 自动初始化
    init();
})();