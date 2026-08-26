// Supabase配置
const supabaseUrl = 'https://gxohpxiekmpsmkzkcxfc.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd4b2hweGlla21wc21remtjeGZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk3MTg0NDQsImV4cCI6MjA2NTI5NDQ0NH0.sUleRxPQsEMxNqGPWUfZBDbjvDR5huZ7hGQkrHoahqk';

// 确保supabase变量只声明一次
if (typeof window.supabaseInstance === 'undefined') {
    window.supabaseInstance = null;
}

// Supabase按需加载器
async function loadSupabase() {
    if (window.supabaseInstance) {
        return window.supabaseInstance; // 已经初始化
    }
    
    // 添加请求超时配置
    const REQUEST_TIMEOUT = 10000; // 10秒超时
    
    // 带超时的请求包装函数
    const fetchWithTimeout = (url, options = {}, timeout = REQUEST_TIMEOUT) => {
        return Promise.race([
            fetch(url, options),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('请求超时')), timeout)
            )
        ]);
    };
    
    // 检查是否已加载Supabase库
    if (typeof window.supabase === 'undefined') {
        debugLog('正在加载Supabase库...');
        try {
            await new Promise((resolve, reject) => {
                // 使用国内稳定的CDN镜像，按优先级排序
                const cdnUrls = [
                    'https://unpkg.com/@supabase/supabase-js@2',  // unpkg CDN (国内访问最快)
                    'https://cdnjs.cloudflare.com/ajax/libs/supabase/2.0.0/supabase.min.js',  // Cloudflare CDN (国内访问较快)
                    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'  // jsdelivr 最后备用
                ];
                
                let currentIndex = 0;
                
                const tryLoadScript = () => {
                    if (currentIndex >= cdnUrls.length) {
                        reject(new Error('所有CDN源都无法加载Supabase库'));
                        return;
                    }
                    
                    const script = document.createElement('script');
                    script.src = cdnUrls[currentIndex];
                    
                    script.onload = () => {
                        debugLog(`Supabase库加载成功 (CDN: ${cdnUrls[currentIndex]})`);
                        resolve();
                    };
                    
                    script.onerror = (err) => {
                        debugWarn(`CDN ${currentIndex + 1} 加载失败:`, cdnUrls[currentIndex]);
                        currentIndex++;
                        tryLoadScript();
                    };
                    
                    document.head.appendChild(script);
                };
                
                tryLoadScript();
            });
        } catch (error) {
            showToast('网络错误：无法加载数据库连接库');
            throw error;
        }
    }
    
    // 性能优化配置
    const supabaseOptions = {
        auth: {
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: false // 减少不必要的URL检查
        },
        db: {
            schema: 'public'
        },
        global: {
            headers: {
                'x-client-info': 'health-management-system'
            }
        },
        // 连接池配置
        realtime: {
            params: {
                eventsPerSecond: 10
            }
        }
    };
    
    try {
        window.supabaseInstance = window.supabase.createClient(supabaseUrl, supabaseKey, supabaseOptions);
        debugLog('Supabase客户端初始化成功');
        return window.supabaseInstance;
    } catch (error) {
        debugError('Supabase初始化失败:', error);
        showToast('数据库连接初始化失败，请检查网络连接');
        throw error;
    }
}

// 生产环境日志控制
const IS_PRODUCTION = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
const debugLog = IS_PRODUCTION ? () => {} : console.log;
const debugError = IS_PRODUCTION ? () => {} : console.error;
const debugWarn = IS_PRODUCTION ? () => {} : console.warn;

// Supabase连接保持活跃机制
const KEEP_ALIVE_INTERVAL = 15 * 60 * 1000; // 15分钟

// 定期ping Supabase服务以保持活跃
function setupKeepAlive() {
    if (IS_PRODUCTION) { // 只在生产环境中启用
        // 立即执行一次，然后定期执行
        keepAlivePing();
        
        setInterval(async () => {
            keepAlivePing();
        }, KEEP_ALIVE_INTERVAL);
        
        debugLog('Supabase keep-alive mechanism initialized');
    }
}

// 执行keep-alive ping
async function keepAlivePing() {
    try {
        const supabaseClient = await loadSupabase();
        if (supabaseClient) {
            // 执行一个简单的查询来保持连接活跃
            const { error } = await supabaseClient.from('New_user').select('id').limit(1);
            if (error) {
                debugWarn('Keep-alive ping failed:', error.message);
                
                // 如果连接失败，尝试重新初始化
                window.supabaseInstance = null;
                
                // 等待一段时间后再次尝试
                setTimeout(async () => {
                    try {
                        const reinitializedClient = await loadSupabase();
                        if (reinitializedClient) {
                            const { error: reError } = await reinitializedClient.from('New_user').select('id').limit(1);
                            if (!reError) {
                                debugLog('Supabase reconnection successful');
                            }
                        }
                    } catch (reError) {
                        debugError('Supabase reconnection failed:', reError);
                    }
                }, 5000);
            } else {
                debugLog('Supabase keep-alive ping successful');
            }
        }
    } catch (error) {
        debugError('Keep-alive ping error:', error);
    }
}

// 页面加载完成后启动keep-alive机制
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupKeepAlive);
} else {
    setupKeepAlive();
}

// 请求缓存机制
const requestCache = new Map();
const CACHE_DURATION = 30000; // 30秒缓存

// 页面片段缓存（三个子页面切换时避免重复请求网络）
const partialCache = new Map();

// 缓存辅助函数
function getCacheKey(table, params) {
    return `${table}_${JSON.stringify(params)}`;
}

function getCachedData(key) {
    const cached = requestCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        return cached.data;
    }
    return null;
}

function setCachedData(key, data) {
    requestCache.set(key, {
        data,
        timestamp: Date.now()
    });

    // 清理过期缓存
    if (requestCache.size > 50) {
        const now = Date.now();
        for (const [k, v] of requestCache.entries()) {
            if (now - v.timestamp > CACHE_DURATION) {
                requestCache.delete(k);
            }
        }
    }
}

// =================================
// 全局状态管理
// =================================
const state = {
    users: [],
    pagination: {
        currentPage: 1,
        pageSize: 10,
        totalUsers: 0,
    },
};

// =================================
// 数据获取与处理
// =================================

// 优化的用户数据加载函数
async function loadUsers() {
    try {
        // 确保Supabase已加载
        const supabaseClient = await loadSupabase();
        if (!supabaseClient) throw new Error('Supabase客户端未初始化');

        const { currentPage, pageSize } = state.pagination;
        const cacheKey = getCacheKey('New_user', { currentPage, pageSize });

        // 检查缓存
        const cachedData = getCachedData(cacheKey);
        if (cachedData) {
            debugLog('使用缓存数据');
            state.users = cachedData.data || [];
            // 如果缓存中没有计数，使用已保存的总数，避免分页按钮消失
            const cachedCount = cachedData.count;
            state.pagination.totalUsers = (cachedCount !== undefined && cachedCount !== null && cachedCount > 0) 
                ? cachedCount 
                : state.pagination.totalUsers;
            return { success: true, fromCache: true };
        }

        // 使用性能优化的查询 - 并行执行计数和数据查询
        let countResult = { count: 0, error: null };
        let dataResult;
        
        // 并行执行查询以提高性能
        const queries = [];
        
        // 只在第一页时执行计数查询
        if (currentPage === 1) {
            queries.push(
                supabaseClient
                    .from('New_user')
                    .select('*', { count: 'exact', head: true })
                    .then(result => ({ type: 'count', result }))
                    .catch(error => ({ type: 'count', error }))
            );
        }
        
        // 数据查询
        queries.push(
            supabaseClient
                .from('New_user')
                .select('id, name, gender, age, phone, direction, created_at')
                .order('created_at', { ascending: false })
                .range((currentPage - 1) * pageSize, currentPage * pageSize - 1)
                .then(result => ({ type: 'data', result }))
                .catch(error => ({ type: 'data', error }))
        );
        
        try {
            const results = await Promise.all(queries);
            
            // 处理查询结果
            results.forEach(({ type, result, error }) => {
                if (type === 'count') {
                    countResult = result || { count: 0, error };
                    if (countResult.error) {
                        debugError('计数查询失败:', countResult.error);
                    }
                } else if (type === 'data') {
                    dataResult = result || { data: [], error };
                    if (dataResult.error) {
                        debugError('数据查询失败:', dataResult.error);
                        throw new Error('数据查询失败: ' + dataResult.error.message);
                    }
                }
            });
        } catch (error) {
            debugError('并行查询异常:', error);
            throw new Error('数据查询失败: ' + error.message);
        }

        debugLog(`数据库查询完成`);

        if (dataResult.error) {
            debugError('数据查询失败:', dataResult.error);
            throw new Error('数据查询失败: ' + dataResult.error.message);
        }

        const result = {
            data: dataResult.data || [],
            count: (currentPage === 1 && countResult.count !== undefined && countResult.count !== null) 
                ? countResult.count 
                : (state.pagination.totalUsers || 24)
        };

        // 缓存结果
        setCachedData(cacheKey, result);

        state.users = result.data;
        state.pagination.totalUsers = result.count;

        return { success: true };
    } catch (error) {
        debugError('加载用户数据失败:', error);
        // 提供更友好的错误信息
        let errorMessage = '加载用户数据失败';
        if (error.message) {
            if (error.message.includes('Failed to fetch') || error.message.includes('network')) {
                errorMessage = '网络连接失败，请检查网络设置';
            } else if (error.message.includes('Invalid API key')) {
                errorMessage = '数据库认证失败，请联系管理员';
            } else {
                errorMessage = error.message;
            }
        }
        showToast(errorMessage);
        return { success: false, message: errorMessage };
    }
}

// 渲染表格 - 优化版本，避免长任务
function renderTable() {
    const tbody = document.querySelector('.data-table tbody');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (state.users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="no-data">暂无数据</td></tr>';
        return;
    }
    
    // 使用 requestAnimationFrame 分解长任务
    const renderUsers = (users, startIndex = 0, batchSize = 10) => {
        const endIndex = Math.min(startIndex + batchSize, users.length);
        
        for (let i = startIndex; i < endIndex; i++) {
            const user = users[i];
            const row = document.createElement('tr');
            row.dataset.id = user.id;
            
            row.innerHTML = `
                <td><input type="checkbox" class="user-select" data-id="${user.id}"></td>
                <td>${user.name || ''}</td>
                <td>${user.gender || ''}</td>
                <td>${user.age || ''}</td>
                <td>${user.phone || ''}</td>
                <td><span class="direction-tag direction-${user.direction}">${user.direction || ''}</span></td>
                <td class="action-cell">
                    <button class="action-btn" onclick="completeProfile(${user.id})"><i class="fas fa-id-card"></i><span>用户档案</span></button>
                    <button class="action-btn report-dropdown-btn" onclick="toggleReportDropdown(event, ${user.id})">
                        <i class="fas fa-chart-bar"></i>
                        <span>查看报告</span>
                        <i class="fas fa-chevron-down dropdown-arrow"></i>
                        <div class="report-dropdown" id="reportDropdown_${user.id}" style="display: none;">
                            <div class="dropdown-item" onclick="viewReport(event, 'sleep', ${user.id})">
                                <i class="fas fa-bed"></i>
                                <span>睡眠报告</span>
                            </div>
                            <div class="dropdown-item" onclick="viewReport(event, 'navigation', ${user.id})">
                                <i class="fas fa-route"></i>
                                <span>导航报告</span>
                            </div>
                        </div>
                    </button>
                </td>
                <td class="action-cell-single">
                    <button class="icon-btn" onclick="editUser(${user.id})"><i class="fas fa-edit"></i></button>
                    <button class="icon-btn danger" onclick="deleteUser(${user.id})"><i class="fas fa-trash"></i></button>
                </td>
            `;
            
            tbody.appendChild(row);
        }
        
        // 如果还有更多用户需要渲染，继续下一批
        if (endIndex < users.length) {
            requestAnimationFrame(() => {
                renderUsers(users, endIndex, batchSize);
            });
        } else {
            // 所有用户渲染完成
            updateSelectedCount();
            
            // 初始化报告下拉菜单悬停事件
            setTimeout(() => {
                initReportDropdownHover();
            }, 100);
        }
    };
    
    // 开始分批渲染
    renderUsers(state.users);
}

// 更新分页控件
function updatePagination() {
    const { currentPage, totalUsers, pageSize } = state.pagination;
    // 确保totalUsers至少为24，避免页码按钮消失
    const effectiveTotalUsers = totalUsers > 0 ? totalUsers : 24;
    const totalPages = Math.ceil(effectiveTotalUsers / pageSize);
    const paginationContainer = document.querySelector('.page-buttons');
    if (!paginationContainer) return;
    
    paginationContainer.innerHTML = '';
    
    // 首页按钮
    const firstBtn = document.createElement('button');
    firstBtn.classList.add('page-btn', 'page-btn-first');
    firstBtn.disabled = currentPage === 1;
    firstBtn.innerHTML = '<i class="fas fa-angle-double-left"></i>';
    firstBtn.title = '首页';
    firstBtn.addEventListener('click', () => changePage(1));
    paginationContainer.appendChild(firstBtn);
    
    // 上一页按钮
    const prevBtn = document.createElement('button');
    prevBtn.classList.add('page-btn', 'page-btn-prev');
    prevBtn.disabled = currentPage === 1;
    prevBtn.innerHTML = '<i class="fas fa-angle-left"></i>';
    prevBtn.title = '上一页';
    prevBtn.addEventListener('click', () => changePage(currentPage - 1));
    paginationContainer.appendChild(prevBtn);
    
    // 页码按钮
    const startPage = Math.max(1, currentPage - 2);
    const endPage = Math.min(totalPages, startPage + 4);
    
    // 确保至少显示1-3页的页码按钮
    const displayStartPage = Math.max(1, startPage);
    const displayEndPage = Math.min(totalPages, Math.max(3, endPage));
    
    for (let i = displayStartPage; i <= displayEndPage; i++) {
        const pageBtn = document.createElement('button');
        pageBtn.classList.add('page-btn');
        if (i === currentPage) pageBtn.classList.add('active');
        pageBtn.textContent = i;
        pageBtn.addEventListener('click', () => changePage(i));
        paginationContainer.appendChild(pageBtn);
    }
    
    // 下一页按钮
    const nextBtn = document.createElement('button');
    nextBtn.classList.add('page-btn', 'page-btn-next');
    nextBtn.disabled = currentPage === totalPages || totalPages === 0;
    nextBtn.innerHTML = '<i class="fas fa-angle-right"></i>';
    nextBtn.title = '下一页';
    nextBtn.addEventListener('click', () => changePage(currentPage + 1));
    paginationContainer.appendChild(nextBtn);
    
    // 末页按钮
    const lastBtn = document.createElement('button');
    lastBtn.classList.add('page-btn', 'page-btn-last');
    lastBtn.disabled = currentPage === totalPages || totalPages === 0;
    lastBtn.innerHTML = '<i class="fas fa-angle-double-right"></i>';
    lastBtn.title = '末页';
    lastBtn.addEventListener('click', () => changePage(totalPages));
    paginationContainer.appendChild(lastBtn);
    
    const totalRecordsSpan = document.querySelector('.pagination-info .total-count');
    if (totalRecordsSpan) {
        totalRecordsSpan.innerHTML = `共 <strong>${totalUsers}</strong> 条记录`;
    }

    const pageJumpInput = document.querySelector('.page-jump input');
    if (pageJumpInput) {
        pageJumpInput.value = currentPage;
        pageJumpInput.max = totalPages;
        
        pageJumpInput.onchange = function() {
            const page = parseInt(this.value, 10);
            if (page >= 1 && page <= totalPages) {
                changePage(page);
            }
        };
    }
}

// 更新选中项计数
function updateSelectedCount() {
    const selectedCheckboxes = document.querySelectorAll('.user-select:checked');
    const selectedCountSpan = document.querySelector('.selected-count');
    if (selectedCountSpan) {
        selectedCountSpan.textContent = `已选择 ${selectedCheckboxes.length} 项`;
    }
}

// =================================
// 事件处理与逻辑
// =================================

// 初始化事件监听
function initUserListEventListeners() {
    document.querySelector('.btn-add')?.addEventListener('click', openAddUserModal);
    document.querySelector('.btn-search')?.addEventListener('click', debounce(filterData, 300));
    document.querySelector('.btn-reset')?.addEventListener('click', resetFilter);
    document.querySelector('.btn-export')?.addEventListener('click', exportData);
    document.querySelector('.btn-batch')?.addEventListener('click', handleBatchOperation);
    document.querySelector('.btn-refresh')?.addEventListener('click', handleManualRefresh);
    document.querySelector('.page-size')?.addEventListener('change', (e) => changePageSize(parseInt(e.target.value, 10)));
    document.querySelector('.select-all')?.addEventListener('change', function() {
        document.querySelectorAll('.user-select').forEach(checkbox => {
            checkbox.checked = this.checked;
        });
        updateSelectedCount();
    });
}

// 防抖函数
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// 批量操作处理函数
function handleBatchOperation() {
    const selectedCheckboxes = document.querySelectorAll('.user-select:checked');
    if (selectedCheckboxes.length === 0) {
        showToast('请先选择要操作的用户');
        return;
    }
    
    const selectedIds = Array.from(selectedCheckboxes).map(cb => parseInt(cb.dataset.id));
    showToast(`已选择 ${selectedIds.length} 个用户，批量操作功能开发中...`);
    
    // 这里可以添加具体的批量操作逻辑
    // 例如：批量删除、批量修改标签等
}

// 手动刷新处理函数
async function handleManualRefresh() {
    const refreshBtn = document.querySelector('.btn-refresh');
    if (!refreshBtn) return;
    
    // 添加加载状态
    const originalContent = refreshBtn.innerHTML;
    refreshBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 刷新中...';
    refreshBtn.disabled = true;
    
    try {
        await refreshUserList();
        showToast('列表刷新成功');
    } catch (error) {
        debugError('手动刷新失败:', error);
        showToast('刷新失败: ' + error.message);
    } finally {
        // 恢复按钮状态
        refreshBtn.innerHTML = originalContent;
        refreshBtn.disabled = false;
    }
}

// 通用的列表刷新函数
async function refreshUserList() {
    try {
        // 清除缓存，确保获取最新数据
        requestCache.clear();
        
        // 重新加载用户列表
        await loadAndRenderUsers();
        
        debugLog('用户列表已自动刷新');
        return true;
    } catch (error) {
        debugError('刷新用户列表失败:', error);
        showToast('刷新列表失败: ' + error.message);
        return false;
    }
}

// 切换页码
async function changePage(page) {
    state.pagination.currentPage = page;
    await loadAndRenderUsers();
}

// 切换每页显示数量
async function changePageSize(size) {
    state.pagination.pageSize = size;
    state.pagination.currentPage = 1;
    await loadAndRenderUsers();
}

// 优化的过滤数据函数
async function filterData() {
    try {
        // 防止重复调用
        if (window.filterDataInProgress) {
            debugLog('过滤数据正在进行中，跳过重复调用');
            return;
        }
        
        window.filterDataInProgress = true;
        
        const supabaseClient = await loadSupabase();
        if (!supabaseClient) throw new Error('Supabase客户端未初始化');

        const nameFilter = document.querySelector('.search-inputs input[placeholder="姓名"]')?.value?.trim();
        const phoneFilter = document.querySelector('.search-inputs input[placeholder="手机号"]')?.value?.trim();
        const directionFilter = document.querySelector('.filter-select')?.value;

        // 创建过滤器缓存键
        const filterParams = { nameFilter, phoneFilter, directionFilter, page: 1 };
        const cacheKey = getCacheKey('New_user_filter', filterParams);

        // 检查缓存
        const cachedData = getCachedData(cacheKey);
        if (cachedData) {
            debugLog('使用过滤缓存数据');
            state.users = cachedData.data || [];
            state.pagination.totalUsers = cachedData.count || 0;
            state.pagination.currentPage = 1;
            renderTable();
            updatePagination();
            showToast(`找到 ${state.pagination.totalUsers} 条记录 (缓存)`);
            window.filterDataInProgress = false;
            return;
        }

        state.pagination.currentPage = 1;
        const { currentPage, pageSize } = state.pagination;

        // 优化查询：只选择必要字段，使用索引友好的查询
        let query = supabaseClient
            .from('New_user')
            .select('id, name, gender, age, phone, direction, created_at', { count: 'exact' });

        // 构建查询条件
        const conditions = [];
        if (nameFilter) {
            query = query.ilike('name', `%${nameFilter}%`);
            conditions.push(`name ilike %${nameFilter}%`);
        }
        if (phoneFilter) {
            query = query.ilike('phone', `%${phoneFilter}%`);
            conditions.push(`phone ilike %${phoneFilter}%`);
        }
        if (directionFilter) {
            query = query.eq('direction', directionFilter);
            conditions.push(`direction = ${directionFilter}`);
        }

        query = query
            .range((currentPage - 1) * pageSize, currentPage * pageSize - 1)
            .order('created_at', { ascending: false });

        debugLog('执行过滤查询:', conditions.join(' AND '));

        const { data, error, count } = await query;

        if (error) throw error;

        debugLog(`过滤查询已完成`);

        const result = { data: data || [], count: count || 0 };

        // 缓存过滤结果
        setCachedData(cacheKey, result);

        state.users = result.data;
        state.pagination.totalUsers = result.count;

        renderTable();
        updatePagination();

        showToast(`找到 ${state.pagination.totalUsers} 条记录`);
        window.filterDataInProgress = false;
    } catch (error) {
        debugError('过滤数据失败:', error);
        // 提供更友好的错误信息
        let errorMessage = '过滤数据失败';
        if (error.message) {
            if (error.message.includes('Failed to fetch') || error.message.includes('network')) {
                errorMessage = '网络连接失败，请检查网络设置';
            } else if (error.message.includes('Invalid API key')) {
                errorMessage = '数据库认证失败，请联系管理员';
            } else {
                errorMessage = error.message;
            }
        }
        showToast(errorMessage);
        window.filterDataInProgress = false;
    }
}

// 重置过滤器
async function resetFilter() {
    const nameInput = document.querySelector('.search-inputs input[placeholder="姓名"]');
    const phoneInput = document.querySelector('.search-inputs input[placeholder="手机号"]');
    const directionSelect = document.querySelector('.filter-select');
    
    if (nameInput) nameInput.value = '';
    if (phoneInput) phoneInput.value = '';
    if (directionSelect) directionSelect.value = '';
    
    state.pagination.currentPage = 1;
    await loadAndRenderUsers();
}

// 导出数据
async function exportData() {
    try {
        // 检查是否已加载XLSX库
        if (typeof XLSX === 'undefined') {
            showToast('正在加载导出库...');
            
            // 动态加载XLSX库
            const script = document.createElement('script');
            script.src = 'https://unpkg.com/xlsx/dist/xlsx.full.min.js';
            
            await new Promise((resolve, reject) => {
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
            
            showToast('导出库加载完成');
        }
        
        showToast('正在导出所有数据...');
        
        // 确保Supabase已加载
        const supabaseClient = await loadSupabase();
        const { data, error } = await supabaseClient
            .from('New_user')
            .select('*')
            .order('created_at', { ascending: false });
        
        if (error) throw error;
        
        if (!data || data.length === 0) {
            showToast('没有数据可导出');
            return;
        }
        
        const worksheet = XLSX.utils.json_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, '用户数据');
        
        const date = new Date().toISOString().split('T')[0];
        XLSX.writeFile(workbook, `用户数据_${date}.xlsx`);
        
        showToast('数据导出成功');
    } catch (error) {
        debugError('导出数据失败:', error.message);
        showToast('导出数据失败: ' + error.message);
    }
}

// =================================
// 用户模态框 (新增/编辑)
// =================================

// 预创建用户模态框
function createUserModal() {
    if (document.getElementById('userModal')) return;

    const modal = document.createElement('div');
    modal.id = 'userModal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h3 id="userModalTitle">新增用户</h3>
                <button class="close-btn" onclick="closeUserModal()">&times;</button>
            </div>
            <div class="modal-body">
                <form id="userForm">
                    <input type="hidden" id="userId">
                    <div class="form-group">
                        <label for="userName">姓名</label>
                        <input type="text" id="userName" required>
                    </div>
                    <div class="form-group">
                        <label for="userGender">性别</label>
                        <select id="userGender" required>
                            <option value="">请选择</option>
                            <option value="男">男</option>
                            <option value="女">女</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="userAge">年龄</label>
                        <input type="number" id="userAge" min="1" max="120" required>
                    </div>
                    <div class="form-group">
                        <label for="userPhone">手机号</label>
                        <input type="tel" id="userPhone" pattern="[0-9]{11}" required>
                    </div>
                    <div class="form-group">
                        <label for="userDirection">调理方向</label>
                        <select id="userDirection" required>
                            <option value="">请选择</option>
                            <option value="糖代谢">糖代谢</option>
                            <option value="亚健康">亚健康</option>
                            <option value="其他">其他</option>
                        </select>
                    </div>
                    <div class="form-actions">
                        <button type="button" class="btn-cancel" onclick="closeUserModal()">取消</button>
                        <button type="submit" class="btn-save">保存</button>
                    </div>
                </form>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('userForm').addEventListener('submit', saveUser);
}

// 打开新增用户模态框
function openAddUserModal() {
    const form = document.getElementById('userForm');
    if (!form) {
        createUserModal(); // 如果模态框不存在，先创建
    }
    
    document.getElementById('userForm').reset();
    document.getElementById('userId').value = '';
    document.getElementById('userModalTitle').textContent = '新增用户';
    document.getElementById('userModal').style.display = 'flex';
    setTimeout(() => document.getElementById('userName').focus(), 100);
}

// 关闭用户模态框
function closeUserModal() {
    const modal = document.getElementById('userModal');
    if (modal) modal.style.display = 'none';
}

// 保存用户信息
async function saveUser(e) {
    e.preventDefault();
    
    // 确保Supabase已加载
    const supabaseClient = await loadSupabase();
    if (!supabaseClient) throw new Error('Supabase客户端未初始化');
    
    const userId = document.getElementById('userId').value;
    const userData = {
        name: document.getElementById('userName').value,
        gender: document.getElementById('userGender').value,
        age: parseInt(document.getElementById('userAge').value, 10),
        phone: document.getElementById('userPhone').value,
        direction: document.getElementById('userDirection').value
    };
    
    if (!userData.name || !userData.phone) {
        showToast('姓名和电话不能为空');
        return;
    }
    
    showToast('保存中...');
    
    try {
        let query;
        if (userId) {
            // 更新用户
            query = supabaseClient.from('New_user').update(userData).eq('id', userId);
        } else {
            // 添加用户
            query = supabaseClient.from('New_user').insert([userData]);
        }
        
        const { error } = await query;
        if (error) throw error;
        
        closeUserModal();
        showToast(userId ? '用户更新成功' : '添加用户成功');
        
        // 自动刷新用户列表
        await refreshUserList();
        
    } catch (error) {
        debugError('保存用户失败:', error.message);
        showToast('保存用户失败: ' + error.message);
    }
}

// 编辑用户
function editUser(userId) {
    try {
        const userToEdit = state.users.find(user => user.id === userId);
        if (!userToEdit) {
            showToast('未找到用户信息，可能数据未同步');
            return;
        }

        openAddUserModal();

        document.getElementById('userId').value = userToEdit.id;
        document.getElementById('userName').value = userToEdit.name || '';
        document.getElementById('userGender').value = userToEdit.gender || '';
        document.getElementById('userAge').value = userToEdit.age || '';
        document.getElementById('userPhone').value = userToEdit.phone || '';
        document.getElementById('userDirection').value = userToEdit.direction || '';
        document.getElementById('userModalTitle').textContent = '编辑用户';

    } catch (error) {
        debugError('打开编辑模态框失败:', error);
        showToast('打开编辑窗口时出错: ' + error.message);
    }
}

// 删除用户
async function deleteUser(userId) {
    showCustomConfirm('确定要删除该用户吗？此操作不可恢复。', async (confirmed) => {
        if (!confirmed) return;
        
        try {
            // 确保Supabase已加载
            const supabaseClient = await loadSupabase();
            const { error } = await supabaseClient.from('New_user').delete().eq('id', userId);
            if (error) throw error;
            
            showToast('用户删除成功');
            
            // 自动刷新用户列表
            await refreshUserList();

        } catch (error) {
            debugError('删除用户失败:', error.message);
            showToast('删除用户失败: ' + error.message);
        }
    });
}

// =================================
// 客户档案模态框
// =================================
// 优化的用户档案加载函数
async function openProfileModal(userId) {
    // 防止重复调用
    if (window.loadingProfileInProgress) {
        debugLog('用户档案加载正在进行中，跳过重复调用');
        return;
    }
    
    window.loadingProfileInProgress = true;
    
    const modal = document.getElementById('profileModal');
    const form = document.getElementById('profileForm');
    if (!modal || !form) {
        window.loadingProfileInProgress = false;
        return;
    }

    form.reset();
    document.getElementById('profileUserId').value = userId;

    // 从本地状态获取用户基本信息，避免额外查询
    const user = state.users.find(u => u.id === userId);
    document.getElementById('profileName').textContent = user?.name || 'N/A';
    document.getElementById('profileGender').textContent = user?.gender || 'N/A';
    document.getElementById('profilePhone').textContent = user?.phone || 'N/A';
    document.getElementById('profileFilingDate').textContent = '建档日期: -';

    // 清空BMI显示，避免显示上一个用户的数据
    const bmiDisplay = document.getElementById('profileBmi');
    if (bmiDisplay) {
        bmiDisplay.textContent = '';
        bmiDisplay.style.color = '';
        bmiDisplay.className = 'readonly-field';
    }

    modal.style.display = 'flex';

    // 初始化BMI计算功能
    setTimeout(() => {
        initBMICalculation();
    }, 100);

    const saveButton = form.querySelector('.btn-save');
    saveButton.disabled = true;
    saveButton.textContent = '加载中...';

    try {
        // 检查缓存
        const cacheKey = getCacheKey('user_profile', { userId });
        const cachedProfile = getCachedData(cacheKey);

        let profile;

        if (cachedProfile) {
            debugLog('使用缓存的用户档案数据');
            profile = cachedProfile;
        } else {
            // 性能优化：只选择需要的字段
            const supabaseClient = await loadSupabase();
            const { data, error } = await supabaseClient
                .from('user_profiles')
                .select(`
                    user_id, created_at, date_of_birth, address, diseases,
                    medical_history, conditioning_reason, height, weight,
                    medication_status, conditioning_content, systolic_pressure,
                    diastolic_pressure, fasting_blood_sugar, glycated_hemoglobin,
                    self_management_status, payment_status, estimated_time,
                    other_notes, filler_name, client_source, scheduled_time
                `)
                .eq('user_id', userId)
                .limit(1);

            debugLog(`档案加载完成`);

            if (error) throw error;

            profile = data && data.length > 0 ? data[0] : null;

            // 缓存结果
            if (profile) {
                setCachedData(cacheKey, profile);
            }
        }

        if (profile) {
            document.getElementById('profileFilingDate').textContent = `建档日期: ${new Date(profile.created_at).toLocaleDateString()}`;

            // 使用批量赋值优化DOM操作
            const formFields = {
                'profileDob': profile.date_of_birth,
                'profileAddress': profile.address,
                'profileDiseases': profile.diseases,
                'profileMedicalHistory': profile.medical_history,
                'profileConditioningReason': profile.conditioning_reason,
                'profileHeight': profile.height,
                'profileWeight': profile.weight,
                'profileMedicationStatus': profile.medication_status,
                'profileSystolic': profile.systolic_pressure,
                'profileDiastolic': profile.diastolic_pressure,
                'profileFastingSugar': profile.fasting_blood_sugar,
                'profileGlycatedHemoglobin': profile.glycated_hemoglobin,
                'profileSelf_management_status': profile.self_management_status,
                'profilePaymentStatus': profile.payment_status,
                'profileEstimatedTime': profile.estimated_time,
                'profileOtherNotes': profile.other_notes,
                'profileFiller': profile.filler_name,
                'profileClientSource': profile.client_source
            };

            // 批量更新表单值
            Object.entries(formFields).forEach(([id, value]) => {
                const element = document.getElementById(id);
                if (element) element.value = value || '';
            });

            if (profile.scheduled_time) {
                const d = new Date(profile.scheduled_time);
                const pad = (num) => num.toString().padStart(2, '0');
                const localDatetime = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
                document.getElementById('profileScheduledTime').value = localDatetime;
            } else {
                document.getElementById('profileScheduledTime').value = '';
            }

            // 优化复选框处理
            if (profile.conditioning_content?.length > 0) {
                const checkboxes = form.querySelectorAll('[name="conditioningContent"]');
                checkboxes.forEach(checkbox => {
                    checkbox.checked = profile.conditioning_content.includes(checkbox.value);
                });
            }

            // 计算并显示BMI
            calculateAndDisplayBMI();
        }
    } catch (error) {
        debugError('加载档案失败:', error);
        showToast(`加载档案失败: ${error.message}`);
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = '保存档案';
        window.loadingProfileInProgress = false;
    }
}

function closeProfileModal() {
    const modal = document.getElementById('profileModal');
    if (modal) modal.style.display = 'none';
}

async function saveProfile(event) {
    event.preventDefault();
    const userId = document.getElementById('profileUserId').value;
    
    const conditioningContent = Array.from(document.querySelectorAll('[name="conditioningContent"]:checked')).map(el => el.value);

    const profileData = {
        user_id: parseInt(userId, 10),
        date_of_birth: document.getElementById('profileDob').value || null,
        address: document.getElementById('profileAddress').value || null,
        diseases: document.getElementById('profileDiseases').value || null,
        medical_history: document.getElementById('profileMedicalHistory').value || null,
        conditioning_reason: document.getElementById('profileConditioningReason').value || null,
        height: document.getElementById('profileHeight').value ? Number(document.getElementById('profileHeight').value) : null,
        weight: document.getElementById('profileWeight').value ? Number(document.getElementById('profileWeight').value) : null,
        medication_status: document.getElementById('profileMedicationStatus').value || null,
        conditioning_content: conditioningContent,
        systolic_pressure: document.getElementById('profileSystolic').value ? parseInt(document.getElementById('profileSystolic').value) : null,
        diastolic_pressure: document.getElementById('profileDiastolic').value ? parseInt(document.getElementById('profileDiastolic').value) : null,
        fasting_blood_sugar: document.getElementById('profileFastingSugar').value ? Number(document.getElementById('profileFastingSugar').value) : null,
        glycated_hemoglobin: document.getElementById('profileGlycatedHemoglobin').value ? Number(document.getElementById('profileGlycatedHemoglobin').value) : null,
        self_management_status: document.getElementById('profileSelf_management_status').value || null,
        payment_status: document.getElementById('profilePaymentStatus').value || null,
        estimated_time: document.getElementById('profileEstimatedTime').value || null,
        other_notes: document.getElementById('profileOtherNotes').value || null,
        filler_name: document.getElementById('profileFiller').value || null,
        client_source: document.getElementById('profileClientSource').value || null,
        scheduled_time: document.getElementById('profileScheduledTime').value ? new Date(document.getElementById('profileScheduledTime').value).toISOString() : null
    };

    debugLog('准备保存的档案数据: ', JSON.stringify(profileData, null, 2));

    showToast('正在保存档案...');
    try {
        const supabaseClient = await loadSupabase();
        const { data, error } = await supabaseClient
            .from('user_profiles')
            .upsert(profileData, { onConflict: 'user_id' })
            .select();

        if (error) {
            debugError('Supabase 保存错误:', error);
            throw error;
        }

        debugLog('保存成功，返回数据:', data);
        showToast('档案保存成功!');
        closeProfileModal();
    } catch (error) {
        debugError('保存档案失败:', error);
        showToast(`保存档案失败: ${error.message}`);
    }
}

function completeProfile(userId) {
    openProfileModal(userId);
}

// BMI计算相关函数
function calculateBMI(height, weight) {
    if (!height || !weight || height <= 0 || weight <= 0) {
        return null;
    }

    // 身高转换为米
    const heightInMeters = height / 100;
    // BMI = 体重(kg) / 身高(m)²
    const bmi = weight / (heightInMeters * heightInMeters);

    return Math.round(bmi * 10) / 10; // 保留一位小数
}

function getBMICategory(bmi) {
    if (!bmi) return '';

    if (bmi < 18.5) {
        return '偏瘦';
    } else if (bmi < 24) {
        return '正常';
    } else if (bmi < 28) {
        return '偏胖';
    } else {
        return '肥胖';
    }
}

function calculateAndDisplayBMI() {
    const heightInput = document.getElementById('profileHeight');
    const weightInput = document.getElementById('profileWeight');
    const bmiDisplay = document.getElementById('profileBmi');

    if (!heightInput || !weightInput || !bmiDisplay) return;

    const height = parseFloat(heightInput.value);
    const weight = parseFloat(weightInput.value);

    // 检查是否有有效的身高和体重数据
    if (!height || !weight || height <= 0 || weight <= 0 ||
        isNaN(height) || isNaN(weight)) {
        // 如果没有有效数据，清空BMI显示
        bmiDisplay.textContent = '';
        bmiDisplay.style.color = '';
        bmiDisplay.className = 'readonly-field';
        return;
    }

    const bmi = calculateBMI(height, weight);

    if (bmi) {
        const category = getBMICategory(bmi);
        bmiDisplay.textContent = `${bmi} (${category})`;

        // 根据BMI分类添加颜色样式
        bmiDisplay.className = 'readonly-field bmi-display';
        if (category === '偏瘦') {
            bmiDisplay.style.color = '#74b9ff';
        } else if (category === '正常') {
            bmiDisplay.style.color = '#00b894';
        } else if (category === '偏胖') {
            bmiDisplay.style.color = '#fdcb6e';
        } else if (category === '肥胖') {
            bmiDisplay.style.color = '#e17055';
        }
    } else {
        bmiDisplay.textContent = '';
        bmiDisplay.style.color = '';
        bmiDisplay.className = 'readonly-field';
    }
}

// 初始化BMI计算事件监听器
function initBMICalculation() {
    const heightInput = document.getElementById('profileHeight');
    const weightInput = document.getElementById('profileWeight');

    if (heightInput && weightInput) {
        // 添加输入事件监听器
        heightInput.addEventListener('input', calculateAndDisplayBMI);
        weightInput.addEventListener('input', calculateAndDisplayBMI);

        // 添加失去焦点事件监听器
        heightInput.addEventListener('blur', calculateAndDisplayBMI);
        weightInput.addEventListener('blur', calculateAndDisplayBMI);
    }
}

// =================================
// 其他模态框与通用函数
// =================================

// 优化的提示消息函数
function showToast(message, autoHide = true) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.className = 'show';

    if (autoHide) {
        setTimeout(() => {
            toast.className = toast.className.replace('show', '');
        }, 3000);
    }

    return toast; // 返回toast元素以便外部控制
}

// 自定义确认框函数
function showCustomConfirm(message, callback) {
    let confirmOverlay = document.querySelector('.custom-confirm-overlay');
    if (confirmOverlay) confirmOverlay.remove();
    
    confirmOverlay = document.createElement('div');
    confirmOverlay.className = 'custom-confirm-overlay';
    
    const confirmBox = document.createElement('div');
    confirmBox.className = 'custom-confirm-box';
    confirmBox.innerHTML = `
        <div class="confirm-header"><h3>确认操作</h3></div>
        <div class="confirm-body"><p>${message}</p></div>
        <div class="confirm-footer">
            <button class="btn-confirm cancel">取消</button>
            <button class="btn-confirm confirm">确定</button>
        </div>
    `;
    
    confirmOverlay.appendChild(confirmBox);
    document.body.appendChild(confirmOverlay);
    
    const cancelBtn = confirmBox.querySelector('.btn-confirm.cancel');
    const confirmBtn = confirmBox.querySelector('.btn-confirm.confirm');
    
    cancelBtn.addEventListener('click', () => {
        confirmOverlay.remove();
        if (callback) callback(false);
    });
    
    confirmBtn.addEventListener('click', () => {
        confirmOverlay.remove();
        if (callback) callback(true);
    });
    
    confirmBtn.focus();
}

// 新增：查看报告
function viewReport(event, reportType, userId) {
    event.stopPropagation();
    event.preventDefault();
    
    // 关闭下拉菜单
    const dropdown = document.getElementById(`reportDropdown_${userId}`);
    if (dropdown) {
        dropdown.style.display = 'none';
    }
    
    // 根据报告类型打开相应页面
    if (reportType === 'sleep') {
        // 打开睡眠报告列表模态框
        openSleepReportModal(userId);
    } else if (reportType === 'navigation') {
        // 打开导航报告列表模态框
        openNavigationReportModal(userId);
    }
}

// 新增：打开睡眠报告列表模态框
function openSleepReportModal(userId) {
    const modal = document.getElementById('sleepReportModal');
    const reportList = document.getElementById('sleepReportList');

    // 模拟报告数据
    const reports = [
        { date: '2025-02-13 14:56:19', type: '睡眠报告', status: '已完成' },
        { date: '2025-02-13 11:52:32', type: '睡眠报告', status: '已完成' },
        { date: '2025-02-12 09:41:27', type: '睡眠报告', status: '已完成' },
    ];

    reportList.innerHTML = reports.map(report => `
        <tr>
            <td>${report.date}</td>
            <td><span class="report-type">${report.type}</span></td>
            <td><span class="status-badge ${report.status}">${report.status}</span></td>
            <td><button class="btn-view" onclick="viewSleepReport('${report.date}')">查看</button></td>
        </tr>
    `).join('');
    
    modal.style.display = 'flex';
}

// 新增：查看具体的睡眠报告
function viewSleepReport(date) {
    // 关闭睡眠报告列表模态框
    closeSleepReportModal();
    // 在新标签页中打开睡眠报告
    window.open('../partialshtml/Roomreport.html', '_blank');
}

// 新增：关闭睡眠报告模态框
function closeSleepReportModal() {
    const modal = document.getElementById('sleepReportModal');
    if(modal) modal.style.display = 'none';
}

// 新增：切换报告下拉菜单
function toggleReportDropdown(event, userId) {
    event.stopPropagation();
    event.preventDefault();
    
    const button = event.currentTarget;
    
    // 关闭所有其他下拉菜单
    document.querySelectorAll('.report-dropdown').forEach(dropdown => {
        if (dropdown.id !== `reportDropdown_${userId}`) {
            dropdown.style.display = 'none';
        }
    });
    
    // 移除所有其他按钮的active状态
    document.querySelectorAll('.report-dropdown-btn').forEach(btn => {
        if (btn !== button) {
            btn.classList.remove('active');
        }
    });
    
    // 切换当前下拉菜单
    const dropdown = document.getElementById(`reportDropdown_${userId}`);
    if (dropdown) {
        const isVisible = dropdown.style.display === 'block';
        dropdown.style.display = isVisible ? 'none' : 'block';
        
        // 切换按钮状态和箭头方向
        if (isVisible) {
            button.classList.remove('active');
        } else {
            button.classList.add('active');
        }
    }
}

// 修改：打开导航报告列表模态框
function openNavigationReportModal(userId) {
    const modal = document.getElementById('navigationReportModal');
    const reportList = document.getElementById('navigationReportList');

    // 模拟报告数据
    const reports = [
        { date: '2025-02-13 14:56:19', type: '导航报告', status: '已完成' },
        { date: '2025-02-13 11:52:32', type: '导航报告', status: '已完成' },
        { date: '2025-02-12 09:41:27', type: '导航报告', status: '已完成' },
    ];

    reportList.innerHTML = reports.map(report => `
        <tr>
            <td>${report.date}</td>
            <td><span class="report-type">${report.type}</span></td>
            <td><span class="status-badge ${report.status}">${report.status}</span></td>
            <td><button class="btn-view" onclick="viewNavigationReport('${report.date}')">查看</button></td>
        </tr>
    `).join('');
    
    modal.style.display = 'flex';
}

// 修改：查看导航报告
function viewNavigationReport(date) {
    // 关闭导航报告列表模态框
    closeNavigationReportModal();
    // 在新标签页中打开导航报告PDF
    window.open('https://lifetide.oss-cn-beijing.aliyuncs.com/upload/room/data/2025/2/12/601-2405294827-20250212141706891-2104240009.pdf', '_blank');
}

// 修改：关闭导航报告模态框
function closeNavigationReportModal() {
    const modal = document.getElementById('navigationReportModal');
    if(modal) modal.style.display = 'none';
}

// 点击页面其他地方时关闭所有下拉菜单
document.addEventListener('click', function(event) {
    if (!event.target.closest('.report-dropdown-btn')) {
        document.querySelectorAll('.report-dropdown').forEach(dropdown => {
            dropdown.style.display = 'none';
        });
        // 移除所有按钮的active状态
        document.querySelectorAll('.report-dropdown-btn').forEach(btn => {
            btn.classList.remove('active');
        });
    }
});

// 初始化悬停事件监听器
function initReportDropdownHover() {
    // 为所有报告下拉按钮添加悬停事件
    document.querySelectorAll('.report-dropdown-btn').forEach(btn => {
        let hoverTimeout;
        let hideTimeout;
        
        btn.addEventListener('mouseenter', function() {
            clearTimeout(hideTimeout);
            const dropdown = this.querySelector('.report-dropdown');
            if (dropdown) {
                // 先关闭其他下拉菜单
                document.querySelectorAll('.report-dropdown').forEach(d => {
                    if (d !== dropdown) d.style.display = 'none';
                });
                document.querySelectorAll('.report-dropdown-btn').forEach(b => {
                    if (b !== this) b.classList.remove('active');
                });
                
                // 300ms延迟显示
                hoverTimeout = setTimeout(() => {
                    dropdown.style.display = 'block';
                    this.classList.add('active');
                }, 300);
            }
        });
        
        btn.addEventListener('mouseleave', function() {
            clearTimeout(hoverTimeout);
            const dropdown = this.querySelector('.report-dropdown');
            
            hideTimeout = setTimeout(() => {
                if (dropdown && !dropdown.matches(':hover')) {
                    dropdown.style.display = 'none';
                    this.classList.remove('active');
                }
            }, 100);
        });
        
        // 为下拉菜单添加悬停事件，保持显示
        const dropdown = btn.querySelector('.report-dropdown');
        if (dropdown) {
            dropdown.addEventListener('mouseenter', function() {
                clearTimeout(hideTimeout);
            });
            
            dropdown.addEventListener('mouseleave', function() {
                hideTimeout = setTimeout(() => {
                    this.style.display = 'none';
                    btn.classList.remove('active');
                }, 100);
            });
        }
    });
}

async function logout() {
    try {
        // 调用 Supabase 登出，清除会话
        const supabaseClient = await loadSupabase();
        if (supabaseClient) {
            await supabaseClient.auth.signOut();
        }
    } catch (error) {
        console.warn('登出时 Supabase 调用失败:', error.message);
    }
    // 清理本地存储
    localStorage.removeItem('userInfo');
    sessionStorage.removeItem('userInfo');
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.indexOf('auth-token') !== -1) {
            localStorage.removeItem(k);
        }
    }
    window.location.href = 'login.html';
}

// =================================
// SPA 页面加载逻辑
// =================================
async function loadContent(url, clickedElement) {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // 立即更新侧边栏选中状态，提供即时反馈
    if (clickedElement) {
        document.querySelectorAll('.sidebar li').forEach(li => li.classList.remove('active'));
        clickedElement.classList.add('active');
    }

    // 有缓存：直接使用缓存内容，无网络请求、无闪烁
    if (partialCache.has(url)) {
        const cached = partialCache.get(url);
        if (cached && cached.html) {
            mainContent.innerHTML = cached.html;
            executePartialScripts(mainContent);
            if (url.includes('user_list.html')) {
                window.userListPageInitialized = false;
                await initUserListPage();
            }
            return;
        }
    }

    // 首次加载且当前内容为空时，显示加载动画
    const isEmpty = !mainContent.textContent.trim();
    if (isEmpty) {
        mainContent.innerHTML = '<div class="loading-overlay"><div class="loading-spinner"></div></div>';
    }

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`加载失败: ${response.status}`);

        const html = await response.text();

        // 缓存本次内容，下次切换即时显示
        partialCache.set(url, { html, timestamp: Date.now() });

        // 1. 插入 HTML
        mainContent.innerHTML = html;

        // 2. 查找并执行脚本
        executePartialScripts(mainContent);

        // 3. 用户列表页面需要特殊初始化
        if (url.includes('user_list.html')) {
            window.userListPageInitialized = false;
            await initUserListPage();
        }

        // 4. 后台预取其他子页面，让后续切换无延迟
        prefetchPartials();

    } catch (error) {
        debugError('加载内容时出错:', error);
        mainContent.innerHTML = `<div class="error-message">页面加载失败。</div>`;
    }
}

// 提取并执行页面片段内的脚本
function executePartialScripts(container) {
    const scripts = container.querySelectorAll('script');
    scripts.forEach(script => {
        const newScript = document.createElement('script');
        newScript.textContent = script.textContent;
        if (script.src) {
            newScript.src = script.src;
        }
        document.head.appendChild(newScript).parentNode.removeChild(newScript);
        script.remove(); // 移除页面中已经存在的 script 标签，避免重复
    });
}

// 后台预取尚未加载的子页面（静默缓存，不干扰当前页面）
function prefetchPartials() {
    const knownPartials = [
        '../partialshtml/user_list.html',
        '../partialshtml/health_trends.html',
        '../partialshtml/data_analysis.html'
    ];
    knownPartials.forEach(url => {
        if (partialCache.has(url)) return; // 已有缓存则跳过
        fetch(url)
            .then(res => res.ok ? res.text() : Promise.reject(new Error(res.status)))
            .then(html => partialCache.set(url, { html, timestamp: Date.now() }))
            .catch(err => debugLog(`预取失败: ${url}`, err));
    });
}

// 页面初始化函数
async function initUserListPage() {
    debugLog('初始化用户列表页面');

    // 重置分页状态到第一页
    state.pagination.currentPage = 1;
    
    initUserListEventListeners();
    createUserModal(); // 预创建模态框
    await loadAndRenderUsers();
    initReportDropdownHover(); // 初始化报告下拉菜单悬停事件
}

// 优化的统一加载和渲染函数
async function loadAndRenderUsers() {
    // 防止重复调用
    if (window.loadingUsersInProgress) {
        debugLog('用户数据加载正在进行中，跳过重复调用');
        return;
    }
    
    window.loadingUsersInProgress = true;
    const loadingToast = showToast('正在加载数据...', false);

    try {
        // 使用性能标记
        performance.mark('loadStart');

        // 先渲染表格骨架屏以提高感知性能
        renderTableSkeleton();

        const result = await loadUsers();

        if(result.success) {
            // 使用requestAnimationFrame确保在下一帧渲染，避免阻塞主线程
            window.requestAnimationFrame(() => {
                renderTable();
                updatePagination();

                // 清除性能标记
                performance.clearMarks();
                performance.clearMeasures();

                debugLog(`数据加载和渲染完成`);

                if (loadingToast) {
                    loadingToast.textContent = `数据加载完成`;
                    setTimeout(() => {
                        loadingToast.className = loadingToast.className.replace('show', '');
                    }, 2000);
                } else {
                    showToast(`数据加载完成`);
                }
            });
        } else {
            if (loadingToast) {
                loadingToast.className = loadingToast.className.replace('show', '');
            }
        }
    } finally {
        // 确保标志位被重置
        window.loadingUsersInProgress = false;
    }
}

// 渲染表格骨架屏
function renderTableSkeleton() {
    const tbody = document.querySelector('.data-table tbody');
    if (!tbody) return;

    tbody.innerHTML = '';

    // 创建骨架行
    for (let i = 0; i < state.pagination.pageSize; i++) {
        const row = document.createElement('tr');
        row.className = 'skeleton-row';

        row.innerHTML = `
            <td><div class="skeleton-checkbox"></div></td>
            <td><div class="skeleton-text"></div></td>
            <td><div class="skeleton-text short"></div></td>
            <td><div class="skeleton-text short"></div></td>
            <td><div class="skeleton-text"></div></td>
            <td><div class="skeleton-tag"></div></td>
            <td><div class="skeleton-buttons"></div></td>
            <td><div class="skeleton-icons"></div></td>
        `;

        tbody.appendChild(row);
    }

    // 添加骨架屏样式
    if (!document.getElementById('skeleton-styles')) {
        const style = document.createElement('style');
        style.id = 'skeleton-styles';
        style.textContent = `
            .skeleton-row td div {
                background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
                background-size: 200% 100%;
                animation: skeleton-loading 1.5s infinite;
                border-radius: 4px;
                height: 20px;
            }
            .skeleton-text { width: 80%; }
            .skeleton-text.short { width: 40%; }
            .skeleton-checkbox { width: 16px; height: 16px; border-radius: 3px; }
            .skeleton-tag { width: 60%; height: 24px; border-radius: 12px; }
            .skeleton-buttons { width: 90%; height: 32px; border-radius: 4px; }
            .skeleton-icons { width: 60px; }
            @keyframes skeleton-loading {
                0% { background-position: 200% 0; }
                100% { background-position: -200% 0; }
            }
        `;
        document.head.appendChild(style);
    }
}

// 性能监控函数
function monitorPerformance() {
    // 监控网络请求性能
    if (window.PerformanceObserver) {
        try {
            const observer = new PerformanceObserver((list) => {
                list.getEntries().forEach((entry) => {
                    // 监控Supabase API请求
                    if (entry.name.includes('supabase.co') && entry.initiatorType === 'fetch') {
                        debugLog(`API请求: ${entry.name.split('?')[0]}`);
                        debugLog(`  耗时: ${entry.duration.toFixed(2)}ms`);
                        debugLog(`  开始时间: ${entry.startTime.toFixed(2)}ms`);
                        debugLog(`  传输大小: ${(entry.transferSize / 1024).toFixed(2)}KB`);

                        // 记录慢请求
                        if (entry.duration > 500) {
                            console.warn(`⚠️ 慢请求检测: ${entry.name.split('?')[0]} (${entry.duration.toFixed(0)}ms)`);
                        }
                    }
                    
                    // 监控CDN加载性能
                    if (entry.name.includes('unpkg.com') || entry.name.includes('cdn.jsdelivr.net') || entry.name.includes('cdnjs.cloudflare.com')) {
                        const cdnName = entry.name.includes('unpkg.com') ? 'unpkg' : 
                                       entry.name.includes('cdn.jsdelivr.net') ? 'jsdelivr' : 'cloudflare';
                        debugLog(`CDN加载: ${cdnName}`);
                        debugLog(`  耗时: ${entry.duration.toFixed(2)}ms`);
                        debugLog(`  传输大小: ${(entry.transferSize / 1024).toFixed(2)}KB`);
                        
                        // 记录CDN性能
                        if (entry.duration > 1000) {
                            console.warn(`⚠️ CDN加载较慢: ${cdnName} (${entry.duration.toFixed(0)}ms)`);
                        } else {
                            console.log(`✅ CDN加载正常: ${cdnName} (${entry.duration.toFixed(0)}ms)`);
                        }
                    }
                });
            });

            observer.observe({ entryTypes: ['resource'] });
            console.log('性能监控已启用 (包含CDN监控)');
        } catch (e) {
            console.error('性能监控初始化失败:', e);
        }
    }

    // 监控长任务
    if (window.PerformanceObserver) {
        try {
            const longTaskObserver = new PerformanceObserver((list) => {
                list.getEntries().forEach((entry) => {
                    console.warn(`⚠️ 检测到长任务: ${entry.duration.toFixed(2)}ms`);
                });
            });

            longTaskObserver.observe({ entryTypes: ['longtask'] });
        } catch (e) {
            console.error('长任务监控初始化失败:', e);
        }
    }
}

// 页面首次加载时执行
document.addEventListener('DOMContentLoaded', () => {
    console.time('页面初始化');

    // 启用性能监控
    monitorPerformance();

    // 预热连接到Supabase服务器和CDN，减少连接时间
    const preconnectUrls = [
        'https://gxohpxiekmpsmkzkcxfc.supabase.co',  // Supabase服务器
        'https://unpkg.com',  // unpkg CDN (国内访问较快)
        'https://cdn.jsdelivr.net'  // jsdelivr CDN 备用
    ];
    
    preconnectUrls.forEach(url => {
        const linkPreconnect = document.createElement('link');
        linkPreconnect.rel = 'preconnect';
        linkPreconnect.href = url;
        linkPreconnect.crossOrigin = 'anonymous';
        document.head.appendChild(linkPreconnect);
    });

    // 延迟加载用户列表，提高首屏加载速度
    setTimeout(() => {
        const initialElement = document.querySelector('.sidebar li.active');
        if (initialElement) {
            loadContent('../partialshtml/user_list.html', initialElement);
        }
    }, 100);

    // 全局ESC关闭模态框
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            closeUserModal();
            closeProfileModal();
            closeNavigationReportModal();
        }
    });

    console.timeEnd('页面初始化');

    // 添加网络状态监控
    window.addEventListener('online', () => {
        showToast('网络已连接', true);
        // 网络恢复后可以刷新数据
        if (document.querySelector('.data-table')) {
            loadAndRenderUsers();
        }
    });

    window.addEventListener('offline', () => {
        showToast('网络已断开，部分功能可能不可用', true);
    });
});
