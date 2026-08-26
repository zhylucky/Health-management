// 全局配置
const CONFIG = {
    // Supabase 配置
    SUPABASE_URL: 'https://gxohpxiekmpsmkzkcxfc.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd4b2hweGlla21wc21remtjeGZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk3MTg0NDQsImV4cCI6MjA2NTI5NDQ0NH0.sUleRxPQsEMxNqGPWUfZBDbjvDR5huZ7hGQkrHoahqk',

    // API 配置
    API_BASE_URL: '/.netlify/functions',

    // 邮箱正则
    EMAIL_REGEX: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,

    // 密码正则（至少 6 位，包含数字和字母，允许特殊字符）
    PASSWORD_REGEX: /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d@#$%^&*(),.?":{}|<>!_\-+=\[\]{};'/\\~`]{6,16}$/
};

// 注册状态管理
const registerState = {
    currentStep: 1,
    email: '',
    verificationCode: '',
    password: '',
    isSendingCode: false,
    countdown: 0,
    countdownTimer: null
};

// DOM 元素引用
let elements = {};

// 初始化
initializeAuth();

function initializeAuth() {
    initializeElements();
    bindEvents();
    // Supabase 异步加载，不阻塞表单渲染
    initializeSupabase();
}

// 初始化 DOM 元素引用
function initializeElements() {
    elements = {
        // 标签切换
        tabBtns: document.querySelectorAll('.tab-btn'),
        tabSlider: document.querySelector('.tab-slider'),
        loginFormContainer: document.getElementById('loginFormContainer'),
        registerFormContainer: document.getElementById('registerFormContainer'),
        
        // 登录表单
        loginForm: document.getElementById('loginForm'),
        username: document.getElementById('username'),
        password: document.getElementById('password'),
        remember: document.getElementById('remember'),
        
        // 注册表单
        registerForm: document.getElementById('registerForm'),
        phone: document.getElementById('phone'),
        verificationCode: document.getElementById('verificationCode'),
        getCodeBtn: document.getElementById('getCodeBtn'),
        passwordToggle: document.getElementById('regPasswordToggle'),
        confirmPasswordToggle: document.getElementById('confirmPasswordToggle'),
        agreeTerms: document.getElementById('agreeTerms'),
        submitBtn: document.getElementById('submitBtn'),
        backToLogin: document.getElementById('backToLogin'),
        
        // 错误提示
        phoneError: document.getElementById('phone-error'),
        codeError: document.getElementById('code-error'),
        passwordMatchError: document.getElementById('password-match-error'),
        termsError: document.getElementById('terms-error'),
        
        // 密码强度
        passwordStrength: document.getElementById('passwordStrength'),
        strengthBar: document.querySelector('.strength-bar'),
        strengthText: document.querySelector('.strength-text'),
        
        // 步骤
        step1: document.getElementById('step1'),
        step2: document.getElementById('step2'),
        step3: document.getElementById('step3'),
        termsGroup: document.getElementById('termsGroup'),
        
        // 进度条
        progressSteps: document.querySelectorAll('.progress-step')
    };
}

// 绑定事件
function bindEvents() {
    // 标签切换
    elements.tabBtns.forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
    
    // 登录表单提交
    if (elements.loginForm) {
        elements.loginForm.addEventListener('submit', handleLogin);
    }
    
    // 注册表单提交
    if (elements.registerForm) {
        elements.registerForm.addEventListener('submit', handleRegisterSubmit);
    }
    
    // 获取验证码
    if (elements.getCodeBtn) {
        elements.getCodeBtn.addEventListener('click', handleGetVerificationCode);
    }
    
    // 密码可见性切换
    if (elements.passwordToggle) {
        elements.passwordToggle.addEventListener('click', () => togglePasswordVisibility('regPassword'));
    }
    if (elements.confirmPasswordToggle) {
        elements.confirmPasswordToggle.addEventListener('click', () => togglePasswordVisibility('confirmPassword'));
    }
    
    // 实时验证（邮箱）
    if (elements.phone) {
        elements.phone.addEventListener('blur', validateEmail);
    }
    
    // 注册密码框在第二步才显示，需要动态绑定
    // 返回登录
    if (elements.backToLogin) {
        elements.backToLogin.querySelector('a').addEventListener('click', (e) => {
            e.preventDefault();
            switchTab('login');
        });
    }
    
    // 输入框焦点效果
    document.querySelectorAll('.input-group input').forEach(input => {
        input.addEventListener('focus', function() {
            this.parentElement.parentElement.classList.add('focused');
        });
        
        input.addEventListener('blur', function() {
            this.parentElement.parentElement.classList.remove('focused');
        });
    });
}

// 切换标签（优化版）
function switchTab(tab) {
    const isLogin = tab === 'login';
    
    // 更新按钮状态
    elements.tabBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    
    // 移动滑块（使用 CSS transition）
    if (elements.tabSlider) {
        elements.tabSlider.style.transform = isLogin ? 'translateX(0)' : 'translateX(100%)';
    }
    
    // 切换表单容器（使用 Promise 和 requestAnimationFrame 优化）
    if (elements.loginFormContainer && elements.registerFormContainer) {
        const fromContainer = isLogin ? elements.registerFormContainer : elements.loginFormContainer;
        const toContainer = isLogin ? elements.loginFormContainer : elements.registerFormContainer;
        
        // 使用 Promise 链式调用，确保动画顺序执行
        fadeOutContainer(fromContainer)
            .then(() => {
                // 隐藏离开的容器
                fromContainer.style.display = 'none';
                fromContainer.classList.remove('active');
                
                // 显示进入的容器
                toContainer.style.display = 'block';
                
                // 强制重绘后触发动画
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        toContainer.classList.add('active');
                    });
                });
                
                return fadeInContainer(toContainer);
            })
            .catch(err => console.error('切换失败:', err));
    }
}

// 淡出动画（Promise 封装）
function fadeOutContainer(container) {
    return new Promise((resolve, reject) => {
        try {
            container.classList.remove('active');
            container.classList.add('fade-out');
            
            // 等待动画完成
            const handleTransitionEnd = () => {
                container.removeEventListener('transitionend', handleTransitionEnd);
                container.classList.remove('fade-out');
                resolve();
            };
            
            container.addEventListener('transitionend', handleTransitionEnd, { once: true });
            
            // 超时保护
            setTimeout(() => {
                container.removeEventListener('transitionend', handleTransitionEnd);
                resolve(); // 即使动画未完成也继续
            }, 500);
        } catch (error) {
            reject(error);
        }
    });
}

// 淡入动画（Promise 封装）
function fadeInContainer(container) {
    return new Promise((resolve, reject) => {
        try {
            // 已经在 switchTab 中添加了 active 类
            const handleTransitionEnd = () => {
                container.removeEventListener('transitionend', handleTransitionEnd);
                resolve();
            };
            
            container.addEventListener('transitionend', handleTransitionEnd, { once: true });
            
            // 超时保护
            setTimeout(() => {
                container.removeEventListener('transitionend', handleTransitionEnd);
                resolve();
            }, 500);
        } catch (error) {
            reject(error);
        }
    });
}

// 初始化 Supabase（动态加载库，兼容 CDN 失败场景）
async function initializeSupabase() {
    // 如果库未加载，先动态加载
    if (typeof window.supabase === 'undefined') {
        const cdnUrls = [
            'https://unpkg.com/@supabase/supabase-js@2',
            'https://cdnjs.cloudflare.com/ajax/libs/supabase/2.0.0/supabase.min.js',
            'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
        ];
        let loaded = false;
        for (const url of cdnUrls) {
            try {
                await new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = url;
                    script.onload = resolve;
                    script.onerror = reject;
                    document.head.appendChild(script);
                });
                loaded = true;
                break;
            } catch (e) { /* 尝试下一个 CDN */ }
        }
        if (!loaded) {
            console.error('Supabase 库加载失败');
            return null;
        }
    }

    if (typeof window.supabase !== 'undefined') {
        window.supabaseClient = window.supabase.createClient(
            CONFIG.SUPABASE_URL,
            CONFIG.SUPABASE_ANON_KEY,
            {
                auth: {
                    autoRefreshToken: true,
                    persistSession: true,
                    detectSessionInUrl: true
                }
            }
        );
        return window.supabaseClient;
    }
    return null;
}

// 账号名 -> 邮箱映射（方便用简短账号登录）
const USERNAME_EMAIL_MAP = {
    'admin': 'admin@163.com'
};

// 处理登录
async function handleLogin(e) {
    e.preventDefault();

    const input = elements.username.value.trim();
    const password = elements.password.value;

    if (!input || !password) {
        showToast('请输入账号和密码', 'error');
        return;
    }

    // 解析邮箱：直接输入邮箱，或通过账号名映射
    let email = input;
    if (input.indexOf('@') === -1) {
        const mapped = USERNAME_EMAIL_MAP[input.toLowerCase()];
        if (mapped) {
            email = mapped;
        } else {
            showToast('未找到该账号，请使用邮箱登录或先注册', 'error');
            return;
        }
    }

    if (!CONFIG.EMAIL_REGEX.test(email)) {
        showToast('请输入正确的邮箱格式', 'error');
        return;
    }

    // 确保 Supabase 已初始化
    if (!window.supabaseClient) {
        await initializeSupabase();
        if (!window.supabaseClient) {
            showToast('认证服务未就绪，请刷新页面重试', 'error');
            return;
        }
    }

    const submitBtn = document.querySelector('.login-btn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '登录中...';
    }

    try {
        const { data, error } = await window.supabaseClient.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error) throw error;

        if (!data.user) {
            throw new Error('登录失败，未获取到用户信息');
        }

        // 检查管理员角色（仅 admin 可进入健康管理中心）
        const { data: profile } = await window.supabaseClient
            .from('profiles')
            .select('role')
            .eq('id', data.user.id)
            .single();

        const role = profile?.role;

        if (role !== 'admin') {
            // 非管理员：登出并提示无权限
            await window.supabaseClient.auth.signOut();
            showToast('该账号无管理员权限，无法访问健康管理中心', 'error');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = '登 录';
            }
            return;
        }

        // 管理员登录成功
        localStorage.setItem('userInfo', JSON.stringify({
            username: input,
            email: email,
            role: role,
            isLoggedIn: true
        }));

        showToast('登录成功，正在跳转...', 'success');

        setTimeout(() => {
            window.location.href = 'health-management.html';
        }, 300);

    } catch (error) {
        console.error('登录失败:', error.message);
        let msg = '登录失败：';
        if (error.message?.includes('Invalid login credentials')) {
            msg += '账号或密码错误';
        } else if (error.message?.includes('Email not confirmed')) {
            msg += '邮箱未验证，请先查收验证邮件';
        } else {
            msg += error.message;
        }
        showToast(msg, 'error');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '登 录';
        }
    }
}

// 切换密码可见性
function togglePasswordVisibility(fieldId) {
    const input = document.getElementById(fieldId);
    const icon = document.getElementById(`${fieldId}Toggle`);
    
    console.log('切换密码可见性:', fieldId, 'input:', input, 'icon:', icon);
    
    if (!input || !icon) {
        console.error('未找到密码输入框或图标');
        return;
    }
    
    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.remove('fa-eye');
        icon.classList.add('fa-eye-slash');
        console.log('设置为明文显示');
    } else {
        input.type = 'password';
        icon.classList.remove('fa-eye-slash');
        icon.classList.add('fa-eye');
        console.log('设置为密文显示');
    }
}

// 邮箱注册不再需要短信验证码，此函数保留兼容但不参与流程
async function handleGetVerificationCode() {
    showToast('邮箱注册无需验证码，请直接设置密码', 'info');
}

// 验证邮箱
function validateEmail() {
    const email = elements.phone.value.trim();
    registerState.email = email;

    if (!email) {
        showError(elements.phoneError, '请输入邮箱');
        return false;
    }

    if (!CONFIG.EMAIL_REGEX.test(email)) {
        showError(elements.phoneError, '请输入正确的邮箱格式');
        return false;
    }

    clearError(elements.phoneError);
    return true;
}

// 验证密码匹配（注册密码框）
function validatePasswordMatch() {
    const passwordInput = document.getElementById('regPassword');
    const password = passwordInput ? passwordInput.value : '';
    const confirmPassword = elements.confirmPassword.value;
    
    if (confirmPassword && password !== confirmPassword) {
        showError(elements.passwordMatchError, '两次输入的密码不一致');
        return false;
    }
    
    clearError(elements.passwordMatchError);
    return true;
}

// 检查密码强度（注册密码框）
function checkPasswordStrength() {
    const passwordInput = document.getElementById('regPassword');
    const password = passwordInput ? passwordInput.value : '';
    registerState.password = password;
    
    if (!password) {
        resetPasswordStrength();
        return;
    }
    
    let strength = 0;
    
    if (password.length >= 6) strength++;
    if (password.length >= 10) strength++;
    if (password.length >= 16) strength++;
    if (/\d/.test(password)) strength++;
    if (/[a-z]/.test(password)) strength++;
    if (/[A-Z]/.test(password)) strength++;
    if (/[!@#$%^&*(),.?":{}|<>]/.test(password)) strength++;
    
    elements.strengthBar.className = 'strength-bar';
    
    if (strength <= 2) {
        elements.strengthBar.classList.add('weak');
        elements.strengthText.textContent = '密码强度：弱';
        elements.strengthText.style.color = '#f44336';
    } else if (strength <= 4) {
        elements.strengthBar.classList.add('medium');
        elements.strengthText.textContent = '密码强度：中';
        elements.strengthText.style.color = '#ff9800';
    } else {
        elements.strengthBar.classList.add('strong');
        elements.strengthText.textContent = '密码强度：强';
        elements.strengthText.style.color = '#4caf50';
    }
}

// 重置密码强度显示
function resetPasswordStrength() {
    elements.strengthBar.className = 'strength-bar';
    elements.strengthText.textContent = '密码强度：未检测';
    elements.strengthText.style.color = '#666';
}

// 处理注册表单提交
async function handleRegisterSubmit(e) {
    e.preventDefault();

    if (registerState.currentStep === 1) {
        if (!validateEmail()) return;

        // 清除错误提示
        clearError(elements.codeError);
        clearError(elements.termsError);

        if (!elements.agreeTerms.checked) {
            showError(elements.termsError, '请先同意用户服务协议和隐私政策');
            return;
        }

        goToStep(2);

    } else if (registerState.currentStep === 2) {
        const passwordInput = document.getElementById('regPassword');
        const confirmPasswordInput = document.getElementById('confirmPassword');

        if (!passwordInput || !confirmPasswordInput) {
            showToast('表单元素未准备好，请刷新页面重试', 'error');
            return;
        }

        const password = passwordInput.value;
        const confirmPassword = confirmPasswordInput.value;

        // 密码强度校验
        if (!password || password.length < 6) {
            showToast('密码长度至少 6 位', 'error');
            return;
        }
        if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
            showToast('密码需同时包含字母和数字', 'error');
            return;
        }

        if (confirmPassword && password !== confirmPassword) {
            showError(elements.passwordMatchError, '两次输入的密码不一致');
            return;
        }

        clearError(elements.passwordMatchError);
        registerState.password = password;
        await performRegistration();
    }
}

// 执行注册（邮箱 + 密码）
async function performRegistration() {
    try {
        elements.submitBtn.disabled = true;
        elements.submitBtn.innerHTML = '<span class="btn-text">注册中...</span>';

        // 确保 Supabase 已初始化
        if (!window.supabaseClient) {
            initializeSupabase();
        }

        if (window.supabaseClient) {
            const { data, error } = await window.supabaseClient.auth.signUp({
                email: registerState.email,
                password: registerState.password,
                options: {
                    data: {
                        name: registerState.email.split('@')[0],
                        phone: ''
                    }
                }
            });

            if (error) throw error;

            // 注册成功后，由数据库触发器 handle_new_user 自动创建 profiles
            if (!data.user) {
                throw new Error('注册失败，请稍后重试');
            }
        } else {
            throw new Error('认证服务未就绪，请刷新页面重试');
        }

        registrationSuccess();

    } catch (error) {
        console.error('注册失败:', error.message);
        let msg = '注册失败：';
        if (error.message?.includes('already registered')) {
            msg += '该邮箱已注册，请直接登录';
        } else if (error.message?.includes('Password should be')) {
            msg += '密码不符合要求';
        } else {
            msg += error.message;
        }
        showToast(msg, 'error');
        elements.submitBtn.disabled = false;
        elements.submitBtn.innerHTML = `
            <span class="btn-text">下一步：设置密码</span>
            <i class="fas fa-arrow-right btn-icon"></i>
        `;
    }
}

// 注册成功后的处理
function registrationSuccess() {
    goToStep(3);

    setTimeout(() => {
        showToast('注册成功！请使用邮箱登录', 'success');
        // 切换到登录表单
        switchTab('login');
    }, 1500);
}

// 切换到指定步骤
function goToStep(step) {
    elements.step1.style.display = 'none';
    elements.step2.style.display = 'none';
    elements.step3.style.display = 'none';
    elements.termsGroup.style.display = 'none';
    elements.backToLogin.style.display = 'none';
    
    elements.progressSteps.forEach((stepEl, index) => {
        stepEl.classList.remove('active', 'completed');
        if (index + 1 < step) {
            stepEl.classList.add('completed');
        } else if (index + 1 === step) {
            stepEl.classList.add('active');
        }
    });
    
    if (step === 1) {
        elements.step1.style.display = 'block';
        elements.termsGroup.style.display = 'block';
        elements.backToLogin.style.display = 'block';
        elements.submitBtn.innerHTML = `
            <span class="btn-text">下一步：设置密码</span>
            <i class="fas fa-arrow-right btn-icon"></i>
        `;
    } else if (step === 2) {
        elements.step2.style.display = 'block';
        elements.submitBtn.innerHTML = `
            <span class="btn-text">完成注册</span>
            <i class="fas fa-check-circle btn-icon"></i>
        `;
        
        // 重新获取密码输入框并绑定事件
        const passwordInput = document.getElementById('regPassword');
        const confirmPasswordInput = document.getElementById('confirmPassword');
        const passwordToggle = document.getElementById('regPasswordToggle');
        const confirmPasswordToggle = document.getElementById('confirmPasswordToggle');
        
        if (passwordInput) {
            passwordInput.addEventListener('input', checkPasswordStrength);
        }
        if (confirmPasswordInput) {
            confirmPasswordInput.addEventListener('input', validatePasswordMatch);
        }
        if (passwordToggle) {
            passwordToggle.addEventListener('click', () => togglePasswordVisibility('regPassword'));
        }
        if (confirmPasswordToggle) {
            confirmPasswordToggle.addEventListener('click', () => togglePasswordVisibility('confirmPassword'));
        }
    } else if (step === 3) {
        elements.step3.style.display = 'block';
        elements.submitBtn.style.display = 'none';
    }
    
    registerState.currentStep = step;
}

// 显示错误
function showError(element, message) {
    if (element) {
        element.textContent = message;
        element.style.display = 'block';
    }
}

// 清除错误
function clearError(element) {
    if (element) {
        element.textContent = '';
        element.style.display = 'none';
    }
}

// 显示小弹窗（保留原有功能）
function showToast(message, type) {
    const existingToast = document.querySelector('.toast');
    const existingMask = document.querySelector('.toast-mask');
    
    if (existingToast) existingToast.remove();
    if (existingMask) existingMask.remove();

    const mask = document.createElement('div');
    mask.className = 'toast-mask';
    document.body.appendChild(mask);

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = type === 'success' ? '✅' : '❌';
    toast.appendChild(icon);

    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;
    toast.appendChild(text);

    document.body.appendChild(toast);

    setTimeout(() => {
        mask.classList.add('show');
        toast.classList.add('show');
    }, 10);

    setTimeout(() => {
        toast.classList.remove('show');
        mask.classList.remove('show');
        setTimeout(() => {
            toast.remove();
            mask.remove();
        }, 300);
    }, 2000);
}