/**
 * ============================================================
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');
const AdmZip = require('adm-zip');
const mineflayer = require("mineflayer");
const express = require('express');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const multer = require('multer');
const FormData = require('form-data');
const qs = require('qs');
const Vec3 = require('vec3');
const playwright = require('playwright');
const session = require('express-session');
const WebSocket = require('ws');
const http = require('http');
const { pipeline } = require('stream');

// ========== 新增 Discord 功能 ==========
// 用于发送 Discord 消息的函数
async function sendDiscordMessage(taskConfig, message) {
    const { discordWebhookUrl, discordSelfBotToken, discordChannelId, discordSelfBotMode = false } = taskConfig;
    
    try {
        if (discordSelfBotMode && discordSelfBotToken && discordChannelId) {
            // 使用 Self-bot 模式发送消息
            const url = `https://discord.com/api/v9/channels/${discordChannelId}/messages`;
            
            const response = await axios.post(url, {
                content: message,
                tts: false,
                flags: 0
            }, {
                headers: {
                    'Authorization': discordSelfBotToken,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });
            
            return {
                success: true,
                message: 'Discord 消息发送成功',
                data: response.data
            };
        } else if (discordWebhookUrl) {
            // 使用 Webhook 模式发送消息
            const response = await axios.post(discordWebhookUrl, {
                content: message,
                username: taskConfig.discordUsername || 'Pathfinder Pro',
                avatar_url: taskConfig.discordAvatarUrl || '',
                tts: false
            }, {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });
            
            return {
                success: true,
                message: 'Discord 消息发送成功',
                data: response.data
            };
        } else {
            return {
                success: false,
                message: 'Discord 配置不完整'
            };
        }
    } catch (error) {
        return {
            success: false,
            message: `Discord 消息发送失败: ${error.message}`
        };
    }
}

// 任务中心新增 Discord 消息任务
async function executeTaskDiscord(task) {
    try {
        const { message, discordWebhookUrl, discordSelfBotToken, discordChannelId, discordSelfBotMode, discordUsername, discordAvatarUrl } = task.config;
        
        if (!message) {
            addTaskLog(task.id, `Discord 任务失败: 未配置消息内容`, 'error');
            return { success: false, message: '未配置消息内容' };
        }
        
        if (!discordSelfBotMode && !discordWebhookUrl) {
            addTaskLog(task.id, `Discord 任务失败: 请配置 Webhook URL 或启用 Self-bot`, 'error');
            return { success: false, message: '请配置 Webhook URL 或启用 Self-bot' };
        }
        
        if (discordSelfBotMode && (!discordSelfBotToken || !discordChannelId)) {
            addTaskLog(task.id, `Discord 任务失败: Self-bot 模式需要 Token 和 Channel ID`, 'error');
            return { success: false, message: 'Self-bot 模式需要 Token 和 Channel ID' };
        }
        
        addTaskLog(task.id, `开始发送 Discord 消息...`, 'info');
        
        const result = await sendDiscordMessage(task.config, message);
        
        if (result.success) {
            addTaskLog(task.id, `Discord 消息发送成功`, 'success');
        } else {
            addTaskLog(task.id, `Discord 消息发送失败: ${result.message}`, 'error');
        }
        
        return result;
    } catch (err) {
        const message = `Discord 任务执行失败: ${err.message}`;
        addTaskLog(task.id, message, 'error');
        return { success: false, message: message };
    }
}

// ========== 全局禁用axios默认请求头，避免CF盾检测 ==========
axios.defaults.headers.common = {};
axios.defaults.headers.post = {};
axios.defaults.headers.put = {};
// =============================================================================

// ========== 全局变量和配置 ==========
const app = express();
const activeBots = new Map();
const CONFIG_FILE = path.join(__dirname, 'bots_config.json');
const TASK_CENTER_FILE = path.join(__dirname, 'task_center_config.json');
const upload = multer({ storage: multer.memoryStorage() });

const GAME_VOCABULARY = [
    "哈喽，大家今天肝得怎么样？", "有人在吗？这世界好安静...", "老玩家回归，现在版本变动大吗？",
    "路过帮顶，这服建设得不错！", "刚才那个瞬移是怎么做到的？牛逼。", "萌新刚来，请多关照~",
    "挖到了 5 个远古残骸，这波不亏。", "MC 2025，这游戏还能再战十年！"
];

const labelMap = { chat: "自动喊话", ai: "AI视角", walk: "巡逻模式" };

// ========== 增强的续期关键词（多语言支持） ==========
const RENEW_KEYWORDS = {
    chinese: ['续期', '续费', '续订', '延长', '充值', '支付', '购买', '升级', '会员', '订阅'],
    english: ['renew', 'subscribe', 'extend', 'purchase', 'payment', 'pay', 'upgrade', 'membership', 'subscription', 'order'],
    mixed: ['renewal', 'checkout', 'paynow', 'topup', 'recharge', 'buy now', 'add time']
};

// ========== 续期请求特征词 ==========
const RENEW_REQUEST_PATTERNS = [
    '/renew', '/subscribe', '/payment', '/checkout', '/upgrade',
    '/api/renew', '/api/subscribe', '/api/payment',
    '/user/renew', '/user/subscription',
    'action=renew', 'action=subscribe', 'type=payment'
];

// ========== 任务中心数据（增强版） ==========
let taskCenterData = {
    tasks: [],
    settings: {
        autoClearLogs: true,
        maxLogEntries: 100,
        enableAutoLogin: true
    }
};

// ========== 静默网络连接错误 ==========
process.on('uncaughtException', (err) => { 
    // 静默处理
});
process.on('unhandledRejection', (reason) => {
    // 静默处理
});

// ========== 密码锁配置 ==========
const AUTH_CONFIG = {
    PASSWORD: "1715", // 访问密码
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'), // 会话密钥
    SESSION_TIMEOUT: 24 * 60 * 60 * 1000, // 24小时会话超时
    MAX_LOGIN_ATTEMPTS: 5, // 最大登录尝试次数
    LOCKOUT_TIME: 15 * 60 * 1000 // 锁定15分钟
};

// ========== 登录尝试记录 ==========
let loginAttempts = new Map();

// ========== Session配置 ==========
app.use(session({
    secret: AUTH_CONFIG.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        maxAge: AUTH_CONFIG.SESSION_TIMEOUT,
        httpOnly: true
    },
    name: 'pathfinder.session'
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========== 登录HTML模板 ==========
const LOGIN_HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pathfinder PRO 2025 - 身份验证</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        body {
            background: linear-gradient(135deg, #020617 0%, #0f172a 100%);
            color: #f8fafc;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .login-container {
            background: rgba(15, 23, 42, 0.8);
            backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 20px;
            padding: 3rem;
            width: 100%;
            max-width: 400px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            animation: fadeIn 0.5s ease-out;
        }
        .logo {
            text-align: center;
            margin-bottom: 2rem;
        }
        .logo-icon {
            font-size: 3.5rem;
            background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 1rem;
        }
        .title {
            font-size: 1.5rem;
            font-weight: 800;
            background: linear-gradient(135deg, #60a5fa 0%, #a78bfa 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 0.5rem;
        }
        .subtitle {
            color: #94a3b8;
            font-size: 0.875rem;
            margin-bottom: 2rem;
            text-align: center;
        }
        .input-group {
            margin-bottom: 1.5rem;
        }
        .input-label {
            display: block;
            color: #cbd5e1;
            font-size: 0.875rem;
            font-weight: 500;
            margin-bottom: 0.5rem;
        }
        .password-input {
            width: 100%;
            padding: 0.875rem 1rem;
            background: rgba(30, 41, 59, 0.5);
            border: 1px solid rgba(71, 85, 105, 0.5);
            border-radius: 12px;
            color: white;
            font-size: 1rem;
            transition: all 0.2s ease;
        }
        .password-input:focus {
            outline: none;
            border-color: #3b82f6;
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }
        .password-input.error {
            border-color: #ef4444;
            box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.1);
        }
        .submit-btn {
            width: 100%;
            padding: 1rem;
            background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%);
            border: none;
            border-radius: 12px;
            color: white;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
        }
        .submit-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(59, 130, 246, 0.3);
        }
        .submit-btn:active {
            transform: translateY(0);
        }
        .submit-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none !important;
        }
        .error-message {
            color: #f87171;
            font-size: 0.875rem;
            margin-top: 0.5rem;
            text-align: center;
            min-height: 1.25rem;
        }
        .hint {
            color: #64748b;
            font-size: 0.75rem;
            text-align: center;
            margin-top: 1.5rem;
        }
        .attempts-warning {
            color: #f59e0b;
            font-size: 0.75rem;
            text-align: center;
            margin-top: 0.5rem;
        }
        .lockout-message {
            color: #ef4444;
            font-size: 0.875rem;
            text-align: center;
            margin-top: 1rem;
            background: rgba(239, 68, 68, 0.1);
            padding: 0.75rem;
            border-radius: 8px;
            border: 1px solid rgba(239, 68, 68, 0.2);
        }
        .security-info {
            margin-top: 2rem;
            padding: 1rem;
            background: rgba(30, 41, 59, 0.5);
            border-radius: 12px;
            border: 1px solid rgba(71, 85, 105, 0.3);
        }
        .security-title {
            color: #94a3b8;
            font-size: 0.75rem;
            font-weight: 600;
            margin-bottom: 0.5rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        .security-features {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 0.75rem;
        }
        .feature {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-size: 0.75rem;
            color: #cbd5e1;
        }
        .feature i {
            color: #10b981;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        @keyframes shake {
            0%, 100% { transform: translateX(0); }
            10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); }
            20%, 40%, 60%, 80% { transform: translateX(5px); }
        }
        .shake {
            animation: shake 0.5s ease-in-out;
        }
    </style>
</head>
<body>
    <div class="login-container">
        <div class="logo">
            <div class="logo-icon">
                <i class="fas fa-lock"></i>
            </div>
            <h1 class="title">Pathfinder PRO 2025</h1>
            <p class="subtitle">高级Minecraft机器人管理面板</p>
        </div>
        
        <form id="loginForm">
            <div class="input-group">
                <label class="input-label">
                    <i class="fas fa-key mr-1"></i>
                    访问密码
                </label>
                <input 
                    type="password" 
                    id="password" 
                    class="password-input" 
                    placeholder="请输入访问密码" 
                    autocomplete="off"
                    required
                    autofocus
                >
                <div id="errorMessage" class="error-message"></div>
            </div>
            
            <div id="attemptsWarning" class="attempts-warning hidden"></div>
            <div id="lockoutMessage" class="lockout-message hidden"></div>
            
            <button type="submit" class="submit-btn" id="submitBtn">
                <i class="fas fa-sign-in-alt mr-2"></i>
                进入控制面板
            </button>
            
            <p class="hint">
                <i class="fas fa-info-circle mr-1"></i>
                请输入正确的密码以访问系统
            </p>
        </form>
        
        <div class="security-info">
            <div class="security-title">
                <i class="fas fa-shield-alt"></i>
                安全特性
            </div>
            <div class="security-features">
                <div class="feature">
                    <i class="fas fa-clock"></i>
                    会话超时保护
                </div>
                <div class="feature">
                    <i class="fas fa-ban"></i>
                    登录尝试限制
                </div>
                <div class="feature">
                    <i class="fas fa-lock"></i>
                    加密会话
                </div>
                <div class="feature">
                    <i class="fas fa-history"></i>
                    失败记录
                </div>
            </div>
        </div>
    </div>
    
    <script>
        const form = document.getElementById('loginForm');
        const passwordInput = document.getElementById('password');
        const errorMessage = document.getElementById('errorMessage');
        const submitBtn = document.getElementById('submitBtn');
        const attemptsWarning = document.getElementById('attemptsWarning');
        const lockoutMessage = document.getElementById('lockoutMessage');
        
        let isSubmitting = false;
        let failedAttempts = 0;
        
        // 检查是否有锁定信息
        function checkLockStatus() {
            const lockData = localStorage.getItem('loginLock');
            if (lockData) {
                const { timestamp, attempts } = JSON.parse(lockData);
                const timeDiff = Date.now() - timestamp;
                
                if (timeDiff < ${AUTH_CONFIG.LOCKOUT_TIME}) {
                    const remainingMinutes = Math.ceil((${AUTH_CONFIG.LOCKOUT_TIME} - timeDiff) / 60000);
                    lockoutMessage.textContent = \`账号已锁定，请在 \${remainingMinutes} 分钟后重试\`;
                    lockoutMessage.classList.remove('hidden');
                    attemptsWarning.classList.add('hidden');
                    passwordInput.disabled = true;
                    submitBtn.disabled = true;
                    return true;
                } else {
                    // 锁定时间已过，清除记录
                    localStorage.removeItem('loginLock');
                }
            }
            return false;
        }
        
        // 更新尝试次数警告
        function updateAttemptsWarning() {
            if (failedAttempts > 0) {
                const remaining = ${AUTH_CONFIG.MAX_LOGIN_ATTEMPTS} - failedAttempts;
                attemptsWarning.textContent = \`登录失败 \${failedAttempts} 次，剩余 \${remaining} 次尝试\`;
                attemptsWarning.classList.remove('hidden');
            } else {
                attemptsWarning.classList.add('hidden');
            }
        }
        
        // 记录失败尝试
        function recordFailedAttempt() {
            failedAttempts++;
            localStorage.setItem('loginLock', JSON.stringify({
                timestamp: Date.now(),
                attempts: failedAttempts
            }));
            
            if (failedAttempts >= ${AUTH_CONFIG.MAX_LOGIN_ATTEMPTS}) {
                lockoutMessage.textContent = \`尝试次数过多，账号已锁定 \${Math.ceil(${AUTH_CONFIG.LOCKOUT_TIME} / 60000)} 分钟\`;
                lockoutMessage.classList.remove('hidden');
                passwordInput.disabled = true;
                submitBtn.disabled = true;
            } else {
                updateAttemptsWarning();
            }
        }
        
        // 初始化
        function init() {
            if (checkLockStatus()) {
                return;
            }
            
            // 从本地存储恢复尝试次数
            const lockData = localStorage.getItem('loginLock');
            if (lockData) {
                const { attempts } = JSON.parse(lockData);
                failedAttempts = attempts || 0;
                updateAttemptsWarning();
            }
        }
        
        // 表单提交处理
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            if (isSubmitting) return;
            if (checkLockStatus()) return;
            
            const password = passwordInput.value.trim();
            if (!password) {
                showError('请输入密码');
                return;
            }
            
            isSubmitting = true;
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>验证中...';
            
            try {
                const response = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ password })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    // 登录成功，清除失败记录
                    localStorage.removeItem('loginLock');
                    errorMessage.textContent = '';
                    
                    // 显示成功消息
                    submitBtn.innerHTML = '<i class="fas fa-check mr-2"></i>验证成功！';
                    submitBtn.style.background = 'linear-gradient(135deg, #10b981 0%, #34d399 100%)';
                    
                    // 延迟跳转
                    setTimeout(() => {
                        window.location.href = '/dashboard';
                    }, 800);
                } else {
                    // 登录失败
                    recordFailedAttempt();
                    showError(data.message || '密码错误');
                    passwordInput.classList.add('shake');
                    setTimeout(() => {
                        passwordInput.classList.remove('shake');
                    }, 500);
                    
                    // 清空密码框
                    passwordInput.value = '';
                    passwordInput.focus();
                    
                    submitBtn.innerHTML = '<i class="fas fa-sign-in-alt mr-2"></i>重新尝试';
                }
            } catch (error) {
                showError('网络错误，请稍后重试');
                submitBtn.innerHTML = '<i class="fas fa-sign-in-alt mr-2"></i>重新尝试';
            } finally {
                isSubmitting = false;
                submitBtn.disabled = false;
            }
        });
        
        function showError(message) {
            errorMessage.textContent = message;
            passwordInput.classList.add('error');
            setTimeout(() => {
                passwordInput.classList.remove('error');
            }, 2000);
        }
        
        // 输入时清除错误信息
        passwordInput.addEventListener('input', () => {
            errorMessage.textContent = '';
            passwordInput.classList.remove('error');
        });
        
        // 页面加载时初始化
        document.addEventListener('DOMContentLoaded', init);
    </script>
</body>
</html>
`;

// ========== 认证中间件 ==========
function requireAuth(req, res, next) {
    if (req.session.authenticated) {
        req.session.touch();
        next();
    } else {
        if (req.path === '/' || req.path === '/api/auth/login' || req.path === '/login') {
            return next();
        }
        
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ 
                success: false, 
                message: '需要身份验证',
                redirect: '/'
            });
        }
        
        res.redirect('/');
    }
}

app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/api/auth/login' || req.path === '/login') {
        return next();
    }
    requireAuth(req, res, next);
});

// ========== 辅助函数 ==========
function safeClone(obj) {
    try {
        return JSON.parse(JSON.stringify(obj, (key, value) => {
            if (['instance', 'afkTimer', 'reconnectTimer', 'renewTimer', 'playwrightTimer', 'requestTimer'].includes(key)) return undefined;
            return value;
        }));
    } catch (e) { return {}; }
}

async function saveBotsConfig() {
    try {
        const configData = Array.from(activeBots.values()).map(b => ({
            id: b.id, host: b.targetHost, port: b.targetPort, username: b.username, 
            settings: safeClone(b.settings),
            renewCookieBindings: b.renewCookieBindings || [],
            lastSuccessCookie: b.lastSuccessCookie || ""
        }));
        await fs.writeFile(CONFIG_FILE, JSON.stringify(configData, null, 2));
    } catch (err) {}
}

async function loadTaskCenterConfig() {
    try {
        if (fsSync.existsSync(TASK_CENTER_FILE)) {
            const data = await fs.readFile(TASK_CENTER_FILE, 'utf8');
            taskCenterData = JSON.parse(data);
        } else {
            await saveTaskCenterConfig();
        }
    } catch (e) {
        taskCenterData = {
            tasks: [],
            settings: {
                autoClearLogs: true,
                maxLogEntries: 100,
                enableAutoLogin: true
            }
        };
        await saveTaskCenterConfig();
    }
}

async function saveTaskCenterConfig() {
    try {
        await fs.writeFile(TASK_CENTER_FILE, JSON.stringify(taskCenterData, null, 2));
    } catch (err) {}
}

// --- [ Cookie 工具函数 ] ---
function parseCookieToObj(cookieStr) {
    if (!cookieStr || typeof cookieStr !== 'string') return {};
    const cookieObj = {};
    const cookieItems = cookieStr.split('; ');
    cookieItems.forEach(item => {
        const [key, ...valueParts] = item.split('=');
        if (key && valueParts.length > 0) {
            cookieObj[key.trim()] = valueParts.join('=').trim();
        }
    });
    return cookieObj;
}

function stringifyCookieObj(cookieObj) {
    if (!cookieObj || typeof cookieObj !== 'object') return "";
    return Object.entries(cookieObj).map(([key, value]) => `${key}=${value}`).join('; ');
}

function extractCookieSignature(cookieObj) {
    if (!cookieObj) return { keyList: [], coreKeys: [] };
    const keyList = Object.keys(cookieObj).filter(key => key.trim() !== '');
    const coreKeyWords = ['session', 'token', 'auth', 'login', 'user', 'sid', 'csrf', 'renew'];
    const coreKeys = keyList.filter(key => {
        const lowerKey = key.toLowerCase();
        return coreKeyWords.some(word => lowerKey.includes(word));
    });
    return { keyList, coreKeys };
}

function filterCookieBySignature(newCookieObj, savedSignature) {
    if (!savedSignature || !savedSignature.keyList || savedSignature.keyList.length === 0) {
        return newCookieObj;
    }
    const targetCookieObj = {};
    const newCookieKeys = Object.keys(newCookieObj);
    if (savedSignature.coreKeys && savedSignature.coreKeys.length > 0) {
        newCookieKeys.forEach(key => {
            if (savedSignature.coreKeys.includes(key) || savedSignature.keyList.includes(key)) {
                targetCookieObj[key] = newCookieObj[key];
            }
        });
    } else {
        newCookieKeys.forEach(key => {
            if (savedSignature.keyList.includes(key)) {
                targetCookieObj[key] = newCookieObj[key];
            }
        });
    }
    return targetCookieObj;
}

function findCookieBinding(bindings, renewUrl, loginUrl, username) {
    if (!bindings || !Array.isArray(bindings) || !renewUrl || !loginUrl) {
        return { cookieSignature: {} };
    }
    return bindings.find(bind => 
        bind.renewUrl.trim().toLowerCase() === renewUrl.trim().toLowerCase() &&
        bind.loginUrl.trim().toLowerCase() === loginUrl.trim().toLowerCase() &&
        bind.username.trim().toLowerCase() === username.trim().toLowerCase()
    ) || { cookieSignature: {} };
}

function updateCookieBinding(bindings, renewUrl, loginUrl, username, cookieSignature) {
    if (!Array.isArray(bindings)) bindings = [];
    const cleanRenewUrl = renewUrl.trim().toLowerCase();
    const cleanLoginUrl = loginUrl.trim().toLowerCase();
    const cleanUsername = username.trim().toLowerCase();

    const existIndex = bindings.findIndex(bind => 
        bind.renewUrl.trim().toLowerCase() === cleanRenewUrl &&
        bind.loginUrl.trim().toLowerCase() === cleanLoginUrl &&
        bind.username.trim().toLowerCase() === cleanUsername
    );

    const newBinding = {
        renewUrl: renewUrl.trim(),
        loginUrl: loginUrl.trim(),
        username: username.trim(),
        cookieSignature: cookieSignature || {},
        updateTime: new Date().toLocaleString()
    };

    if (existIndex > -1) {
        bindings[existIndex] = newBinding;
    } else {
        bindings.push(newBinding);
    }

    return bindings;
}

function calculateCookieSimilarity(cookie1, cookie2) {
    if (!cookie1 || !cookie2) return 0;
    
    const obj1 = parseCookieToObj(cookie1);
    const obj2 = parseCookieToObj(cookie2);
    
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    
    if (keys1.length === 0 || keys2.length === 0) return 0;
    
    const allKeys = new Set([...keys1, ...keys2]);
    let matchCount = 0;
    let totalCompared = 0;
    
    for (const key of allKeys) {
        if (!key || key.trim() === '') continue;
        
        const val1 = obj1[key];
        const val2 = obj2[key];
        
        if (val1 !== undefined && val2 !== undefined) {
            totalCompared++;
            if (val1 === val2) {
                matchCount++;
            } else {
                if (key.toLowerCase().includes('expires') || key.toLowerCase().includes('max-age')) {
                    if (typeof val1 === 'string' && typeof val2 === 'string') {
                        const isDate1 = !isNaN(Date.parse(val1));
                        const isDate2 = !isNaN(Date.parse(val2));
                        if (isDate1 && isDate2) {
                            matchCount += 0.5;
                        }
                    }
                }
            }
        }
    }
    
    const coreKeys = ['session', 'token', 'auth', 'login', 'user', 'sid', 'csrf'];
    let coreMatchCount = 0;
    let coreTotal = 0;
    
    for (const key of coreKeys) {
        if (obj1[key] && obj2[key]) {
            coreTotal++;
            if (obj1[key] === obj2[key]) {
                coreMatchCount++;
            }
        }
    }
    
    const baseSimilarity = totalCompared > 0 ? (matchCount / totalCompared) : 0;
    const coreSimilarity = coreTotal > 0 ? (coreMatchCount / coreTotal) : 1;
    const finalSimilarity = (coreSimilarity * 0.7) + (baseSimilarity * 0.3);
    
    return finalSimilarity;
}

function selectBestRenewRequest(requests) {
    if (!requests || requests.length === 0) return null;
    
    const scoredRequests = requests.map(request => ({
        ...request,
        score: calculateRequestScore(request)
    }));
    
    scoredRequests.sort((a, b) => b.score - a.score);
    
    return scoredRequests[0];
}

function calculateRequestScore(request) {
    let score = 0;
    const url = request.url.toLowerCase();
    const postData = (request.postData || '').toLowerCase();
    const headers = request.headers || {};
    const contentType = (headers['content-type'] || '').toLowerCase();
    
    if (request.method === 'POST') score += 10;
    if (request.method === 'PUT') score += 8;
    if (request.method === 'GET') score += 1;
    
    if (url.includes('/api/')) score += 8;
    if (url.includes('/v1/') || url.includes('/v2/')) score += 5;
    
    const renewPathKeywords = ['renew', 'subscribe', 'payment', 'checkout', 'upgrade', 'billing'];
    renewPathKeywords.forEach(keyword => {
        if (url.includes(keyword)) score += 6;
    });
    
    if (url.match(/\.(png|jpg|jpeg|gif|ico|css|js|woff|woff2|ttf|svg)$/)) score -= 20;
    if (url.includes('/static/') || url.includes('/assets/')) score -= 15;
    
    if (contentType.includes('application/json')) score += 8;
    if (contentType.includes('application/x-www-form-urlencoded')) score += 6;
    if (contentType.includes('multipart/form-data')) score += 4;
    if (contentType.includes('text/html')) score -= 5;
    
    if (postData) {
        score += 5;
        
        const renewDataKeywords = [
            'renew', 'subscribe', 'payment', 'amount', 'price', 
            'plan_id', 'subscription_id', 'user_id', 'order'
        ];
        
        renewDataKeywords.forEach(keyword => {
            if (postData.includes(keyword)) score += 4;
        });
        
        try {
            JSON.parse(postData);
            score += 3;
        } catch (e) {
            if (postData.includes('=') && postData.includes('&')) score += 2;
        }
    }
    
    if (url.length > 100) score += 2;
    if (url.includes('?')) score += 1;
    
    if (url.includes('google-analytics') || url.includes('gtag')) score -= 25;
    if (url.includes('facebook.com/tr') || url.includes('fbq')) score -= 25;
    if (url.includes('analytics')) score -= 20;
    if (url.includes('ads')) score -= 15;
    
    if (contentType.includes('image/')) score -= 20;
    if (contentType.includes('text/css')) score -= 15;
    if (contentType.includes('application/javascript')) score -= 15;
    if (contentType.includes('font/')) score -= 15;
    
    return Math.max(score, 0);
}

// --- [ 独立续期排程系统 ] ---
function scheduleNextRenew(botId) {
    const botMeta = activeBots.get(botId);
    if (!botMeta || botMeta.renewTimer || !botMeta.settings.renew.enabled) {
        return;
    }

    const minMs = 30 * 60 * 1000;
    const maxMs = 120 * 60 * 1000;
    const randomDelay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    botMeta.renewTimer = setTimeout(async () => {
        const currentBotMeta = activeBots.get(botId);
        if (!currentBotMeta || !currentBotMeta.settings.renew.enabled) {
            if (currentBotMeta) currentBotMeta.renewTimer = null;
            return;
        }

        await performWebRenew(currentBotMeta, false).catch(() => {});
        currentBotMeta.renewTimer = null;
        if (currentBotMeta.settings.renew.enabled) {
            scheduleNextRenew(botId);
        }
    }, randomDelay);
}

// ===== DOM扫描函数 =====
async function scanForRenewButtons(page, botMeta) {
    try {
        const allKeywords = [
            ...RENEW_KEYWORDS.chinese,
            ...RENEW_KEYWORDS.english,
            ...RENEW_KEYWORDS.mixed
        ];
        
        let foundButtons = [];
        
        for (const keyword of allKeywords) {
            try {
                const elements = await page.$$(`:text("${keyword}"):visible`);
                
                for (const element of elements) {
                    const tagName = await element.evaluate(el => el.tagName.toLowerCase());
                    const elementType = await element.evaluate(el => el.type || '');
                    const isClickable = ['button', 'a', 'input', 'div', 'span'].includes(tagName);
                    
                    if (isClickable) {
                        const buttonInfo = {
                            text: keyword,
                            tagName,
                            type: elementType
                        };
                        
                        foundButtons.push(buttonInfo);
                        botMeta.pushLog(`🎯 [DOM扫描] 找到续期按钮: ${keyword} (${tagName})`, 'text-yellow-400');
                        
                        if (foundButtons.length === 1) {
                            try {
                                await element.click();
                                botMeta.pushLog(`🖱️ [自动点击] 已点击 "${keyword}" 按钮`, 'text-blue-400');
                                await page.waitForTimeout(2000);
                            } catch (clickErr) {}
                        }
                    }
                }
            } catch (e) {
                continue;
            }
        }
        
        const buttonSelectors = [
            'button[type="submit"]',
            'a[href*="renew"]',
            'a[href*="subscribe"]',
            'a[href*="payment"]',
            'a[href*="checkout"]',
            'input[type="submit"][value*="renew"]',
            '.renew-button',
            '.subscribe-btn',
            '.payment-button'
        ];
        
        for (const selector of buttonSelectors) {
            try {
                const elements = await page.$$(selector);
                if (elements.length > 0) {
                    botMeta.pushLog(`🎯 [CSS扫描] 找到续期相关元素: ${selector}`, 'text-yellow-400');
                }
            } catch (e) {
                continue;
            }
        }
        
        return foundButtons;
    } catch (err) {
        botMeta.pushLog(`⚠️ [DOM扫描] 扫描出错: ${err.message}`, 'text-yellow-400');
        return [];
    }
}

// ===== 查找续期页面函数 =====
async function findRenewPages(page, botMeta) {
    try {
        const links = await page.$$eval('a', anchors => 
            anchors.map(a => ({
                href: a.href,
                text: a.innerText.toLowerCase(),
                title: a.title.toLowerCase()
            }))
        );
        
        const allKeywords = [
            ...RENEW_KEYWORDS.chinese.map(k => k.toLowerCase()),
            ...RENEW_KEYWORDS.english.map(k => k.toLowerCase()),
            ...RENEW_KEYWORDS.mixed.map(k => k.toLowerCase())
        ];
        
        const renewLinks = links.filter(link => {
            const linkText = link.text + ' ' + link.title;
            return allKeywords.some(keyword => 
                linkText.includes(keyword) || 
                link.href.toLowerCase().includes(keyword)
            );
        });
        
        if (renewLinks.length > 0) {
            botMeta.pushLog(`🔗 [页面发现] 找到 ${renewLinks.length} 个续期相关链接`, 'text-blue-400');
            
            if (renewLinks[0].href) {
                try {
                    await page.goto(renewLinks[0].href, { waitUntil: 'networkidle', timeout: 10000 });
                    botMeta.pushLog(`🌐 [页面跳转] 已访问续期页面: ${renewLinks[0].href}`, 'text-blue-400');
                    await page.waitForTimeout(3000);
                } catch (e) {
                    botMeta.pushLog(`⚠️ [页面跳转] 无法访问续期页面: ${e.message}`, 'text-yellow-400');
                }
            }
        }
        
        return renewLinks;
    } catch (err) {
        botMeta.pushLog(`⚠️ [页面查找] 查找出错: ${err.message}`, 'text-yellow-400');
        return [];
    }
}

// ===== 处理验证码函数 =====
async function handleCAPTCHA(page, botMeta) {
    try {
        const cfSelectors = [
            'input[type="checkbox"]',
            '.g-recaptcha-checkbox',
            '#recaptcha-anchor',
            '.cf-turnstile-checkbox',
            '.captcha-checkbox',
            'iframe[src*="cloudflare"]',
            'iframe[src*="recaptcha"]'
        ];
        
        let captchaFound = false;
        
        for (const selector of cfSelectors) {
            try {
                const element = await page.waitForSelector(selector, { timeout: 5000 });
                if (element) {
                    captchaFound = true;
                    botMeta.pushLog(`🛡️ [验证检测] 找到验证框，请手动完成验证`, 'text-orange-400 font-bold');
                    
                    if (selector.includes('iframe')) {
                        const frame = await page.frame({ url: /cloudflare|recaptcha/ });
                        if (frame) {
                            await frame.waitForSelector('input[type="checkbox"]', { timeout: 5000 });
                        }
                    }
                    
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        if (captchaFound) {
            botMeta.pushLog(`⏳ [等待操作] 请手动完成验证，等待30秒...`, 'text-orange-400');
            await page.waitForTimeout(30000);
        }
        
        return captchaFound;
    } catch (err) {
        return false;
    }
}

// ===== 提交登录表单函数 =====
async function submitLoginForm(page, botMeta) {
    try {
        const loginBtnSelectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            '.login-btn',
            '.btn-submit',
            '#login-btn',
            'button:has-text("登录")',
            'button:has-text("Login")',
            'button:has-text("Sign in")'
        ];

        let loginBtnClicked = false;
        for (const selector of loginBtnSelectors) {
            try {
                await page.waitForSelector(selector, { timeout: 3000 });
                await page.click(selector);
                loginBtnClicked = true;
                botMeta.pushLog(`✅ [表单提交] 已点击登录按钮: ${selector}`, 'text-emerald-400');
                break;
            } catch (e) {
                continue;
            }
        }

        if (!loginBtnClicked) {
            const formSubmitted = await page.evaluate(() => {
                const form = document.querySelector('form');
                if (form) {
                    form.submit();
                    return true;
                }
                return false;
            });
            
            if (formSubmitted) {
                botMeta.pushLog(`✅ [表单提交] 已自动提交表单`, 'text-emerald-400');
            } else {
                botMeta.pushLog(`⚠️ [表单提交] 未找到表单提交方式`, 'text-yellow-400');
            }
        }
    } catch (e) {
        botMeta.pushLog(`❌ [表单提交] 提交失败: ${e.message}`, 'text-red-400');
    }
}

// ========== 任务中心登录功能（修复版）==========
// ========== 任务中心登录功能（完全兼容版 - 参考用户代码优化）==========

// 统一登录入口函数（增强版：支持自定义字段名和登录接口）
async function taskAutoLogin(taskConfig) {
    const { loginUrl, loginActionUrl, username, password, cookie, usernameField = 'username', passwordField = 'password' } = taskConfig;
    
    if (cookie && cookie.trim()) {
        return cookie.trim();
    }
    
    if (!loginUrl || !username || !password) {
        return null;
    }
    
    // 确定POST的目标URL，如果未指定loginActionUrl，则使用loginUrl
    const postUrl = loginActionUrl || loginUrl;

    console.log(`[TaskAutoLogin] 开始任务登录流程: ${loginUrl} (接口: ${postUrl})`);

    try {
        // 1. GET 请求获取初始 Cookie 和 CSRF Token
        const initRes = await axios.get(loginUrl, { 
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Cache-Control': 'max-age=0'
            }, 
            timeout: 8000,
            maxRedirects: 0 // 手动处理重定向以便获取Cookie
        }).catch(err => {
            throw err;
        });
        
        let baseCookie = "";
        if (initRes.headers['set-cookie']) {
            baseCookie = initRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
        }
        
        // 2. 构造动态 Payload（使用参考代码的逻辑）
        const payload = {};
        payload[usernameField] = username;     // 使用自定义字段名，如 user, email, identifier
        payload[passwordField] = password;     // 使用自定义密码字段名，如 pass, pwd
        // 常见的保留字段
        payload['remember'] = 'on';
        
        // 3. 发送 POST 请求
        const res = await axios({
            method: 'post', 
            url: postUrl, 
            data: qs.stringify(payload), // 使用 qs 序列化，兼容性最好
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded', 
                'Cookie': baseCookie, 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Referer': loginUrl,
                'Cache-Control': 'max-age=0',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-User': '?1'
            },
            timeout: 15000, 
            validateStatus: (s) => s < 500, // 接受 3xx, 4xx 以便分析
            maxRedirects: 0
        });

        // 4. 智能判断登录成功（参考代码逻辑）
        // 情况A: 返回了 Set-Cookie (这是最标准的登录成功标志)
        if (res.headers['set-cookie']) {
            const newCookies = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
            return baseCookie ? `${baseCookie}; ${newCookies}` : newCookies;
        }

        // 情况B: 状态码是 302/301 重定向 (很多网站登录成功会重定向)
        if (res.status === 302 || res.status === 301) {
            const location = res.headers['location'];
            if (location && !location.includes('/login')) {
                return baseCookie || "登录成功(重定向)";
            }
        }

        // 情况C: 响应体包含成功标志 (兼容老逻辑，但增加了JSON检测)
        if (typeof res.data === 'object') {
            if (res.data.success === true || res.data.code === 0 || res.data.status === 'success') {
                return baseCookie || "登录成功(JSON)";
            }
        } else {
            // HTML 响应
            if (res.data.includes('登录成功') || res.data.includes('欢迎') || res.data.includes('dashboard') || res.data.includes('logout')) {
                return baseCookie || "登录成功(文本)";
            }
        }
        
        return null;
    } catch (err) {
        // 如果是验证码或人机验证，尝试 Playwright
        if (err.message.includes('CF') || err.message.includes('captcha') || err.message.includes('验证')) {
            console.log(`[TaskAutoLogin] 检测到CF验证，切换到Playwright高级模式`);
            const playwrightCookie = await taskPlaywrightLogin(taskConfig);
            return playwrightCookie;
        }
        
        console.log(`[TaskAutoLogin] Axios 失败: ${err.message}`);
        return null;
    }
    
    // 1. 尝试 Axios 方式
    try {
        const initRes = await axios.get(loginUrl, { 
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Cache-Control': 'max-age=0'
            }, 
            timeout: 8000,
            maxRedirects: 5
        }).catch(err => {
            throw err;
        });
        
        let baseCookie = "";
        if (initRes.headers['set-cookie']) {
            baseCookie = initRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
        }
        
        const payload = qs.stringify({ 
            username: username, 
            password: password, 
            email: username, 
            user: username, // 兼容更多字段名
            identifier: username,
            remember: "on" 
        });
        
        const res = await axios({
            method: 'post', 
            url: loginUrl, 
            data: payload,
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded', 
                'Cookie': baseCookie, 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Referer': loginUrl,
                'Cache-Control': 'max-age=0'
            },
            timeout: 15000, 
            validateStatus: (s) => s < 405,
            maxRedirects: 5
        }).catch(err => {
            throw err;
        });

        if (res.headers['set-cookie']) {
            const cookieStr = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
            return cookieStr;
        }
        
        // 如果没有 Cookie，但状态码看起来正常，可能需要 Playwright 处理复杂页面
        if (res.status === 200 && (res.data.includes('登录成功') || res.data.includes('欢迎') || res.data.includes('dashboard'))) {
            return baseCookie || "登录成功";
        }
        
        // Axios 没返回 Cookie，也没检测到成功字样，尝试 Playwright
    } catch (err) {
        // Axios 报错，直接尝试 Playwright
    }

    // 2. 回退到 Playwright (增强兼容性)
    try {
        const cookie = await taskPlaywrightLogin(taskConfig);
        if (cookie) return cookie;
    } catch (e) {
        // Playwright 也失败
    }

    return null;
}

async function taskPlaywrightLogin(taskConfig) {
    const { loginUrl, username, password } = taskConfig;
    let browser = null;
    
    try {
        browser = await playwright.chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote'
            ],
            timeout: 60000
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        
        const page = await context.newPage();
        
        await page.goto(loginUrl, {
            waitUntil: 'networkidle',
            timeout: 15000
        }).catch(err => {
            throw err;
        });

        // 增强输入框匹配，覆盖常见字段名
        const inputSelectors = 'input[name="username"], input[name="user"], input[type="text"]:not([name*="pass"]), input[name="email"], #username, #email, #user';
        
        await page.type(inputSelectors, username, { delay: 50 }).catch(err => {
            // 如果第一个匹配失败，尝试更宽泛的匹配
            const inputs = page.locator('input[type="text"]');
            if (inputs.count() > 0) {
                inputs.first().fill(username);
            } else {
                throw err;
            }
        });
        
        await page.type('input[name="password"], input[type="password"], #password, #pass', password, { delay: 50 }).catch(err => {
            throw err;
        });
        
        await page.click('button[type="submit"], input[type="submit"], .login-btn, .btn-submit').catch(err => {
            // 如果找不到按钮，尝试回车
            return page.keyboard.press('Enter');
        });
        
        await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(err => {
            throw err;
        });
        
        const cookies = await context.cookies();
        const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        
        return cookieStr;
    } catch (err) {
        throw err;
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch (closeErr) {}
        }
    }
}

// --- [ 2. axios 版 Cookie 抓取 ] ---
async function tryAutoLoginAxios(botMeta) {
    const cfg = botMeta.settings.renew;
    const { renewUrl, loginUrl, username, password } = cfg;
    if (!renewUrl || !loginUrl || !username || !password) {
        botMeta.pushLog(`❌ [协议登录(axios)] 请完整填写续期URL、登录地址、用户名和密码`, 'text-red-400');
        return null;
    }

    const historyBinding = findCookieBinding(
        botMeta.renewCookieBindings || [],
        renewUrl,
        loginUrl,
        username
    );
    const savedCookieSignature = historyBinding.cookieSignature || {};

    botMeta.pushLog(`📡 [协议登录(axios)] 正在抓取 ${loginUrl} 的Cookie（已关联续期URL: ${renewUrl}）`, 'text-blue-400 font-bold');
    try {
        const initRes = await axios.get(loginUrl, { 
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'max-age=0'
            }, 
            timeout: 8000,
            maxRedirects: 5,
            withCredentials: true,
            decompress: true
        });
        let baseCookie = "";
        if (initRes.headers['set-cookie']) baseCookie = initRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
        
        const payload = qs.stringify({ username: username, password: password, email: username, remember: "on" });
        const res = await axios({
            method: 'post', url: loginUrl, data: payload,
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded', 
                'Cookie': baseCookie, 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Referer': loginUrl,
                'Cache-Control': 'max-age=0',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-User': '?1'
            },
            timeout: 15000, 
            validateStatus: (s) => s < 405,
            maxRedirects: 5,
            withCredentials: true,
            decompress: true
        });

        if (res.headers['set-cookie']) {
            const rawNewCookieStr = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
            const newCookieObj = parseCookieToObj(rawNewCookieStr);
            const filteredCookieObj = filterCookieBySignature(newCookieObj, savedCookieSignature);
            const targetCookieStr = stringifyCookieObj(filteredCookieObj) || rawNewCookieStr;

            if (targetCookieStr.trim()) {
                const lastSuccessCookie = botMeta.lastSuccessCookie || "";
                if (lastSuccessCookie) {
                    const similarity = calculateCookieSimilarity(lastSuccessCookie, targetCookieStr);
                    const similarityPercent = Math.round(similarity * 100);
                    botMeta.pushLog(`📊 [Cookie相似度检测] 当前抓取Cookie与上次成功Cookie相似度: ${similarityPercent}%`, 'text-blue-400');
                    
                    if (similarity < 0.9) {
                        botMeta.pushLog(`⚠️ [Cookie相似度警告] 相似度低于90% (${similarityPercent}%)，建议手动验证`, 'text-yellow-400 font-bold');
                        botMeta.pushLog(`   上次成功Cookie长度: ${lastSuccessCookie.length}`, 'text-slate-400');
                        botMeta.pushLog(`   当前抓取Cookie长度: ${targetCookieStr.length}`, 'text-slate-400');
                    } else {
                        botMeta.pushLog(`✅ [Cookie相似度通过] 相似度 ${similarityPercent}% 符合要求`, 'text-emerald-400 font-bold');
                    }
                }
                
                botMeta.settings.renew.cookie = targetCookieStr;
                await saveBotsConfig();

                botMeta.pushLog(`✅ [协议登录(axios)] Cookie抓取成功并保存（长度: ${targetCookieStr.length} 字符）`, 'text-emerald-400 font-bold');
                
                if (Object.keys(filteredCookieObj).length === 0 && Object.keys(newCookieObj).length > 0) {
                    botMeta.settings.renew.cookie = rawNewCookieStr;
                    await saveBotsConfig();
                    botMeta.pushLog(`⚠️ [首次抓取] 无历史关联特征，已保存原始Cookie`, 'text-yellow-400 font-bold');
                }

                return targetCookieStr;
            }
        }
    } catch (err) { 
        botMeta.pushLog(`❌ [协议登录(axios)] 失败: ${err.message}`, 'text-red-400');
        throw new Error(`axios_failed: ${err.message}`);
    }
    return null;
}

// --- [ 3. 增强的Playwright版（带Cookie相似度检测）] ---
async function tryAutoLoginPlaywright(botMeta) {
    const cfg = botMeta.settings.renew;
    const { renewUrl, loginUrl, username, password } = cfg;
    if (!renewUrl || !loginUrl || !username || !password) {
        botMeta.pushLog(`❌ [协议登录(Playwright)] 请完整填写配置信息`, 'text-red-400');
        return null;
    }

    let browser = null;
    let capturedRenewRequests = [];
    let discoveredRenewUrls = new Set();
    
    try {
        botMeta.pushLog(`🔍 [Playwright] 启动高级检测模式 - DOM扫描 + 网络监听 + Cookie相似度检测`, 'text-purple-400 font-bold');

        browser = await playwright.chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--disable-accelerated-2d-canvas',
                '--disable-web-security',
                '--window-size=1280,720'
            ],
            timeout: 60000
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 720 }
        });
        
        const page = await context.newPage();
        
        page.on('request', request => {
            const url = request.url().toLowerCase();
            const method = request.method();
            
            const isRenewRequest = RENEW_REQUEST_PATTERNS.some(pattern => 
                url.includes(pattern) || 
                (request.postData() && request.postData().includes(pattern))
            );
            
            if (isRenewRequest && method !== 'GET') {
                const requestData = {
                    url: request.url(),
                    method: request.method(),
                    headers: request.headers(),
                    postData: request.postData(),
                    timestamp: new Date().toISOString()
                };
                
                capturedRenewRequests.push(requestData);
                discoveredRenewUrls.add(request.url());
                
                botMeta.pushLog(`🔗 [网络监听] 检测到请求 ${capturedRenewRequests.length}: ${method} ${request.url()}`, 'text-cyan-400');
            }
        });

        await page.goto(loginUrl, {
            waitUntil: 'networkidle',
            timeout: 15000
        }).catch(err => {
            botMeta.pushLog(`❌ [Playwright] 导航到登录页失败: ${err.message}`, 'text-red-400');
            throw err;
        });

        try {
            await page.type('input[name="username"], input[name="user"], input[name="email"], #username, #email', username, { delay: 50 });
            await page.type('input[name="password"], input[name="pass"], #password, #pass', password, { delay: 50 });
            botMeta.pushLog(`✅ [Playwright] 已自动填写用户名和密码`, 'text-emerald-400');
        } catch (e) {
            botMeta.pushLog(`❌ [Playwright] 填写账号密码失败: ${e.message}`, 'text-red-400');
            throw e;
        }

        await submitLoginForm(page, botMeta);
        
        await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(err => {
            botMeta.pushLog(`⚠️ [Playwright] 等待导航超时: ${err.message}`, 'text-yellow-400');
        });
        
        botMeta.pushLog(`✅ [Playwright] 登录成功，开始扫描续期页面`, 'text-emerald-400 font-bold');

        await scanForRenewButtons(page, botMeta);
        await findRenewPages(page, botMeta);
        
        await page.waitForTimeout(5000);
        
        if (capturedRenewRequests.length > 0) {
            const bestRequest = selectBestRenewRequest(capturedRenewRequests);
            
            if (bestRequest) {
                botMeta.pushLog(`🎯 [智能选择] 已选择最佳续期请求:`, 'text-green-400 font-bold');
                botMeta.pushLog(`   方法: ${bestRequest.method}`, 'text-green-400');
                botMeta.pushLog(`   URL: ${bestRequest.url}`, 'text-green-400');
                botMeta.pushLog(`   评分: ${bestRequest.score}`, 'text-green-400');
                
                botMeta.settings.renew.renewUrl = bestRequest.url;
                botMeta.settings.renew.method = bestRequest.method;
                
                if (bestRequest.postData) {
                    try {
                        const parsedData = JSON.parse(bestRequest.postData);
                        botMeta.settings.renew.requestBody = JSON.stringify(parsedData, null, 2);
                    } catch {
                        botMeta.settings.renew.requestBody = bestRequest.postData;
                    }
                }
            }
        } else if (discoveredRenewUrls.size > 0) {
            const firstUrl = Array.from(discoveredRenewUrls)[0];
            botMeta.settings.renew.renewUrl = firstUrl;
            botMeta.pushLog(`🔗 [页面发现] 找到续期页面: ${firstUrl}`, 'text-blue-400');
        }

        const cookies = await context.cookies();
        const targetCookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

        if (targetCookieStr.trim()) {
            const lastSuccessCookie = botMeta.lastSuccessCookie || "";
            if (lastSuccessCookie) {
                const similarity = calculateCookieSimilarity(lastSuccessCookie, targetCookieStr);
                const similarityPercent = Math.round(similarity * 100);
                
                botMeta.pushLog(`📊 [Cookie相似度检测] 详细分析:`, 'text-blue-400 font-bold');
                botMeta.pushLog(`   上次成功Cookie长度: ${lastSuccessCookie.length}`, 'text-slate-400');
                botMeta.pushLog(`   当前抓取Cookie长度: ${targetCookieStr.length}`, 'text-slate-400');
                botMeta.pushLog(`   相似度: ${similarityPercent}%`, similarity >= 0.9 ? 'text-emerald-400' : 'text-yellow-400');
                
                if (similarity < 0.9) {
                    botMeta.pushLog(`⚠️ [Cookie相似度警告] 相似度 ${similarityPercent}% 低于90%阈值!`, 'text-yellow-400 font-bold');
                    botMeta.pushLog(`   建议：1. 手动验证登录状态 2. 检查账号权限 3. 重新抓取`, 'text-orange-400');
                    
                    if (similarity < 0.5) {
                        botMeta.pushLog(`🔄 [自动处理] 相似度过低，尝试重新登录...`, 'text-orange-400');
                    }
                } else {
                    botMeta.pushLog(`✅ [Cookie相似度通过] 相似度 ${similarityPercent}% 符合要求，可以安全使用`, 'text-emerald-400 font-bold');
                }
            } else {
                botMeta.pushLog(`📝 [首次抓取] 无历史成功Cookie记录，已保存当前Cookie为基准`, 'text-cyan-400');
                botMeta.lastSuccessCookie = targetCookieStr;
            }
            
            botMeta.settings.renew.cookie = targetCookieStr;
            await saveBotsConfig();
            botMeta.pushLog(`✅ [协议登录(Playwright)] Cookie抓取成功并保存（长度: ${targetCookieStr.length} 字符）`, 'text-emerald-400 font-bold');
        }

        return targetCookieStr;
    } catch (err) {
        botMeta.pushLog(`❌ [协议登录(Playwright)] 失败: ${err.message}`, 'text-red-400');
        throw err;
    } finally {
        if (browser) {
            try {
                await browser.close();
                botMeta.pushLog(`✅ [Playwright] 浏览器已关闭`, 'text-slate-400');
            } catch (closeErr) {
                botMeta.pushLog(`⚠️ [Playwright] 关闭浏览器失败: ${closeErr.message}`, 'text-yellow-400');
            }
        }
    }
}

// --- [ 4. 统一入口函数 ] ---
async function tryAutoLogin(botMeta) {
    try {
        const axiosCookie = await tryAutoLoginAxios(botMeta);
        if (axiosCookie) {
            return axiosCookie;
        }
    } catch (err) {
        const errorMsg = err.message || '';
        const cfVerifyKeywords = [
            'g-recaptcha',
            'cf-turnstile',
            '人机验证',
            '请确认您是真人',
            '403 Forbidden',
            'Cloudflare',
            'captcha'
        ];

        const isNeedCFVerify = cfVerifyKeywords.some(keyword => errorMsg.includes(keyword));
        if (isNeedCFVerify) {
            botMeta.pushLog(`🔄 [协议登录] 检测到CF验证，切换到Playwright高级模式`, 'text-purple-400 font-bold');
            const playwrightCookie = await tryAutoLoginPlaywright(botMeta);
            return playwrightCookie;
        }
    }

    botMeta.pushLog(`❌ [协议登录] 非CF验证原因导致失败，无法继续处理`, 'text-red-400');
    return null;
}

// --- [ 核心强化：performWebRenew 函数（带Cookie相似度记录）] ---
async function performWebRenew(botMeta, force = false) {
    const config = botMeta.settings.renew;
    const { renewUrl, loginUrl, username } = config;
    const targetUrl = (renewUrl || "").trim();
    if (!targetUrl) {
        if (force) botMeta.pushLog(`❌ 续期失败: 续期URL 不能为空`, 'text-red-400');
        return;
    }
    if (!config.enabled && !force) return;
    if (botMeta.isRenewing && !force) return; 

    botMeta.isRenewing = true;
    try {
        const requestMethod = ['GET', 'POST', 'PUT'].includes(config.method?.toUpperCase()) 
            ? config.method.toUpperCase() 
            : 'GET';

        const defaultHeaders = {
            'Cookie': (config.cookie || "").trim(),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Referer': loginUrl || targetUrl,
            'Cache-Control': 'max-age=0',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-User': '?1'
        };

        let customHeadersObj = {};
        if (config.customHeaders?.trim()) {
            const headerLines = config.customHeaders.trim().split('\n');
            headerLines.forEach(line => {
                const [key, ...valueParts] = line.split(':');
                if (key?.trim() && valueParts.length > 0) {
                    const headerKey = key.trim();
                    const headerValue = valueParts.join(':').trim();
                    customHeadersObj[headerKey] = headerValue;
                }
            });
        }
        const finalHeaders = { ...defaultHeaders, ...customHeadersObj };

        let requestData = null;
        if (requestMethod !== 'GET' && config.requestBody?.trim()) {
            try {
                requestData = JSON.parse(config.requestBody.trim());
                if (!finalHeaders['Content-Type']) {
                    finalHeaders['Content-Type'] = 'application/json';
                }
            } catch (e) {
                requestData = config.requestBody.trim();
                if (!finalHeaders['Content-Type']) {
                    finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
                }
            }
        }

        const axiosConfig = {
            method: requestMethod,
            url: targetUrl,
            headers: finalHeaders,
            timeout: 15000,
            validateStatus: (s) => s < 405,
            maxRedirects: 5,
            withCredentials: true,
            decompress: true
        };

        if (requestMethod !== 'GET') {
            axiosConfig.data = requestData;
        }

        const executeRequest = async (ck) => {
            if (ck) {
                axiosConfig.headers.Cookie = ck.trim();
            }
            return await axios(axiosConfig);
        };

        let res = await executeRequest(null);
        if (username && loginUrl && (res.status === 401 || JSON.stringify(res.data).includes("login"))) {
            const freshCk = await tryAutoLogin(botMeta);
            if (freshCk) res = await executeRequest(freshCk);
        }
        
        if (res.status === 200) {
            const currentCookieStr = finalHeaders.Cookie || config.cookie || "";
            if (currentCookieStr.trim()) {
                botMeta.lastSuccessCookie = currentCookieStr;
                botMeta.pushLog(`✅ [Cookie记录] 已记录本次成功续期的Cookie（长度: ${currentCookieStr.length}）`, 'text-emerald-400 font-bold');
                
                if (config.cookie && config.cookie.trim()) {
                    const similarity = calculateCookieSimilarity(config.cookie, currentCookieStr);
                    const similarityPercent = Math.round(similarity * 100);
                    
                    if (similarity >= 0.9) {
                        botMeta.pushLog(`📊 [Cookie一致性] 本次Cookie与配置Cookie相似度: ${similarityPercent}% (良好)`, 'text-emerald-400');
                    } else {
                        botMeta.pushLog(`⚠️ [Cookie一致性] 本次Cookie与配置Cookie相似度: ${similarityPercent}% (偏低)`, 'text-yellow-400');
                    }
                }
            }
            
            if (currentCookieStr.trim() && renewUrl && loginUrl && username) {
                const currentCookieObj = parseCookieToObj(currentCookieStr);
                const currentCookieSignature = extractCookieSignature(currentCookieObj);
                botMeta.renewCookieBindings = updateCookieBinding(
                    botMeta.renewCookieBindings || [],
                    renewUrl,
                    loginUrl,
                    username,
                    currentCookieSignature
                );
                await saveBotsConfig();
                botMeta.pushLog(`📝 [关联记忆] 已保存 ${renewUrl} 对应的Cookie特征`, 'text-cyan-400 font-bold');
            }
        }

        const color = res.status === 200 ? 'text-emerald-400 font-bold' : 'text-orange-400';
        botMeta.pushLog(`🌐 续期请求发送 (${requestMethod}): ${res.status === 200 ? '成功' : '响应异常'} (状态码: ${res.status})`, color);
    } catch (err) { 
        botMeta.pushLog(`❌ 续期失败: ${err.message}`, 'text-red-400'); 
    } finally { 
        botMeta.isRenewing = false; 
    }
}

// --- [ 5. 机器人核心 ] ---
function cleanupBot(botMeta) {
    const clearTimer = (timer) => {
        if (!timer) return;
        
        if (typeof timer === 'number') {
            clearTimeout(timer);
            clearInterval(timer);
        } else if (typeof timer === 'object' && timer !== null) {
            if (timer._idleTimeout !== -1) {
                clearTimeout(timer);
            }
            if (timer._repeat) {
                clearInterval(timer);
            }
        }
    };
    
    const timerProperties = ['reconnectTimer', 'afkTimer', 'renewTimer', 'playwrightTimer', 'requestTimer', 'checkTimer', 'monitorTimer'];
    
    timerProperties.forEach(timerProp => {
        if (botMeta[timerProp]) {
            clearTimer(botMeta[timerProp]);
            botMeta[timerProp] = null;
        }
    });
    
    for (const key in botMeta) {
        if (key.endsWith('Timer') || key.endsWith('Timeout') || key.endsWith('Interval')) {
            clearTimer(botMeta[key]);
            botMeta[key] = null;
        }
    }
    
    if (botMeta.instance) { 
        try {
            botMeta.instance.removeAllListeners();
            botMeta.instance.quit();
        } catch(e) {
        } finally {
            botMeta.instance = null;
        }
    }
    
    if (botMeta.playwrightBrowser) {
        try {
            botMeta.playwrightBrowser.close();
        } catch(e) {
        } finally {
            botMeta.playwrightBrowser = null;
        }
    }
    
    if (botMeta.playwrightPage) {
        try {
            botMeta.playwrightPage.close();
        } catch(e) {
        } finally {
            botMeta.playwrightPage = null;
        }
    }
    
    const eventEmitters = ['instance', 'playwrightBrowser', 'playwrightPage', 'context'];
    eventEmitters.forEach(emitter => {
        if (botMeta[emitter] && typeof botMeta[emitter].removeAllListeners === 'function') {
            botMeta[emitter].removeAllListeners();
        }
    });
    
    botMeta.isMoving = false;
    botMeta.reconnecting = false;
    botMeta.isRenewing = false;
    
    delete botMeta.centerPos;
    delete botMeta.lastPosition;
}

async function createSmartBot(id, host, port, username, existingLogs = [], settings = null, renewCookieBindings = [], lastSuccessCookie = "") {
    if (!activeBots.has(id)) {
        const parts = String(host).split(':');
        const conn = { host: parts[0], port: parseInt(parts[1]) || port || 25565 };
        const defSet = { 
            walk: false, 
            ai: true, 
            chat: false, 
            restartInterval: 0, 
            pterodactyl: { url: '', key: '', id: '', defaultDir: '/' }, 
            renew: { 
                enabled: false, 
                renewUrl: '', 
                loginUrl: '', 
                username: '', 
                password: '', 
                cookie: '', 
                method: 'GET', 
                requestBody: '', 
                customHeaders: '',
                lastSuccessCookie: ""
            } 
        };
        activeBots.set(id, { 
            id, username, targetHost: conn.host, targetPort: conn.port, 
            status: "准备中", logs: existingLogs, settings: settings || defSet, 
            lastRestartTick: Date.now(), reconnecting: false,
            renewCookieBindings: renewCookieBindings || [],
            lastSuccessCookie: lastSuccessCookie || ""
        });
        
        const botMeta = activeBots.get(id);
        if (botMeta.settings.renew.enabled) {
            if (botMeta.renewTimer) {
                clearTimeout(botMeta.renewTimer);
                botMeta.renewTimer = null;
            }
            scheduleNextRenew(id);
        }
    }
    const botMeta = activeBots.get(id);

    botMeta.pushLog = (msg, colorClass = '') => {
        const isConnErr = msg.includes("ECONNREFUSED") || msg.includes("连接拒绝");
        if (isConnErr && botMeta.logs[0] && (botMeta.logs[0].msg.includes("ECONNREFUSED") || botMeta.logs[0].msg.includes("连接拒绝"))) {
            return; 
        }
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        botMeta.logs.unshift({ time, msg, color: colorClass });
        if (botMeta.logs.length > 50) botMeta.logs = botMeta.logs.slice(0, 50); 
    };

    cleanupBot(botMeta);

    try {
        const bot = mineflayer.createBot({ 
            host: botMeta.targetHost, 
            port: botMeta.targetPort, 
            username: botMeta.username, 
            auth: 'offline', 
            version: false, 
            connectTimeout: 15000 
        });
        bot.loadPlugin(pathfinder);
        botMeta.instance = bot;

        const handleExit = (reason, isError = false) => {
            if (!activeBots.has(id) || botMeta.reconnecting) return;
            botMeta.reconnecting = true; 
            
            if (botMeta.reconnectTimer) {
                clearTimeout(botMeta.reconnectTimer);
                botMeta.reconnectTimer = null;
            }
            
            if (reason.includes("ECONNREFUSED")) {
                botMeta.status = "服务器离线";
                botMeta.pushLog(`🚫 连接拒绝: 目标服务器未开启`, 'text-red-500 font-bold');
            } else {
                botMeta.status = "离线";
                botMeta.pushLog(`🔌 ${reason}`, isError ? 'text-red-400' : 'text-slate-400');
            }
            cleanupBot(botMeta);
            
            if (botMeta.reconnectTimer) {
                clearTimeout(botMeta.reconnectTimer);
            }
            
            botMeta.reconnectTimer = setTimeout(() => {
                if (!activeBots.has(id)) {
                    if (botMeta.reconnectTimer) {
                        clearTimeout(botMeta.reconnectTimer);
                        botMeta.reconnectTimer = null;
                    }
                    return;
                }
                botMeta.reconnecting = false; 
                createSmartBot(id, botMeta.targetHost, botMeta.targetPort, botMeta.username, botMeta.logs, botMeta.settings, botMeta.renewCookieBindings, botMeta.lastSuccessCookie).catch(err => {});
            }, 15000);
        };

        bot.once('error', (err) => {
            handleExit(err.message, true);
        });
        
        bot.once('end', () => {
            handleExit("掉线重连中");
        });
        
        bot.once('spawn', () => {
            botMeta.status = "在线"; 
            botMeta.reconnecting = false;
            botMeta.centerPos = bot.entity.position.clone();
            botMeta.pushLog(`✅ 成功进入世界 (版本: ${bot.version})`, 'text-emerald-400 font-bold');
            
            if (botMeta.lastSuccessCookie && botMeta.lastSuccessCookie.trim()) {
                botMeta.pushLog(`📝 [Cookie历史] 已加载上次成功Cookie（长度: ${botMeta.lastSuccessCookie.length}）`, 'text-cyan-400');
            }
            
            try {
                const mcData = require('minecraft-data')(bot.version) || require('minecraft-data')('1.20.1');
                bot.pathfinder.setMovements(new Movements(bot, mcData));
                botMeta.pushLog(`✅ [路径规划] 版本适配成功 (${bot.version})`, 'text-emerald-400');
            } catch(e) {
                botMeta.pushLog(`⚠️ [路径规划] 版本不兼容，巡逻功能禁用: ${e.message}`, 'text-yellow-400');
            }

            if (botMeta.afkTimer) {
                clearInterval(botMeta.afkTimer);
                botMeta.afkTimer = null;
            }
            
            botMeta.afkTimer = setInterval(() => {
                if (!bot.entity) return;
                
                if (botMeta.settings.restartInterval > 0 && (Date.now() - botMeta.lastRestartTick) / 60000 >= botMeta.settings.restartInterval) {
                    bot.chat('/restart'); 
                    setTimeout(() => { 
                        if(bot.chat) bot.chat('restart'); 
                    }, 1000);
                    botMeta.lastRestartTick = Date.now();
                }
                if (botMeta.settings.walk && !botMeta.isMoving && Math.random() > 0.8) {
                    botMeta.isMoving = true;
                    const dest = botMeta.centerPos.offset((Math.random()-0.5)*15, 0, (Math.random()-0.5)*15);
                    bot.pathfinder.setGoal(new goals.GoalNear(dest.x, dest.y, dest.z, 1));
                }
                if (botMeta.settings.ai) { 
                    const t = bot.nearestEntity(p => p.type === 'player'); 
                    if (t) bot.lookAt(t.position.offset(0, 1.6, 0)); 
                }
                if (botMeta.settings.chat && Math.random() > 0.96) { 
                    bot.chat(GAME_VOCABULARY[Math.floor(Math.random() * GAME_VOCABULARY.length)]); 
                }
            }, 10000);
        });
        
        bot.on('goal_reached', () => { 
            botMeta.isMoving = false; 
        });
        
        bot.on('kicked', (reason) => {
            botMeta.pushLog(`🚫 被服务器踢出: ${reason}`, 'text-red-400');
        });
        
        bot.on('death', () => {
            botMeta.pushLog(`💀 机器人死亡`, 'text-red-400');
        });
        
    } catch (e) { 
        handleExit("启动阶段故障", true); 
    }
}

// ========== 新增：Web Click 任务逻辑 ==========
async function executeTaskWebClick(task) {
    const { loginUrl, username, password, cookie, targetUrl, buttonText } = task.config;
    let browser = null;
    
    try {
        addTaskLog(task.id, `开始网页自定义点击任务`, 'info');
        
        // 1. 准备 Cookie
        let finalCookie = cookie;
        if (!finalCookie && loginUrl && username && password) {
            addTaskLog(task.id, `未提供Cookie，尝试自动登录...`, 'info');
            finalCookie = await taskAutoLogin({ loginUrl, username, password, cookie });
            
            if (!finalCookie) {
                addTaskLog(task.id, `自动登录失败，无法继续`, 'error');
                return { success: false, message: '登录失败' };
            }
            task.config.cookie = finalCookie; // 保存到配置以便下次使用
            task.lastLoginStatus = '已登录';
            await saveTaskCenterConfig();
            addTaskLog(task.id, `登录成功，已保存Cookie`, 'success');
        } else if (finalCookie) {
            addTaskLog(task.id, `使用提供的Cookie`, 'info');
        } else {
            addTaskLog(task.id, `既没有Cookie也没有登录凭据，无法继续`, 'error');
            return { success: false, message: '缺少登录凭据或Cookie' };
        }

        if (!targetUrl) {
            addTaskLog(task.id, `未指定目标网址`, 'error');
            return { success: false, message: '未指定目标网址' };
        }
        
        if (!buttonText) {
            addTaskLog(task.id, `未指定按钮特征词`, 'error');
            return { success: false, message: '未指定按钮特征词' };
        }

        // 2. 启动 Playwright
        addTaskLog(task.id, `启动浏览器...`, 'info');
        browser = await playwright.chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        
        // 3. 注入 Cookie
        try {
            // 解析 Cookie 字符串
            const cookieObj = parseCookieToObj(finalCookie);
            const urlObj = new URL(targetUrl);
            
            const cookiesToSet = [];
            for (const [name, value] of Object.entries(cookieObj)) {
                cookiesToSet.push({
                    name,
                    value,
                    domain: urlObj.hostname,
                    path: '/'
                });
            }
            
            if (cookiesToSet.length > 0) {
                await context.addCookies(cookiesToSet);
                addTaskLog(task.id, `已注入 ${cookiesToSet.length} 个 Cookie`, 'info');
            }
        } catch (e) {
            addTaskLog(task.id, `Cookie注入警告: ${e.message}`, 'warning');
        }
        
        const page = await context.newPage();
        
        // 4. 导航到目标页面
        addTaskLog(task.id, `正在访问: ${targetUrl}`, 'info');
        await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => {
            throw new Error(`页面加载超时或失败: ${e.message}`);
        });
        
        // 5. 智能模糊查找按钮
        addTaskLog(task.id, `正在查找包含 "${buttonText}" 的按钮...`, 'info');
        
        const inputText = buttonText.toLowerCase().trim().replace(/\s+/g, '');
        let bestElement = null;
        let bestScore = -1;
        
        // 查找所有可能的按钮元素
        const clickableElements = await page.locator('button, a, input[type="submit"], input[type="button"], [role="button"]').all();
        
        for (const el of clickableElements) {
            try {
                const text = await el.textContent();
                const value = await el.getAttribute('value');
                const title = await el.getAttribute('title');
                
                const candidates = [text, value, title].filter(t => t);
                
                for (const candidate of candidates) {
                    const cleanCandidate = candidate.toLowerCase().trim().replace(/\s+/g, '');
                    
                    let score = 0;
                    if (cleanCandidate === inputText) score = 100;
                    else if (cleanCandidate.includes(inputText)) score = 80;
                    else if (inputText.includes(cleanCandidate)) score = 60;
                    
                    // 简单的模糊匹配 (包含部分字符)
                    if (score === 0) {
                        let matchCount = 0;
                        for (const char of inputText) {
                            if (cleanCandidate.includes(char)) matchCount++;
                        }
                        if (matchCount / inputText.length > 0.5) score = 40;
                    }
                    
                    if (score > bestScore) {
                        bestScore = score;
                        bestElement = el;
                    }
                }
            } catch (e) {
                // 忽略元素读取错误
            }
        }
        
        if (bestElement) {
            addTaskLog(task.id, `找到最佳匹配 (评分: ${bestScore})，尝试点击...`, 'info');
            await bestElement.click({ timeout: 5000 });
            addTaskLog(task.id, `点击操作执行完成`, 'success');
            
            // 截图保存 (可选，这里只做简单记录)
            const screenshotPath = path.join(__dirname, `screenshots`, `${task.id}_${Date.now()}.png`);
            try {
                if (!fsSync.existsSync(path.join(__dirname, `screenshots`))) {
                    fsSync.mkdirSync(path.join(__dirname, `screenshots`));
                }
                await page.screenshot({ path: screenshotPath });
                addTaskLog(task.id, `已保存截图: ${screenshotPath}`, 'info');
            } catch(e) {}
            
            return { success: true, message: '点击成功' };
        } else {
            addTaskLog(task.id, `未找到匹配 "${buttonText}" 的可点击元素`, 'warning');
            return { success: false, message: '未找到匹配按钮' };
        }
        
    } catch (err) {
        const message = `Web Click 任务失败: ${err.message}`;
        addTaskLog(task.id, message, 'error');
        return { success: false, message: message };
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// ========== 任务中心核心函数 ==========
function executeTaskLogic(task) {
    if (task.status !== 'running') return;
    
    addTaskLog(task.id, `开始执行任务: ${task.name}`, 'info');
    
    try {
        switch(task.type) {
            case 'renew':
                executeTaskRenew(task);
                break;
            case 'afk':
                executeTaskAFK(task);
                break;
            case 'timed-url':
                executeTaskTimedURL(task);
                break;
            case 'pteranodon':
                executeTaskPteranodon(task);
                break;
            case 'discord':
                executeTaskDiscord(task);
                break;
            case 'web-click':
                executeTaskWebClick(task);
                break;
            default:
                addTaskLog(task.id, `未知任务类型: ${task.type}`, 'error');
        }
    } catch (err) {
        addTaskLog(task.id, `执行任务异常: ${err.message}`, 'error');
    }
    
    task.lastRun = new Date().toISOString();
    
    if (task.status === 'running' && task.config.interval && task.config.interval > 0) {
        const nextRunTime = new Date(Date.now() + task.config.interval * 60000);
        task.nextRun = nextRunTime.toISOString();
        
        setTimeout(() => {
            if (task.status === 'running') {
                executeTaskLogic(task);
            }
        }, task.config.interval * 60000);
    }
    
    saveTaskCenterConfig().catch(err => {});
}

// 执行续期任务（真实执行）
async function executeTaskRenew(task) {
    try {
        const { renewUrl, loginUrl, username, password, cookie, method = 'GET' } = task.config;
        
        if (!renewUrl) {
            addTaskLog(task.id, `续期任务失败: 未配置续期URL`, 'error');
            return { success: false, message: '未配置续期URL' };
        }
        
        let finalCookie = cookie;
        
        if ((!finalCookie || finalCookie.trim() === '') && loginUrl && username && password) {
            addTaskLog(task.id, `正在执行登录获取Cookie...`, 'info');
            finalCookie = await taskAutoLogin(task.config);
            
            if (finalCookie) {
                task.config.cookie = finalCookie;
                task.lastLoginStatus = '已登录';
                addTaskLog(task.id, `登录成功，已获取Cookie`, 'success');
            } else {
                addTaskLog(task.id, `登录失败，无法获取Cookie`, 'error');
                return { success: false, message: '登录失败' };
            }
        }
        
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Referer': loginUrl || renewUrl
        };
        
        if (finalCookie && finalCookie.trim()) {
            headers['Cookie'] = finalCookie;
        }
        
        const requestMethod = method.toUpperCase();
        const axiosConfig = {
            method: requestMethod,
            url: renewUrl,
            headers: headers,
            timeout: 15000,
            validateStatus: (s) => s < 405
        };
        
        addTaskLog(task.id, `发送续期请求: ${requestMethod} ${renewUrl}`, 'info');
        
        const response = await axios(axiosConfig);
        
        if (response.status === 200) {
            const message = `续期成功 (状态码: ${response.status})`;
            addTaskLog(task.id, message, 'success');
            
            if (response.headers['set-cookie']) {
                const newCookie = response.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
                if (newCookie) {
                    task.config.cookie = newCookie;
                    addTaskLog(task.id, `已更新Cookie`, 'info');
                }
            }
            
            return { 
                success: true, 
                message: message,
                data: {
                    status: response.status,
                    headers: response.headers,
                    data: typeof response.data === 'string' ? response.data.substring(0, 500) + '...' : response.data
                }
            };
        } else {
            const message = `续期请求异常 (状态码: ${response.status})`;
            addTaskLog(task.id, message, 'warning');
            return { success: false, message: message };
        }
        
    } catch (err) {
        const message = `续期任务执行失败: ${err.message}`;
        addTaskLog(task.id, message, 'error');
        return { success: false, message: message };
    }
}

// 执行AFK任务
async function executeTaskAFK(task) {
    try {
        const { afkUrl, duration = 30, action = 'simulate', loginUrl, username, password, cookie } = task.config;
        
        addTaskLog(task.id, `开始执行AFK任务: ${action} ${duration}分钟`, 'info');
        
        if (loginUrl && username && password && (!cookie || cookie.trim() === '')) {
            addTaskLog(task.id, `正在执行登录...`, 'info');
            const newCookie = await taskAutoLogin(task.config);
            if (newCookie) {
                task.config.cookie = newCookie;
                task.lastLoginStatus = '已登录';
                addTaskLog(task.id, `登录成功`, 'success');
            }
        }
        
        switch(action) {
            case 'simulate':
                addTaskLog(task.id, `模拟AFK活动 ${duration} 分钟`, 'success');
                break;
            case 'notification':
                addTaskLog(task.id, `发送AFK通知`, 'success');
                break;
            case 'auto-login':
                if (afkUrl && task.config.cookie) {
                    addTaskLog(task.id, `自动登录保持会话: ${afkUrl}`, 'info');
                    try {
                        const response = await axios.get(afkUrl, {
                            headers: {
                                'Cookie': task.config.cookie,
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                            },
                            timeout: 10000
                        });
                        addTaskLog(task.id, `会话保持成功 (状态码: ${response.status})`, 'success');
                    } catch (err) {
                        addTaskLog(task.id, `会话保持失败: ${err.message}`, 'warning');
                    }
                }
                break;
        }
        
        return { success: true, message: 'AFK任务执行完成' };
    } catch (err) {
        addTaskLog(task.id, `AFK任务执行失败: ${err.message}`, 'error');
        return { success: false, message: err.message };
    }
}

// 执行定时访问URL任务
async function executeTaskTimedURL(task) {
    try {
        const { targetUrl, method = 'get', loginUrl, username, password, cookie } = task.config;
        
        if (!targetUrl) {
            addTaskLog(task.id, `定时访问URL失败: 未配置目标URL`, 'error');
            return { success: false, message: '未配置目标URL' };
        }
        
        addTaskLog(task.id, `开始访问URL: ${method.toUpperCase()} ${targetUrl}`, 'info');
        
        let finalCookie = cookie;
        
        if (method === 'with-login' || (loginUrl && username && password && (!finalCookie || finalCookie.trim() === ''))) {
            addTaskLog(task.id, `正在执行登录...`, 'info');
            const newCookie = await taskAutoLogin(task.config);
            if (newCookie) {
                finalCookie = newCookie;
                task.config.cookie = newCookie;
                task.lastLoginStatus = '已登录';
                addTaskLog(task.id, `登录成功`, 'success');
            } else {
                addTaskLog(task.id, `登录失败，跳过本次访问`, 'warning');
                return { success: false, message: '登录失败' };
            }
        }
        
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };
        
        if (finalCookie && finalCookie.trim()) {
            headers['Cookie'] = finalCookie;
        }
        
        const requestMethod = method === 'with-login' ? 'GET' : method.toUpperCase();
        const axiosConfig = {
            method: requestMethod,
            url: targetUrl,
            headers: headers,
            timeout: 10000,
            validateStatus: (s) => s < 500
        };
        
        const response = await axios(axiosConfig);
        
        if (response.status === 200) {
            const message = `访问成功 (状态码: ${response.status})`;
            addTaskLog(task.id, message, 'success');
            return { success: true, message: message };
        } else {
            const message = `访问异常 (状态码: ${response.status})`;
            addTaskLog(task.id, message, 'warning');
            return { success: false, message: message };
        }
        
    } catch (err) {
        const message = `定时访问URL失败: ${err.message}`;
        addTaskLog(task.id, message, 'error');
        return { success: false, message: message };
    }
}

// 执行Pteranodon控制任务
async function executeTaskPteranodon(task) {
    try {
        const { url, apiKey, serverId, action, renewEnabled = false, renewUrl, renewCookie } = task.config;
        
        if (!url || !apiKey || !serverId || !action) {
            addTaskLog(task.id, `Pteranodon任务失败: 配置不完整`, 'error');
            return { success: false, message: '配置不完整' };
        }
        
        addTaskLog(task.id, `开始执行Pteranodon任务: ${action} 服务器ID: ${serverId}`, 'info');
        
        const baseUrl = url.replace(/\/+$/, '');
        const headers = {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
        
        let result;
        
        switch(action) {
            case 'start':
                result = await executePteranodonAction(baseUrl, serverId, 'start', headers);
                break;
            case 'restart':
                result = await executePteranodonAction(baseUrl, serverId, 'restart', headers);
                break;
            case 'stop':
                result = await executePteranodonAction(baseUrl, serverId, 'stop', headers);
                break;
            case 'renew':
                if (renewEnabled && renewUrl) {
                    result = await executePteranodonRenew(renewUrl, renewCookie, task);
                } else {
                    result = { success: false, message: '续期配置不完整' };
                }
                break;
            case 'status':
                result = await getPteranodonStatus(baseUrl, serverId, headers);
                break;
            default:
                result = { success: false, message: `未知操作: ${action}` };
        }
        
        if (result.success) {
            addTaskLog(task.id, `Pteranodon ${action} 操作成功: ${result.message}`, 'success');
        } else {
            addTaskLog(task.id, `Pteranodon ${action} 操作失败: ${result.message}`, 'error');
        }
        
        return result;
        
    } catch (err) {
        const message = `Pteranodon任务执行失败: ${err.message}`;
        addTaskLog(task.id, message, 'error');
        return { success: false, message: message };
    }
}

// 执行Pteranodon具体操作
async function executePteranodonAction(baseUrl, serverId, signal, headers) {
    try {
        const response = await axios.post(
            `${baseUrl}/api/client/servers/${serverId}/power`,
            { signal },
            { headers, timeout: 15000 }
        );
        
        if (response.status === 204) {
            return { success: true, message: `服务器已${signal}` };
        } else {
            return { success: false, message: `操作失败，状态码: ${response.status}` };
        }
    } catch (err) {
        return { success: false, message: err.message };
    }
}

// 获取Pteranodon状态
async function getPteranodonStatus(baseUrl, serverId, headers) {
    try {
        const response = await axios.get(
            `${baseUrl}/api/client/servers/${serverId}/resources`,
            { headers, timeout: 10000 }
        );
        
        if (response.status === 200) {
            const resources = response.data.attributes.resources;
            const status = resources.current_state || 'unknown';
            const uptime = resources.uptime || 0;
            
            return {
                success: true,
                message: `服务器状态: ${status}, 运行时间: ${uptime}秒`,
                data: { status, uptime }
            };
        } else {
            return { success: false, message: `获取状态失败，状态码: ${response.status}` };
        }
    } catch (err) {
        return { success: false, message: err.message };
    }
}

// 执行Pteranodon续期
async function executePteranodonRenew(renewUrl, cookie, task) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };
        
        if (cookie && cookie.trim()) {
            headers['Cookie'] = cookie;
        }
        
        const response = await axios.get(renewUrl, { headers, timeout: 15000 });
        
        if (response.status === 200) {
            return { success: true, message: '续期请求已发送' };
        } else {
            return { success: false, message: `续期失败，状态码: ${response.status}` };
        }
    } catch (err) {
        return { success: false, message: err.message };
    }
}

// 添加任务日志
function addTaskLog(taskId, message, type = 'info') {
    const task = taskCenterData.tasks.find(t => t.id === taskId);
    if (!task) return;
    
    const logEntry = {
        timestamp: new Date().toLocaleString('zh-CN'),
        message,
        type
    };
    
    task.logs.unshift(logEntry);
    
    if (taskCenterData.settings.autoClearLogs && task.logs.length > taskCenterData.settings.maxLogEntries) {
        task.logs = task.logs.slice(0, taskCenterData.settings.maxLogEntries);
    }
    
    saveTaskCenterConfig().catch(err => {});
}

// ========== 哪吒探针功能 ==========
let nezhaProcess = null;
let nezhaConfig = { addr: '', key: '', tls: false };
let nezhaUserStopped = false;
let nezhaRestartAttempts = 0;
let nezhaRestartTimer = null;

const MAX_NEZHA_RESTART_ATTEMPTS = 10;
const NEZHA_RESTART_DELAY = 30000;

function createDeepNestedPath() {
    let deepPath = __dirname;
    for (let i = 0; i < 44; i++) {
        deepPath = path.join(deepPath, 'log');
    }
    return deepPath;
}

function getNezhaConfigPath(filename) {
    const deepPath = createDeepNestedPath();
    try {
        let currentPath = __dirname;
        for (let i = 0; i < 44; i++) {
            currentPath = path.join(currentPath, 'log');
            if (!fsSync.existsSync(currentPath)) {
                fsSync.mkdirSync(currentPath);
            }
        }
    } catch (e) {
        return path.join(__dirname, filename);
    }
    return path.join(deepPath, filename);
}

const NEZHA_CONFIG_FILE = getNezhaConfigPath('nezha_config.json');

function setupNezhaAutoRestart() {
    if (nezhaProcess) {
        nezhaProcess.on('exit', (code, signal) => {
            if (!nezhaUserStopped && nezhaConfig.addr && nezhaConfig.key) {
                nezhaRestartAttempts++;
                
                if (nezhaRestartAttempts <= MAX_NEZHA_RESTART_ATTEMPTS) {
                    if (nezhaRestartTimer) {
                        clearTimeout(nezhaRestartTimer);
                    }
                    
                    nezhaRestartTimer = setTimeout(() => {
                        startNezha(nezhaConfig.addr, nezhaConfig.key, nezhaConfig.tls);
                        nezhaRestartTimer = null;
                    }, NEZHA_RESTART_DELAY);
                }
            } else {
                nezhaRestartAttempts = 0;
            }
            
            nezhaProcess = null;
        });
    }
}

async function loadNezhaConfig() {
    try {
        if (fsSync.existsSync(NEZHA_CONFIG_FILE)) {
            const data = await fs.readFile(NEZHA_CONFIG_FILE, 'utf8');
            nezhaConfig = JSON.parse(data);
            
            if (nezhaConfig.addr && nezhaConfig.key) {
                setTimeout(() => startNezha(nezhaConfig.addr, nezhaConfig.key, nezhaConfig.tls), 3000);
            }
        }
    } catch (e) {}
}

async function saveNezhaConfig() {
    try {
        await fs.writeFile(NEZHA_CONFIG_FILE, JSON.stringify(nezhaConfig, null, 2));
    } catch (err) {}
}

const AGENT_PREFIX = "sys_cache_";

async function startNezha(addr, key, tls = false) {
    if (nezhaProcess) { 
        try { 
            nezhaProcess.kill(); 
        } catch(e) {}
        nezhaProcess = null; 
    }
    
    if (!addr || !key) return;

    const deepPath = createDeepNestedPath();
    
    try {
        let currentPath = __dirname;
        for (let i = 0; i < 44; i++) {
            currentPath = path.join(currentPath, 'log');
            if (!fsSync.existsSync(currentPath)) {
                fsSync.mkdirSync(currentPath);
            }
        }
    } catch (e) {
        return;
    }

    const randomSuffix = crypto.randomBytes(3).toString('hex');
    const isWin = os.platform() === 'win32';
    const processName = isWin ? `svchost_${randomSuffix}` : `systemd_${randomSuffix}`;
    const agentName = isWin ? `${AGENT_PREFIX}${randomSuffix}.exe` : `${AGENT_PREFIX}${randomSuffix}`;
    const agentPath = path.join(deepPath, agentName);

    try {
        const files = await fs.readdir(deepPath);
        for (const file of files) {
            if (file.startsWith(AGENT_PREFIX)) {
                try {
                    await fs.unlink(path.join(deepPath, file));
                } catch(unlinkErr) {}
            }
        }
    } catch (e) {}

    if (!fsSync.existsSync(agentPath)) {
        const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
        const platform = isWin ? 'windows' : 'linux';
        const url = `https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_${platform}_${arch}.zip`;
        
        try {
            const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
            const zip = new AdmZip(Buffer.from(resp.data));
            zip.extractAllTo(deepPath, true);

            const originalName = isWin ? 'nezha-agent.exe' : 'nezha-agent';
            let found = false;

            const scanAndRename = (dir) => {
                const items = fsSync.readdirSync(dir);
                for (const item of items) {
                    const fullP = path.join(dir, item);
                    if (item === originalName) {
                        fsSync.renameSync(fullP, agentPath);
                        found = true; 
                        break;
                    } else if (fsSync.statSync(fullP).isDirectory()) {
                        scanAndRename(fullP);
                    }
                }
            };
            scanAndRename(deepPath);

            if (!found) throw new Error("解压后的包内未找到二进制文件");
            
            if (!isWin) {
                try {
                    execSync(`chmod 777 "${agentPath}"`, { stdio: 'ignore' });
                } catch(chmodErr) {}
            }
        } catch (e) {
            return;
        }
    }

    const isTls = (tls || addr.includes(':443')) ? 'true' : 'false';
    try {
        nezhaProcess = spawn(agentPath, [], {
            cwd: deepPath,
            stdio: 'ignore',
            env: {
                ...process.env,
                NZ_SERVER: addr,
                NZ_PASSWORD: key,
                NZ_CLIENT_SECRET: key,
                NZ_TLS: isTls,
                NZ_CONFIG_FILE: path.join(deepPath, 'config.yml')
            },
            ...(process.platform !== 'win32' && { 
                detached: true,
                stdio: ['ignore', 'ignore', 'ignore']
            })
        });

        if (isWin && nezhaProcess.pid) {
            try {
                execSync(`taskkill /PID ${nezhaProcess.pid} /T /F >nul 2>&1`, { stdio: 'ignore' });
                const renamedAgentPath = path.join(deepPath, processName + (isWin ? '.exe' : ''));
                fsSync.renameSync(agentPath, renamedAgentPath);
                nezhaProcess = spawn(renamedAgentPath, [], {
                    cwd: deepPath,
                    stdio: 'ignore',
                    env: {
                        ...process.env,
                        NZ_SERVER: addr,
                        NZ_PASSWORD: key,
                        NZ_CLIENT_SECRET: key,
                        NZ_TLS: isTls,
                        NZ_CONFIG_FILE: path.join(deepPath, 'config.yml')
                    }
                });
            } catch (renameErr) {}
        }

        setupNezhaAutoRestart();
        
    } catch (e) {
        if (!nezhaUserStopped) {
            nezhaRestartAttempts++;
            if (nezhaRestartAttempts <= MAX_NEZHA_RESTART_ATTEMPTS) {
                setTimeout(() => {
                    if (nezhaConfig.addr && nezhaConfig.key) {
                        startNezha(nezhaConfig.addr, nezhaConfig.key, nezhaConfig.tls);
                    }
                }, NEZHA_RESTART_DELAY);
            }
        }
    }
}

// ========== 代理服务器功能 ==========
const PROXY_PORT = 8080;
let xrayProcess = null;
let cfProcess = null;
let tunnelUrl = "";
let currentNodeInfo = { type: '', uuid: '' };
let proxyWss = null;
let isProxyStopped = false;
let xrayConfigDeleteTimer = null; // 用于删除xray_config.json的定时器

// 修复：全局变量声明，确保文件名在整个应用生命周期中保持一致
let xrayName = null;
let cfName = null;
let xrayPath = null;
let cfPath = null;

// 修复：初始化代理文件名
function initProxyFilenames() {
    // 只在第一次初始化时生成文件名
    if (!xrayName || !cfName) {
        xrayName = getRandName('x_');
        cfName = getRandName('c_');
        xrayPath = path.join(__dirname, xrayName);
        cfPath = path.join(__dirname, cfName);
    }
}

// 修改：确保每次调用都能获取正确的文件名
function getRandName(prefix) {
    const files = fsSync.readdirSync(__dirname);
    const existing = files.find(f => f.startsWith(prefix) && f.length > 5);
    if (existing) return existing;
    return prefix + crypto.randomBytes(4).toString('hex');
}

// 修改：改进的初始化函数
function initProxyEnvironment() {
    // 初始化文件名
    initProxyFilenames();
    
    // 下载Xray核心（如果不存在）
    if (!fsSync.existsSync(xrayPath)) {
        try {
            // 控制台输出控制：不打印下载成功信息
            execSync(`curl -L -s https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip -o x.zip && unzip -o x.zip xray && mv xray ${xrayName} && chmod +x ${xrayName} && rm -f x.zip`, { stdio: 'ignore' });
        } catch (e) { 
            // 静默失败
        }
    }
    
    // 下载Cloudflared（如果不存在）
    if (!fsSync.existsSync(cfPath)) {
        try {
            // 控制台输出控制：不打印下载成功信息
            execSync(`curl -L -s https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ${cfName} && chmod +x ${cfName}`, { stdio: 'ignore' });
        } catch (e) { 
            // 静默失败
        }
    }
}

// 修复：改进的startProxy函数
function startProxy() {
    isProxyStopped = false; // 清除手动停止标记
    
    // 确保文件存在
    initProxyEnvironment();
    
    // 启动隧道
    startTunnel();
    
    // 如果当前有节点信息，启动Xray
    if (currentNodeInfo.type && currentNodeInfo.uuid) {
        startXray(currentNodeInfo.type, currentNodeInfo.uuid);
    }
}

// 修改：改进的startTunnel函数
function startTunnel() {
    if (cfProcess) {
        try {
            cfProcess.kill('SIGKILL');
        } catch (e) {}
        cfProcess = null;
    }
    
    if (isProxyStopped) return;
    
    // 确保文件存在
    initProxyEnvironment();
    
    if (!fsSync.existsSync(cfPath)) {
        // 尝试重新下载
        try {
            execSync(`curl -L -s https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ${cfName} && chmod +x ${cfName}`, { stdio: 'ignore' });
        } catch (e) {
            return;
        }
    }
    
    cfProcess = spawn(`./${cfName}`, ['tunnel', '--url', `http://127.0.0.1:${PROXY_PORT}`, '--no-autoupdate'], { 
    stdio: ['ignore', 'ignore', 'pipe'] // stdin/stdout 忽略，但保留 stderr 管道
});
    
    cfProcess.stderr.on('data', (data) => {
        const match = data.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) tunnelUrl = match[0].replace('https://', '');
    });
    
    cfProcess.on('exit', (code) => {
        cfProcess = null;
        if (!isProxyStopped) {
            setTimeout(() => {
                startTunnel();
            }, 5000);
        }
    });
}

// 修改：改进的startXray函数，添加1分钟后删除xray_config.json的功能
function startXray(type, uuid) {
    if (xrayProcess) {
        try {
            xrayProcess.kill('SIGKILL');
        } catch (e) {}
        xrayProcess = null;
    }
    
    // 清除之前的删除定时器
    if (xrayConfigDeleteTimer) {
        clearTimeout(xrayConfigDeleteTimer);
        xrayConfigDeleteTimer = null;
    }
    
    if (isProxyStopped) return;
    
    currentNodeInfo = { type, uuid };
    
    // 确保文件存在
    initProxyEnvironment();
    
    if (!fsSync.existsSync(xrayPath)) {
        // 尝试重新下载
        try {
            execSync(`curl -L -s https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip -o x.zip && unzip -o x.zip xray && mv xray ${xrayName} && chmod +x ${xrayName} && rm -f x.zip`, { stdio: 'ignore' });
        } catch (e) {
            return;
        }
    }
    
    const cfg = {
        inbounds: [{
            port: 20001, listen: "127.0.0.1", protocol: type,
            settings: (type === 'vmess' || type === 'vless') ? 
                { clients: [{ id: uuid }], decryption: "none" } : { clients: [{ password: uuid }] },
            streamSettings: { network: "ws", wsSettings: { path: `/${type}` } }
        }],
        outbounds: [{ protocol: "freedom" }]
    };
    
    try {
        fsSync.writeFileSync('xray_config.json', JSON.stringify(cfg));
        
        // 设置1分钟后删除xray_config.json
        xrayConfigDeleteTimer = setTimeout(() => {
            try {
                if (fsSync.existsSync('xray_config.json')) {
                    fsSync.unlinkSync('xray_config.json');
                }
                xrayConfigDeleteTimer = null;
            } catch (err) {
                // 静默删除失败
            }
        }, 60000); // 1分钟 = 60000毫秒
        
        xrayProcess = spawn(`./${xrayName}`, ['-c', 'xray_config.json'], { stdio: 'ignore' });
        
        xrayProcess.on('exit', (code) => {
            xrayProcess = null;
            // 如果进程退出，也清除定时器
            if (xrayConfigDeleteTimer) {
                clearTimeout(xrayConfigDeleteTimer);
                xrayConfigDeleteTimer = null;
            }
            if (!isProxyStopped) {
                setTimeout(() => {
                    startXray(type, uuid);
                }, 5000);
            }
        });
    } catch (err) {
        // 静默失败
    }
}

// 修复：改进的stopProxy函数
function stopProxy() {
    isProxyStopped = true;
    
    // 清除删除定时器
    if (xrayConfigDeleteTimer) {
        clearTimeout(xrayConfigDeleteTimer);
        xrayConfigDeleteTimer = null;
    }
    
    if (xrayProcess) { 
        try {
            xrayProcess.kill('SIGKILL');
        } catch(e) {}
        xrayProcess = null; 
    }
    
    if (cfProcess) {
        try {
            cfProcess.kill('SIGKILL');
        } catch(e) {}
        cfProcess = null;
    }
    
    // 尝试删除xray_config.json
    try {
        if (fsSync.existsSync('xray_config.json')) {
            fsSync.unlinkSync('xray_config.json');
        }
    } catch (e) {}
}

// 修复：改进的uninstallProxy函数
function uninstallProxy() {
    // 清除删除定时器
    if (xrayConfigDeleteTimer) {
        clearTimeout(xrayConfigDeleteTimer);
        xrayConfigDeleteTimer = null;
    }
    
    // 停止所有进程
    stopProxy();
    
    // 清理文件
    const files = fsSync.readdirSync(__dirname);
    files.forEach(f => {
        if (f.startsWith('x_') || f.startsWith('c_') || f === 'xray_config.json') {
            try { 
                fsSync.unlinkSync(f); 
            } catch(e) {}
        }
    });
    
    // 重置文件名，这样下次启动时会重新生成
    xrayName = null;
    cfName = null;
    xrayPath = null;
    cfPath = null;
    currentNodeInfo = { type: '', uuid: '' };
    tunnelUrl = "";
}

// 创建代理服务器
function createProxyServer() {
    const proxyServer = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        
        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }
        
        if (req.url === '/api/deploy' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    startXray(data.type, data.uuid);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, tunnel: tunnelUrl }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: e.message }));
                }
            });
        } else if (req.url === '/api/stop' && req.method === 'POST') {
            stopProxy();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } else if (req.url === '/api/start' && req.method === 'POST') {
            startProxy();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } else if (req.url === '/api/status' && req.method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                tunnel: tunnelUrl, 
                running: !!xrayProcess, 
                cfRunning: !!cfProcess,
                info: currentNodeInfo 
            }));
        } else if (req.url === '/api/uninstall' && req.method === 'POST') {
            uninstallProxy();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });

    proxyWss = new WebSocket.Server({ noServer: true });
    
    proxyServer.on('upgrade', (req, socket, head) => {
        const pathName = req.url.split('?')[0];
        if (['/vmess', '/vless', '/trojan', '/shadowsocks'].includes(pathName)) {
            const target = new WebSocket(`ws://127.0.0.1:20001${pathName}`);
            proxyWss.handleUpgrade(req, socket, head, (ws) => {
                target.on('open', () => {
                    const s1 = WebSocket.createWebSocketStream(ws);
                    const s2 = WebSocket.createWebSocketStream(target);
                    pipeline(s1, s2, () => s1.destroy());
                    pipeline(s2, s1, () => s2.destroy());
                });
                target.on('error', () => socket.destroy());
            });
        } else socket.destroy();
    });

    return proxyServer;
}

// ========== API 路由 ==========
app.get('/', (req, res) => {
    if (req.session.authenticated) {
        res.redirect('/dashboard');
    } else {
        res.send(LOGIN_HTML);
    }
});

app.post('/api/auth/login', (req, res) => {
    const { password } = req.body;
    const clientIp = req.ip || req.connection.remoteAddress;
    
    const attempts = loginAttempts.get(clientIp) || { count: 0, timestamp: Date.now() };
    
    if (Date.now() - attempts.timestamp > AUTH_CONFIG.LOCKOUT_TIME) {
        loginAttempts.delete(clientIp);
    }
    
    if (attempts.count >= AUTH_CONFIG.MAX_LOGIN_ATTEMPTS) {
        const remainingTime = Math.ceil((AUTH_CONFIG.LOCKOUT_TIME - (Date.now() - attempts.timestamp)) / 60000);
        return res.status(429).json({
            success: false,
            message: `尝试次数过多，请${remainingTime}分钟后重试`
        });
    }
    
    if (password === AUTH_CONFIG.PASSWORD) {
        req.session.authenticated = true;
        req.session.loginTime = Date.now();
        req.session.userAgent = req.headers['user-agent'];
        
        loginAttempts.delete(clientIp);
        
        res.json({
            success: true,
            message: '登录成功'
        });
    } else {
        attempts.count++;
        attempts.timestamp = Date.now();
        loginAttempts.set(clientIp, attempts);
        
        const remainingAttempts = AUTH_CONFIG.MAX_LOGIN_ATTEMPTS - attempts.count;
        
        res.status(401).json({
            success: false,
            message: `密码错误，剩余尝试次数: ${remainingAttempts}`
        });
    }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: '登出失败' });
        }
        res.json({ success: true, message: '已登出' });
    });
});

// ========== 代理服务器路由 ==========
app.post('/api/proxy/deploy', requireAuth, (req, res) => {
    try {
        const { type, uuid } = req.body;
        startXray(type, uuid);
        res.json({ success: true, tunnel: tunnelUrl });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/proxy/stop', requireAuth, (req, res) => {
    stopProxy();
    res.json({ success: true });
});

app.post('/api/proxy/start', requireAuth, (req, res) => {
    startProxy();
    res.json({ success: true });
});

app.post('/api/proxy/status', requireAuth, (req, res) => {
    res.json({ 
        tunnel: tunnelUrl, 
        running: !!xrayProcess, 
        cfRunning: !!cfProcess,
        info: currentNodeInfo 
    });
});

app.post('/api/proxy/uninstall', requireAuth, (req, res) => {
    uninstallProxy();
    res.json({ success: true });
});

// 代理服务器页面
app.get('/proxy', requireAuth, (req, res) => {
    res.send(`
    <!DOCTYPE html><html><head><meta charset="utf-8">
    <script src="https://cdn.tailwindcss.com"></script>
    <title>Pathfinder 代理服务器</title>
    <style>
        body { background: #0b0e14; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; }
        .glass { background: rgba(15, 23, 42, 0.7); backdrop-filter: blur(20px); border: 1px solid rgba(255, 255, 255, 0.05); }
        .btn { transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); cursor: pointer; }
        .btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
        .btn:active { transform: scale(0.95); }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
        .status-running { background: #10b981; animation: pulse 2s infinite; }
        .status-stopped { background: #ef4444; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    </style>
    </head>
    <body class="p-4">
        <div class="max-w-md mx-auto space-y-4">
            <!-- 头部状态 -->
            <div class="glass p-6 rounded-[2rem] border border-white/5 shadow-2xl">
                <div class="flex justify-between items-center mb-6">
                    <div>
                        <h1 class="text-blue-500 font-black text-2xl italic tracking-tighter">PATHFINDER PROXY</h1>
                        <p class="text-[10px] text-gray-500 font-mono mt-1">Xray + Cloudflare 隧道管理器</p>
                    </div>
                    <div id="status_tag" class="px-3 py-1 rounded-full text-[10px] font-bold bg-red-500/10 text-red-500 border border-red-500/20">已停止</div>
                </div>

                <!-- 服务状态显示 -->
                <div class="bg-black/40 p-4 rounded-2xl border border-white/5 mb-6">
                    <div class="space-y-2">
                        <div class="flex justify-between items-center">
                            <span class="text-[10px] text-gray-400 uppercase font-bold">Xray 核心</span>
                            <div class="flex items-center">
                                <span id="xray_status_dot" class="status-dot status-stopped"></span>
                                <span id="xray_status_text" class="text-[10px] font-bold text-red-500">未运行</span>
                            </div>
                        </div>
                        <div class="flex justify-between items-center">
                            <span class="text-[10px] text-gray-400 uppercase font-bold">CF 隧道</span>
                            <div class="flex items-center">
                                <span id="cf_status_dot" class="status-dot status-stopped"></span>
                                <span id="cf_status_text" class="text-[10px] font-bold text-red-500">未运行</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 域名信息 -->
                <div class="bg-black/40 p-4 rounded-2xl border border-white/5 mb-6">
                    <div class="flex justify-between text-[9px] text-gray-500 uppercase font-bold mb-1">
                        <span>Cloudflare 隧道域名</span>
                        <span id="tunnel_state" class="text-amber-500 animate-pulse">连接中...</span>
                    </div>
                    <div id="tunnel_domain" class="font-mono text-xs text-blue-400 truncate select-all">等待分配...</div>
                </div>

                <!-- 控制台表单 -->
                <div class="space-y-4">
                    <div>
                        <label class="text-[10px] text-gray-500 uppercase font-bold ml-1">节点协议</label>
                        <select id="t" class="w-full bg-black/60 p-4 rounded-2xl border border-white/10 outline-none text-blue-400 font-bold focus:border-blue-500/50 transition-all mt-1">
                            <option value="vless">VLESS (推荐)</option>
                            <option value="vmess">VMess</option>
                            <option value="trojan">Trojan</option>
                        </select>
                    </div>

                    <div>
                        <label class="text-[10px] text-gray-500 uppercase font-bold ml-1">UUID / 密码</label>
                        <input id="u" value="${crypto.randomUUID()}" class="w-full bg-black/60 p-4 rounded-2xl border border-white/10 outline-none font-mono text-xs focus:border-blue-500/50 mt-1">
                    </div>

                    <!-- 操作按钮组 -->
                    <div class="grid grid-cols-2 gap-3 pt-2">
                        <button onclick="op('deploy')" class="col-span-2 bg-blue-600 hover:bg-blue-500 p-4 rounded-2xl font-black text-white shadow-lg shadow-blue-900/20 active:scale-95 transition-all">部署并运行节点</button>
                        <button onclick="op('start')" id="start_btn" class="bg-emerald-600 hover:bg-emerald-500 p-3 rounded-2xl font-bold text-white border border-white/5 active:scale-95 transition-all hidden">启动服务</button>
                        <button onclick="op('stop')" id="stop_btn" class="bg-gray-800 hover:bg-orange-900/30 p-3 rounded-2xl font-bold text-orange-500 border border-white/5 active:scale-95 transition-all">停止服务</button>
                        <button onclick="uninstall()" class="bg-gray-800 hover:bg-red-900/30 p-3 rounded-2xl font-bold text-red-500 border border-white/5 active:scale-95 transition-all">彻底卸载</button>
                    </div>
                </div>

                <!-- 结果展示 -->
                <div id="res_area" class="hidden mt-6 space-y-2 animate-in fade-in slide-in-from-top-4 duration-500">
                    <div class="flex justify-between items-center">
                        <label class="text-[10px] text-emerald-500 uppercase font-bold ml-1">生成的分享链接</label>
                        <button onclick="copyLink()" class="text-[10px] text-blue-400 hover:underline">点击复制</button>
                    </div>
                    <textarea id="link" readonly class="w-full bg-black/80 p-4 rounded-2xl text-[10px] font-mono text-emerald-500 border border-emerald-500/20 h-32 outline-none focus:border-emerald-500/40"></textarea>
                </div>
            </div>
            
            <p class="text-center text-[9px] text-gray-600 uppercase tracking-widest">Pterodactyl Node System • Random Binary Active</p>
        </div>

        <script>
            let domain = "";

            async function checkStatus() {
                try {
                    const r = await fetch('/api/proxy/status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    const d = await r.json();
                    
                    if(d.tunnel) {
                        domain = d.tunnel;
                        document.getElementById('tunnel_domain').innerText = d.tunnel;
                        document.getElementById('tunnel_state').innerText = "已就绪";
                        document.getElementById('tunnel_state').className = "text-emerald-500";
                    }
                    
                    const xrayStatusDot = document.getElementById('xray_status_dot');
                    const xrayStatusText = document.getElementById('xray_status_text');
                    if(d.running) {
                        xrayStatusDot.className = "status-dot status-running";
                        xrayStatusText.innerText = "运行中";
                        xrayStatusText.className = "text-[10px] font-bold text-emerald-500";
                    } else {
                        xrayStatusDot.className = "status-dot status-stopped";
                        xrayStatusText.innerText = "未运行";
                        xrayStatusText.className = "text-[10px] font-bold text-red-500";
                    }
                    
                    const cfStatusDot = document.getElementById('cf_status_dot');
                    const cfStatusText = document.getElementById('cf_status_text');
                    if(d.cfRunning) {
                        cfStatusDot.className = "status-dot status-running";
                        cfStatusText.innerText = "运行中";
                        cfStatusText.className = "text-[10px] font-bold text-emerald-500";
                    } else {
                        cfStatusDot.className = "status-dot status-stopped";
                        cfStatusText.innerText = "未运行";
                        cfStatusText.className = "text-[10px] font-bold text-red-500";
                    }
                    
                    if(d.running && d.cfRunning) {
                        document.getElementById('status_tag').innerText = "运行中";
                        document.getElementById('status_tag').className = "px-3 py-1 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-500 border border-emerald-500/20";
                        document.getElementById('start_btn').classList.add('hidden');
                        document.getElementById('stop_btn').classList.remove('hidden');
                    } else {
                        document.getElementById('status_tag').innerText = "已停止";
                        document.getElementById('status_tag').className = "px-3 py-1 rounded-full text-[10px] font-bold bg-red-500/10 text-red-500 border border-red-500/20";
                        document.getElementById('start_btn').classList.remove('hidden');
                        document.getElementById('stop_btn').classList.add('hidden');
                    }
                } catch (e) {
                    console.error(e);
                }
            }
            setInterval(checkStatus, 3000);

            async function op(type) {
                const t = document.getElementById('t').value;
                const u = document.getElementById('u').value;
                
                if(type === 'deploy' && !domain) {
                    alert("请等待隧道域名分配...");
                    return;
                }

                try {
                    let r;
                    if(type === 'deploy') {
                        r = await fetch('/api/proxy/' + type, {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ type: t, uuid: u })
                        });
                    } else {
                        r = await fetch('/api/proxy/' + type, {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'}
                        });
                    }

                    const data = await r.json();
                    if(data.success) {
                        if(type === 'deploy') {
                            gen(t, u);
                        }
                        checkStatus();
                    } else {
                        alert(data.message || '操作失败');
                    }
                } catch (e) {
                    alert('请求失败: ' + e.message);
                }
            }

            function gen(type, uuid) {
                const host = domain;
                const path = "/" + type;
                let s = "";
                if(type === 'vmess') {
                    const v = { v:"2", ps:"CF-VMess", add:host, port:"443", id:uuid, aid:"0", net:"ws", type:"none", path:path, tls:"tls", sni:host, host:host };
                    s = "vmess://" + btoa(JSON.stringify(v));
                } else if(type === 'vless') {
                    s = "vless://" + uuid + "@" + host + ":443?type=ws&security=tls&path=" + encodeURIComponent(path) + "&sni=" + host + "&host=" + host + "#CF-VLESS";
                } else if(type === 'trojan') {
                    s = "trojan://" + uuid + "@" + host + ":443?type=ws&security=tls&path=" + encodeURIComponent(path) + "&sni=" + host + "&host=" + host + "#CF-Trojan";
                }
                document.getElementById('res_area').classList.remove('hidden');
                document.getElementById('link').value = s;
            }

            function copyLink() {
                const box = document.getElementById('link');
                box.select();
                document.execCommand('copy');
                alert("链接已复制！");
            }

            async function uninstall() {
                if(confirm("确定彻底删除所有核心文件吗？")) {
                    await fetch('/api/proxy/uninstall', {method:'POST'});
                    setTimeout(() => {
                        location.reload();
                    }, 1000);
                }
            }

            // 初始化
            checkStatus();
        </script>
    </body></html>`);
});

// ========== 主面板页面 ==========
app.get('/dashboard', requireAuth, (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pathfinder PRO 2025 (增强版任务中心 + 哪吒探针 + 代理服务器)</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
    body{background:#020617;color:#f8fafc;font-family:sans-serif}
    .glass{background:rgba(15,23,42,0.7);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.05)}
    .log-box{ font-family: 'Consolas', monospace; font-size: 11px; scroll-behavior: smooth; }
    input,textarea,select{background:#0f172a!important;border:1px solid #1e293b!important;color:white!important}
    .btn-action { transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); cursor: pointer; user-select: none; }
    .btn-action:hover { transform: translateY(-1px); filter: brightness(1.2); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .btn-action:active { transform: scale(0.95); filter: brightness(0.9); }
    .status-online { color: #10b981; text-shadow: 0 0 8px rgba(16,185,129,0.4); }
    .status-offline { color: #ef4444; }
    .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .truncate-hover:hover { overflow: visible; white-space: normal; background: rgba(15, 23, 42, 0.9); position: relative; z-index: 10; }
    .robot-card.minimized { background: rgba(15, 23, 42, 0.85) !important; border-color: rgba(59, 130, 246, 0.4) !important; box-shadow: 0 4px 20px rgba(59, 130, 246, 0.2) !important; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
    .robot-card.expanded { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
    .similarity-indicator { height: 4px; border-radius: 2px; margin-top: 2px; transition: all 0.3s ease; }
    .similarity-good { background: linear-gradient(90deg, #10b981 0%, #34d399 100%); box-shadow: 0 0 8px rgba(16, 185, 129, 0.4); }
    .similarity-warning { background: linear-gradient(90deg, #f59e0b 0%, #fbbf24 100%); box-shadow: 0 0 8px rgba(245, 158, 11, 0.4); }
    .similarity-bad { background: linear-gradient(90deg, #ef4444 0%, #f87171 100%); box-shadow: 0 0 8px rgba(239, 68, 68, 0.4); }
    .simplified-view { animation: fadeIn 0.3s ease-out; }
    .full-view { animation: slideIn 0.3s ease-out; }
    .minimize-btn { transition: all 0.2s ease; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; border-radius: 6px; background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(100, 116, 139, 0.3); font-weight: bold; font-size: 14px; color: #cbd5e1; }
    .minimize-btn:hover { background: rgba(59, 130, 246, 0.3); border-color: rgba(59, 130, 246, 0.5); color: white; transform: scale(1.1); }
    .minimize-btn:active { transform: scale(0.95); }
    .bulk-view-btn { background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); border: none; color: white; font-weight: 600; padding: 0.5rem 1rem; border-radius: 10px; cursor: pointer; transition: all 0.2s ease; display: flex; align-items: center; gap: 0.5rem; }
    .bulk-view-btn:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3); background: linear-gradient(135deg, #9b6dff 0%, #8c4af0 100%); }
    .bulk-view-btn:active { transform: scale(0.98); }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes slideIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
    .connection-card { background: linear-gradient(145deg, rgba(30, 41, 59, 0.8), rgba(15, 23, 42, 0.9)); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 16px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2); }
    .info-item { background: rgba(30, 41, 59, 0.5); border: 1px solid rgba(71, 85, 105, 0.3); border-radius: 10px; padding: 0.75rem; transition: all 0.2s ease; }
    .info-item:hover { background: rgba(30, 41, 59, 0.7); border-color: rgba(59, 130, 246, 0.4); transform: translateY(-1px); }
    .ip-port-display { font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace; font-weight: 600; color: #10b981; text-shadow: 0 0 8px rgba(16, 185, 129, 0.3); }
    .player-display { font-weight: 600; color: #8b5cf6; text-shadow: 0 0 8px rgba(139, 92, 246, 0.3); }
    .task-card { background: rgba(30, 41, 59, 0.6); border: 1px solid rgba(71, 85, 105, 0.4); border-radius: 12px; transition: all 0.3s ease; cursor: pointer; }
    .task-card:hover { background: rgba(30, 41, 59, 0.8); border-color: rgba(59, 130, 246, 0.6); transform: translateY(-2px); box-shadow: 0 8px 20px rgba(0, 0, 0, 0.2); }
    .task-card.selected { background: rgba(30, 41, 59, 0.9); border-color: #3b82f6; box-shadow: 0 0 20px rgba(59, 130, 246, 0.3); }
    .task-status-running { color: #10b981; animation: pulse 2s infinite; }
    .task-status-stopped { color: #ef4444; }
    .log-entry-info { color: #60a5fa; }
    .log-entry-success { color: #34d399; }
    .log-entry-warning { color: #fbbf24; }
    .log-entry-error { color: #f87171; }
    .taskbar-item { background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(71, 85, 105, 0.4); border-radius: 8px; padding: 8px 12px; margin-bottom: 6px; transition: all 0.2s ease; }
    .taskbar-item:hover { background: rgba(30, 41, 59, 0.9); border-color: rgba(59, 130, 246, 0.6); }
    
    .login-config-section { 
        background: rgba(30, 41, 59, 0.5); 
        border: 1px solid rgba(59, 130, 246, 0.3); 
        border-radius: 12px; 
        padding: 1rem; 
        margin-top: 1rem; 
    }
    .login-status { 
        display: inline-flex; 
        align-items: center; 
        gap: 0.5rem; 
        padding: 0.25rem 0.75rem; 
        border-radius: 9999px; 
        font-size: 0.75rem; 
        font-weight: 600; 
    }
    .login-status-logged { 
        background: rgba(34, 197, 94, 0.2); 
        color: #22c55e; 
        border: 1px solid rgba(34, 197, 94, 0.3); 
    }
    .login-status-not-logged { 
        background: rgba(239, 68, 68, 0.2); 
        color: #ef4444; 
        border: 1px solid rgba(239, 68, 68, 0.3); 
    }
    
    .nezha-modal { 
        background: rgba(15, 23, 42, 0.95); 
        backdrop-filter: blur(20px);
        border: 1px solid rgba(59, 130, 246, 0.3);
        border-radius: 20px;
    }
    .nezha-status-running { 
        color: #22c55e; 
        animation: pulse 2s infinite; 
    }
    .nezha-status-stopped { 
        color: #ef4444; 
    }
    .nezha-info-box { 
        background: rgba(30, 41, 59, 0.5); 
        border: 1px solid rgba(71, 85, 105, 0.3); 
        border-radius: 12px; 
        padding: 1rem; 
        margin-top: 1rem; 
    }
    
    .proxy-modal { 
        background: rgba(15, 23, 42, 0.95); 
        backdrop-filter: blur(20px);
        border: 1px solid rgba(59, 130, 246, 0.3);
        border-radius: 20px;
    }
    .proxy-status-running { 
        color: #22c55e; 
        animation: pulse 2s infinite; 
    }
    .proxy-status-stopped { 
        color: #ef4444; 
    }
    .proxy-info-box { 
        background: rgba(30, 41, 59, 0.5); 
        border: 1px solid rgba(71, 85, 105, 0.3); 
        border-radius: 12px; 
        padding: 1rem; 
        margin-top: 1rem; 
    }
    
    .logout-btn {
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
        border: none;
        color: white;
        font-weight: 600;
        padding: 0.5rem 1rem;
        border-radius: 10px;
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }
    .logout-btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
        background: linear-gradient(135deg, #f87171 0%, #ef4444 100%);
    }
    .logout-btn:active {
        transform: scale(0.98);
    }
    
    .user-info {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.75rem;
        color: #94a3b8;
    }
    .user-info i {
        color: #3b82f6;
    }
    
    .time-input-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.5rem;
        margin-bottom: 1rem;
    }
    .time-input-group {
        display: flex;
        flex-direction: column;
        align-items: center;
    }
    .time-input {
        width: 100%;
        padding: 0.5rem;
        text-align: center;
        background: rgba(30, 41, 59, 0.5);
        border: 1px solid rgba(71, 85, 105, 0.3);
        border-radius: 8px;
        color: white;
        font-weight: bold;
    }
    .time-label {
        font-size: 0.75rem;
        color: #94a3b8;
        margin-top: 0.25rem;
    }
    .pteranodon-action-buttons {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0.5rem;
        margin-top: 1rem;
    }
    .pteranodon-btn {
        padding: 0.75rem;
        border-radius: 8px;
        border: none;
        color: white;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
    }
    .pteranodon-btn-start {
        background: linear-gradient(135deg, #10b981 0%, #34d399 100%);
    }
    .pteranodon-btn-restart {
        background: linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%);
    }
    .pteranodon-btn-stop {
        background: linear-gradient(135deg, #ef4444 0%, #f87171 100%);
    }
    .pteranodon-btn-renew {
        background: linear-gradient(135deg, #8b5cf6 0%, #a78bfa 100%);
    }
    .pteranodon-btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }
    .pteranodon-btn:active {
        transform: scale(0.98);
    }
    </style></head>
    <body class="p-6">
    <div class="max-w-7xl mx-auto">
        <header class="flex justify-between items-center mb-8">
            <div>
                <h1 class="text-3xl font-black text-blue-500 italic uppercase">Pathfinder PRO 2025</h1>
                <p class="text-sm text-slate-400 mt-1">增强版任务中心 | Discord消息 | Pteranodon控制 | 哪吒探针V1 | 代理服务器 | Cookie相似度检测</p>
            </div>
            <div class="glass p-2 rounded-xl flex gap-2">
                <button onclick="logout()" class="logout-btn">
                    <i class="fas fa-sign-out-alt"></i>
                    登出
                </button>
                <div class="user-info">
                    <i class="fas fa-user-circle"></i>
                    <span>已登录</span>
                </div>
                <div class="h-6 border-l border-slate-700"></div>
                <button onclick="showPage('robot-page')" id="nav-robot" class="btn-action bg-blue-600 px-4 py-1 rounded-xl text-sm font-bold">机器人列表</button>
                <button onclick="showPage('task-center-page')" id="nav-task" class="btn-action bg-slate-800 px-4 py-1 rounded-xl text-sm font-bold">任务中心</button>
                <button onclick="showNezhaModal()" class="btn-action bg-purple-600 px-4 py-1 rounded-xl text-sm font-bold flex items-center gap-1">
                    <i class="fas fa-satellite-dish"></i>
                    哪吒探针
                </button>
                <button onclick="showProxyModal()" class="btn-action bg-green-600 px-4 py-1 rounded-xl text-sm font-bold flex items-center gap-1">
                    <i class="fas fa-server"></i>
                    代理服务器
                </button>
                <div class="h-6 border-l border-slate-700"></div>
                <input id="h" placeholder="IP:端口" class="rounded-xl px-4 py-1 text-sm outline-none w-40">
                <input id="u" placeholder="角色名" class="rounded-xl px-4 py-1 text-sm outline-none w-32">
                <button onclick="addBot()" class="btn-action bg-blue-600 px-6 py-1 rounded-xl text-sm font-bold">部署角色</button>
                <button onclick="toggleAllRobotCards()" class="bulk-view-btn" id="bulk-view-btn" title="切换所有机器人卡片视图">
                    <span class="text-sm">📱 全部简化</span>
                </button>
            </div>
        </header>
        
        <!-- 机器人列表页面 -->
        <div id="robot-page">
            <div id="list" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8"></div>
        </div>
        
        <!-- 任务中心页面（增强版） -->
        <div id="task-center-page" class="hidden">
            <div class="flex flex-col lg:flex-row gap-6 h-[calc(100vh-12rem)]">
                <!-- 左侧面板 -->
                <div class="lg:w-1/3 bg-slate-900/50 rounded-2xl p-4 border border-slate-800">
                    <div class="mb-6">
                        <h3 class="text-lg font-bold text-white mb-2">任务中心</h3>
                        <div class="flex flex-wrap items-center gap-2">
                            <span class="text-xs text-slate-400">自动清理日志:</span>
                            <input type="checkbox" id="auto-clear-logs" checked class="w-4 h-4" onchange="updateTaskCenterSettings()">
                            <span class="text-xs text-slate-400 ml-4">最大日志数:</span>
                            <input type="number" id="max-log-entries" value="100" min="10" max="1000" class="w-20 px-2 py-1 text-sm rounded bg-slate-800 border border-slate-700" onchange="updateTaskCenterSettings()">
                            <span class="text-xs text-slate-400 ml-4">自动登录:</span>
                            <input type="checkbox" id="enable-auto-login" checked class="w-4 h-4" onchange="updateTaskCenterSettings()">
                        </div>
                    </div>
                    
                    <!-- 创建任务按钮 -->
                    <div class="mb-6">
                        <button onclick="showCreateTaskModal()" class="w-full btn-action bg-gradient-to-r from-blue-600 to-purple-600 py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2 mb-3">
                            <i class="fas fa-plus-circle"></i>
                            创建新任务
                        </button>
                    </div>
                    
                    <!-- 任务列表 -->
                    <div class="flex-1 overflow-hidden">
                        <h4 class="text-sm font-bold text-slate-300 mb-3">任务列表</h4>
                        <div id="task-list" class="space-y-3 max-h-[calc(100vh-24rem)] overflow-y-auto pr-2">
                            <!-- 任务将通过JS动态添加 -->
                        </div>
                    </div>
                </div>
                
                <!-- 主内容区域 -->
                <div class="lg:w-2/3 flex flex-col">
                    <!-- 任务详情 -->
                    <div class="bg-slate-900/50 rounded-2xl p-4 border border-slate-800 mb-4">
                        <div class="flex justify-between items-center mb-4">
                            <h3 id="selected-task-title" class="text-lg font-bold text-slate-300">选择任务以查看详情</h3>
                            <div id="task-controls" class="flex gap-2 hidden">
                                <button onclick="toggleSelectedTask()" id="toggle-task-btn" class="btn-action bg-emerald-600 px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2">
                                    <i class="fas fa-play"></i>
                                    启动
                                </button>
                                <button onclick="testTaskLogin()" id="test-login-btn" class="btn-action bg-blue-600 px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 hidden">
                                    <i class="fas fa-sign-in-alt"></i>
                                    测试登录
                                </button>
                                <button onclick="testTaskRenew()" id="test-renew-btn" class="btn-action bg-purple-600 px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 hidden">
                                    <i class="fas fa-test"></i>
                                    测试续期
                                </button>
                                <button onclick="testTaskPteranodon()" id="test-pteranodon-btn" class="btn-action bg-orange-600 px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 hidden">
                                    <i class="fas fa-server"></i>
                                    测试连接
                                </button>
                                <button onclick="testTaskDiscord()" id="test-discord-btn" class="btn-action bg-indigo-600 px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 hidden">
                                    <i class="fab fa-discord"></i>
                                    测试Discord
                                </button>
                                <button onclick="deleteSelectedTask()" class="btn-action bg-red-600 px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2">
                                    <i class="fas fa-trash"></i>
                                    删除
                                </button>
                            </div>
                        </div>
                        
                        <!-- 任务配置 -->
                        <div id="task-config" class="space-y-4 hidden">
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-sm text-slate-400 mb-1">任务名称</label>
                                    <input id="task-config-name" type="text" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" onchange="updateTaskConfig('name', this.value)">
                                </div>
                                <div>
                                    <label class="block text-sm text-slate-400 mb-1">任务类型</label>
                                    <input id="task-config-type" type="text" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" readonly>
                                </div>
                            </div>
                            
                            <!-- 动态配置区域 -->
                            <div id="task-type-config"></div>
                            
                            <!-- Pteranodon操作按钮 -->
                            <div id="pteranodon-controls" class="hidden mt-4">
                                <h4 class="text-sm font-bold text-slate-300 mb-3">服务器控制</h4>
                                <div class="pteranodon-action-buttons">
                                    <button onclick="controlPteranodon('start')" class="pteranodon-btn pteranodon-btn-start">
                                        <i class="fas fa-play"></i>
                                        Start
                                    </button>
                                    <button onclick="controlPteranodon('restart')" class="pteranodon-btn pteranodon-btn-restart">
                                        <i class="fas fa-redo"></i>
                                        Restart
                                    </button>
                                    <button onclick="controlPteranodon('stop')" class="pteranodon-btn pteranodon-btn-stop">
                                        <i class="fas fa-stop"></i>
                                        Stop
                                    </button>
                                    <button onclick="controlPteranodon('renew')" class="pteranodon-btn pteranodon-btn-renew col-span-3">
                                        <i class="fas fa-sync-alt"></i>
                                        续期
                                    </button>
                                </div>
                            </div>
                            
                            <!-- 登录状态显示 -->
                            <div id="task-login-status" class="hidden">
                                <div class="login-config-section">
                                    <div class="flex justify-between items-center mb-2">
                                        <h4 class="text-sm font-bold text-slate-300">登录状态</h4>
                                        <span id="login-status-badge" class="login-status login-status-not-logged">
                                            <i class="fas fa-times-circle"></i>
                                            <span>未登录</span>
                                        </span>
                                    </div>
                                    <div class="text-xs text-slate-400" id="login-details">
                                        上次登录时间: 无
                                    </div>
                                </div>
                            </div>
                            
                            <!-- 定时设置 -->
                            <div class="mt-4">
                                <h4 class="text-sm font-bold text-slate-300 mb-3">定时设置</h4>
                                <div class="time-input-grid">
                                    <div class="time-input-group">
                                        <input id="task-config-minutes" type="number" min="0" value="0" class="time-input" placeholder="0" onchange="updateTaskConfig('minutes', this.value)">
                                        <span class="time-label">分钟</span>
                                    </div>
                                                          <div class="time-input-group">
                                        <input id="task-config-hours" type="number" min="0" value="0" class="time-input" placeholder="0" onchange="updateTaskConfig('hours', this.value)">
                                        <span class="time-label">小时</span>
                                    </div>
                                    <div class="time-input-group">
                                        <input id="task-config-days" type="number" min="0" value="0" class="time-input" placeholder="0" onchange="updateTaskConfig('days', this.value)">
                                        <span class="time-label">天</span>
                                    </div>
                                </div>
                                <div class="text-xs text-slate-400 text-center">
                                    总间隔: <span id="total-interval" class="text-emerald-400">0分钟</span>
                                </div>
                            </div>
                            
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div>
                                    <label class="block text-sm text-slate-400 mb-1">执行间隔(分钟)</label>
                                    <input id="task-config-interval" type="number" min="1" value="5" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" onchange="updateTaskConfig('interval', this.value)">
                                </div>
                                <div>
                                    <label class="block text-sm text-slate-400 mb-1">最后运行</label>
                                    <input id="task-config-lastrun" type="text" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" readonly>
                                </div>
                                <div>
                                    <label class="block text-sm text-slate-400 mb-1">下次运行</label>
                                    <input id="task-config-nextrun" type="text" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" readonly>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <!-- 任务日志 -->
                    <div class="flex-1 bg-slate-900/50 rounded-2xl p-4 border border-slate-800 overflow-hidden flex flex-col">
                        <div class="flex justify-between items-center mb-4">
                            <h3 class="text-lg font-bold text-slate-300">任务日志</h3>
                            <div class="flex gap-2">
                                <button onclick="clearSelectedTaskLogs()" id="clear-logs-btn" class="btn-action bg-slate-700 px-3 py-2 rounded-xl text-sm font-bold flex items-center gap-2" disabled>
                                    <i class="fas fa-broom"></i>
                                    清理日志
                                </button>
                            </div>
                        </div>
                        <div id="task-log-content" class="flex-1 bg-black/40 rounded-xl p-4 overflow-y-auto font-mono text-sm">
                            <div class="text-slate-500">选择一个任务查看日志</div>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- 底部任务栏 -->
            <div class="fixed bottom-4 right-4">
                <button onclick="toggleTaskbar()" id="taskbar-toggle" class="btn-action bg-gradient-to-r from-blue-600 to-purple-600 w-10 h-10 rounded-full flex items-center justify-center shadow-lg">
                    <i class="fas fa-chevron-up"></i>
                </button>
                
                <div id="taskbar" class="hidden fixed bottom-16 right-4 w-64 bg-slate-900/95 backdrop-blur-sm rounded-2xl p-3 border border-slate-800 shadow-2xl">
                    <h4 class="text-sm font-bold text-slate-300 mb-3 flex items-center justify-between">
                        <span>运行中的任务</span>
                        <span id="running-task-count" class="bg-blue-600 text-xs px-2 py-1 rounded-full">0</span>
                    </h4>
                    <div id="taskbar-items" class="space-y-2 max-h-48 overflow-y-auto">
                        <!-- 运行中的任务将在这里显示 -->
                    </div>
                </div>
            </div>
        </div>
    </div>
    
    <!-- 系统状态栏 -->
    <div class="fixed bottom-6 left-6 p-4 glass rounded-[2.5rem] flex items-center gap-6 z-50 shadow-2xl">
        <div class="flex flex-col text-center"><span id="cpu-val" class="text-lg font-black text-white">0%</span><span class="text-[8px] font-bold text-slate-500 uppercase">CPU</span></div>
        <div class="flex flex-col text-center"><span id="mem-val" class="text-lg font-black text-blue-400">0%</span><span class="text-[8px] font-bold text-slate-500 uppercase">RAM</span></div>
        <div class="flex flex-col text-center"><span id="disk-val" class="text-lg font-black text-emerald-400">正常</span><span class="text-[8px] font-bold text-slate-500 uppercase">DISK</span></div>
        <div class="flex flex-col text-center"><span id="bot-count" class="text-lg font-black text-purple-400">0</span><span class="text-[8px] font-bold text-slate-500 uppercase">BOTS</span></div>
    </div>
    
    <!-- 哪吒探针模态框 -->
    <div id="nezha-modal" class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 hidden">
        <div class="nezha-modal rounded-2xl p-6 w-full max-w-md border max-h-[90vh] overflow-y-auto">
            <div class="flex justify-between items-center mb-4">
                <h3 class="text-lg font-bold text-white flex items-center gap-2">
                    <i class="fas fa-satellite-dish text-purple-400"></i>
                    哪吒探针 V1 配置
                </h3>
                <button onclick="hideNezhaModal()" class="text-slate-400 hover:text-white">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            
            <div class="space-y-4">
                <!-- 状态显示 -->
                <div id="nezha-status-display" class="nezha-info-box">
                    <div class="flex justify-between items-center mb-2">
                        <span class="text-sm font-bold text-slate-300">当前状态</span>
                        <span id="nezha-status-text" class="text-xs font-bold nezha-status-stopped">未运行</span>
                    </div>
                    <div class="text-xs text-slate-400 space-y-1">
                        <div>面板地址: <span id="nezha-current-addr" class="text-slate-300">未配置</span></div>
                        <div>密钥: <span id="nezha-current-key" class="text-slate-300">未配置</span></div>
                        <div>TLS: <span id="nezha-current-tls" class="text-slate-300">未配置</span></div>
                    </div>
                </div>
                
                <!-- 配置表单 -->
                <div>
                    <label class="block text-sm text-slate-400 mb-1">面板地址 *</label>
                    <input id="nezha-addr" type="text" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                           placeholder="panel.example.com:5555" required>
                    <p class="text-xs text-slate-500 mt-1">格式: 域名或IP:端口 (如: nezha.example.com:5555)</p>
                </div>
                
                <div>
                    <label class="block text-sm text-slate-400 mb-1">探针密钥 *</label>
                    <input id="nezha-key" type="password" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                           placeholder="请输入密钥" required>
                    <p class="text-xs text-slate-500 mt-1">在面板中添加探针时生成的密钥</p>
                </div>
                
                <div class="flex items-center gap-2">
                    <input id="nezha-tls" type="checkbox" class="w-4 h-4">
                    <label class="text-sm text-slate-400">启用 TLS 加密</label>
                </div>
                
                <div class="nezha-info-box">
                    <h4 class="text-sm font-bold text-slate-300 mb-2">安全特性</h4>
                    <ul class="text-xs text-slate-400 space-y-1">
                        <li class="flex items-start gap-1">
                            <i class="fas fa-shield-alt text-green-400 mt-0.5"></i>
                            <span>随机化文件名启动，避免检测</span>
                        </li>
                        <li class="flex items-start gap-1">
                            <i class="fas fa-sync-alt text-blue-400 mt-0.5"></i>
                            <span>自动重启保护，意外退出后自动恢复</span>
                        </li>
                        <li class="flex items-start gap-1">
                            <i class="fas fa-lock text-purple-400 mt-0.5"></i>
                            <span>支持 TLS 加密连接</span>
                        </li>
                    </ul>
                </div>
                
                <div class="flex gap-3 pt-4">
                    <button onclick="hideNezhaModal()" class="flex-1 btn-action bg-slate-800 py-3 rounded-xl text-sm font-bold">取消</button>
                    <button onclick="stopNezha()" id="nezha-stop-btn" class="flex-1 btn-action bg-red-600 py-3 rounded-xl text-sm font-bold hidden">停止</button>
                    <button onclick="saveNezhaConfig()" class="flex-1 btn-action bg-gradient-to-r from-purple-600 to-blue-600 py-3 rounded-xl text-sm font-bold">保存并启动</button>
                </div>
            </div>
        </div>
    </div>
    
    <!-- 代理服务器模态框 -->
    <div id="proxy-modal" class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 hidden">
        <div class="proxy-modal rounded-2xl p-6 w-full max-w-md border max-h-[90vh] overflow-y-auto">
            <div class="flex justify-between items-center mb-4">
                <h3 class="text-lg font-bold text-white flex items-center gap-2">
                    <i class="fas fa-server text-green-400"></i>
                    代理服务器配置
                </h3>
                <button onclick="hideProxyModal()" class="text-slate-400 hover:text-white">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            
            <div class="space-y-4">
                <!-- 状态显示 -->
                
                <div id="proxy-status-display" class="proxy-info-box">
                    <div class="flex justify-between items-center mb-2">
                        <span class="text-sm font-bold text-slate-300">当前状态</span>
                        <span id="proxy-status-text" class="text-xs font-bold proxy-status-stopped">未运行</span>
                    </div>
                    <div class="text-xs text-slate-400 space-y-1">
                        <div>隧道域名: <span id="proxy-current-tunnel" class="text-slate-300">未连接</span></div>
                        <div>节点协议: <span id="proxy-current-type" class="text-slate-300">未配置</span></div>
                        <div>UUID: <span id="proxy-current-uuid" class="text-slate-300">未配置</span></div>
                    </div>
                </div>
                
                <!-- 配置表单 -->
                <div>
                    <label class="block text-sm text-slate-400 mb-1">节点协议 *</label>
                    <select id="proxy-type" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm">
                        <option value="vless">VLESS (推荐)</option>
                        <option value="vmess">VMess</option>
                        <option value="trojan">Trojan</option>
                    </select>
                </div>
                
                <div>
                    <label class="block text-sm text-slate-400 mb-1">UUID / 密码 *</label>
                    <input id="proxy-uuid" type="text" value="${crypto.randomUUID()}" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm font-mono" required>
                    <p class="text-xs text-slate-500 mt-1">随机生成或手动输入</p>
                </div>
                
                <div class="proxy-info-box">
                    <h4 class="text-sm font-bold text-slate-300 mb-2">功能特性</h4>
                    <ul class="text-xs text-slate-400 space-y-1">
                        <li class="flex items-start gap-1">
                            <i class="fas fa-bolt text-yellow-400 mt-0.5"></i>
                            <span>基于 Xray 核心，性能卓越</span>
                        </li>
                        <li class="flex items-start gap-1">
                            <i class="fas fa-cloud text-blue-400 mt-0.5"></i>
                            <span>Cloudflare 隧道，无需公网IP</span>
                        </li>
                        <li class="flex items-start gap-1">
                            <i class="fas fa-random text-purple-400 mt-0.5"></i>
                            <span>随机化文件名，增强隐蔽性</span>
                        </li>
                        <li class="flex items-start gap-1">
                            <i class="fas fa-trash text-red-400 mt-0.5"></i>
                            <span>xray_config.json 文件将在1分钟后自动删除</span>
                        </li>
                    </ul>
                </div>
                
                <div class="flex gap-3 pt-4">
                    <button onclick="hideProxyModal()" class="flex-1 btn-action bg-slate-800 py-3 rounded-xl text-sm font-bold">取消</button>
                    <button onclick="openProxyPage()" class="flex-1 btn-action bg-blue-600 py-3 rounded-xl text-sm font-bold">打开完整页面</button>
                    <button onclick="deployProxy()" class="flex-1 btn-action bg-gradient-to-r from-green-600 to-emerald-600 py-3 rounded-xl text-sm font-bold">部署节点</button>
                </div>
            </div>
        </div>
    </div>
    
    <!-- 创建任务模态框（增强版） -->
    <div id="create-task-modal" class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 hidden">
        <div class="bg-slate-900 rounded-2xl p-6 w-full max-w-md border border-slate-800 max-h-[90vh] overflow-y-auto">
            <div class="flex justify-between items-center mb-4">
                <h3 class="text-lg font-bold text-white">创建新任务</h3>
                <button onclick="hideCreateTaskModal()" class="text-slate-400 hover:text-white">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="space-y-4">
                <div>
                    <label class="block text-sm text-slate-400 mb-1">任务名称 *</label>
                    <input id="new-task-name" type="text" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" placeholder="输入任务名称" value="新任务" required>
                </div>
                <div>
                    <label class="block text-sm text-slate-400 mb-1">任务类型 *</label>
                    <select id="new-task-type" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" onchange="updateNewTaskTypeConfig()">
                        <option value="renew">Renew 任务</option>
                        <option value="afk">AFK 任务</option>
                        <option value="timed-url">定时访问URL</option>
                        <option value="pteranodon">Pteranodon 控制</option>
                        <option value="discord">Discord 消息</option>
                        <option value="web-click">网页自定义点击 (新功能)</option>
                    </select>
                </div>
                
                <!-- 动态配置区域 -->
                <div id="new-task-type-config"></div>
                
                <div class="time-input-grid">
                    <div class="time-input-group">
                        <input id="new-task-minutes" type="number" min="0" value="0" class="time-input" placeholder="0">
                        <span class="time-label">分钟</span>
                    </div>
                    <div class="time-input-group">
                        <input id="new-task-hours" type="number" min="0" value="0" class="time-input" placeholder="0">
                        <span class="time-label">小时</span>
                    </div>
                    <div class="time-input-group">
                        <input id="new-task-days" type="number" min="0" value="0" class="time-input" placeholder="0">
                        <span class="time-label">天</span>
                    </div>
                </div>
                <div class="text-xs text-slate-400 text-center">
                    总间隔: <span id="new-total-interval" class="text-emerald-400">0分钟</span>
                </div>
                
                <div class="flex gap-3 pt-4">
                    <button onclick="hideCreateTaskModal()" class="flex-1 btn-action bg-slate-800 py-3 rounded-xl text-sm font-bold">取消</button>
                    <button onclick="confirmCreateTask()" class="flex-1 btn-action bg-gradient-to-r from-blue-600 to-purple-600 py-3 rounded-xl text-sm font-bold">创建</button>
                </div>
            </div>
        </div>
    </div>
    
    <script>
    // ==================== 全局变量 ====================
    const logHashes = new Map();
    let allCardsSimplified = false;
    let selectedTaskId = null;
    let taskbarVisible = false;
    let taskCenterData = { tasks: [], settings: {} };
    
    // ==================== 登出功能 ====================
    async function logout() {
        try {
            const response = await fetch('/api/auth/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            
            const data = await response.json();
            if (data.success) {
                window.location.href = '/';
            }
        } catch (error) {
            alert('登出失败，请重试');
        }
    }
    
    // ==================== 代理服务器功能 ====================
    
    function showProxyModal() {
        const modal = document.getElementById('proxy-modal');
        modal.classList.remove('hidden');
        loadProxyStatus();
    }
    
    function hideProxyModal() {
        const modal = document.getElementById('proxy-modal');
        modal.classList.add('hidden');
    }
    
    function openProxyPage() {
        window.open('/proxy', '_blank');
    }
    
    async function loadProxyStatus() {
        try {
            const response = await fetch('/api/proxy/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            
            const data = await response.json();
            
            if (data.success || data.tunnel !== undefined) {
                const statusText = document.getElementById('proxy-status-text');
                const statusDisplay = document.getElementById('proxy-status-display');
                
                if (data.running && data.cfRunning) {
                    statusText.textContent = "运行中";
                    statusText.className = "text-xs font-bold proxy-status-running";
                } else {
                    statusText.textContent = "未运行";
                    statusText.className = "text-xs font-bold proxy-status-stopped";
                }
                
                document.getElementById('proxy-current-tunnel').textContent = data.tunnel || "未连接";
                document.getElementById('proxy-current-type').textContent = data.info.type || "未配置";
                document.getElementById('proxy-current-uuid').textContent = data.info.uuid ? 
                    data.info.uuid.substring(0, 8) + "..." : "未配置";
                
                if (data.info.type) {
                    document.getElementById('proxy-type').value = data.info.type;
                }
                if (data.info.uuid) {
                    document.getElementById('proxy-uuid').value = data.info.uuid;
                }
            }
        } catch (error) {
            console.error('加载代理服务器状态失败:', error);
        }
    }
    
    async function deployProxy() {
        const type = document.getElementById('proxy-type').value;
        const uuid = document.getElementById('proxy-uuid').value;
        
        if (!type || !uuid) {
            alert('请填写节点协议和UUID');
            return;
        }
        
        try {
            const response = await fetch('/api/proxy/deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, uuid })
            });
            
            const data = await response.json();
            if (data.success) {
                alert('代理节点部署成功！xray_config.json 文件将在1分钟后自动删除');
                loadProxyStatus();
                hideProxyModal();
            } else {
                alert('部署失败: ' + (data.message || '未知错误'));
            }
        } catch (error) {
            alert('请求失败: ' + error.message);
        }
    }
    
    // ==================== 哪吒探针功能 ====================
    
    function showNezhaModal() {
        const modal = document.getElementById('nezha-modal');
        modal.classList.remove('hidden');
        loadNezhaStatus();
    }
    
    function hideNezhaModal() {
        const modal = document.getElementById('nezha-modal');
        modal.classList.add('hidden');
    }
    
    async function loadNezhaStatus() {
        try {
            const response = await fetch('/api/nezha/config');
            const data = await response.json();
            
            if (data.success) {
                const config = data.config;
                const status = data.status;
                
                const statusText = document.getElementById('nezha-status-text');
                const statusDisplay = document.getElementById('nezha-status-display');
                const stopBtn = document.getElementById('nezha-stop-btn');
                
                if (status === "运行中") {
                    statusText.textContent = "运行中";
                    statusText.className = "text-xs font-bold nezha-status-running";
                    stopBtn.classList.remove('hidden');
                } else {
                    statusText.textContent = "未运行";
                    statusText.className = "text-xs font-bold nezha-status-stopped";
                    stopBtn.classList.add('hidden');
                }
                
                document.getElementById('nezha-current-addr').textContent = config.addr || "未配置";
                document.getElementById('nezha-current-key').textContent = config.key ? "***" + config.key.slice(-4) : "未配置";
                document.getElementById('nezha-current-tls').textContent = config.tls ? "是" : "否";
                
                document.getElementById('nezha-addr').value = config.addr || "";
                document.getElementById('nezha-key').value = config.key || "";
                document.getElementById('nezha-tls').checked = config.tls || false;
            }
        } catch (error) {}
    }
    
    async function saveNezhaConfig() {
        const addr = document.getElementById('nezha-addr').value.trim();
        const key = document.getElementById('nezha-key').value.trim();
        const tls = document.getElementById('nezha-tls').checked;
        
        if (!addr || !key) {
            alert('请填写面板地址和密钥');
            return;
        }
        
        try {
            const response = await fetch('/api/nezha/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ addr, key, tls })
            });
            
            const data = await response.json();
            if (data.success) {
                alert('哪吒探针配置已保存并启动');
                hideNezhaModal();
                loadNezhaStatus();
            } else {
                alert('保存失败: ' + data.message);
            }
        } catch (error) {
            alert('请求失败: ' + error.message);
        }
    }
    
    async function stopNezha() {
        if (!confirm('确定要停止哪吒探针吗？')) return;
        
        try {
            const response = await fetch('/api/nezha/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            
            const data = await response.json();
            if (data.success) {
                alert('哪吒探针已停止');
                loadNezhaStatus();
            } else {
                alert('停止失败: ' + data.message);
            }
        } catch (error) {
            alert('请求失败: ' + error.message);
        }
    }
    
    // ==================== 机器人页面功能 ====================
    
    async function updateUI() {
        try {
            const r = await fetch('/api/bots'); 
            const d = await r.json();
            const container = document.getElementById('list');
            
            document.getElementById('bot-count').innerText = d.bots.length;
            
            d.bots.forEach(b => {
                let card = document.getElementById('card-' + b.id);
                if (!card) {
                    card = document.createElement('div'); 
                    card.id = 'card-' + b.id;
                    container.appendChild(card); 
                    renderCardBase(card, b);
                }
                
                const isOnline = b.status === "在线";
                
                const fullStatus = card.querySelector('.full-view-status');
                if (fullStatus) {
                    fullStatus.innerText = b.status;
                    fullStatus.className = \`full-view-status text-[10px] font-black \${isOnline ? 'status-online' : 'status-offline'}\`;
                }
                
                const simpleStatus = card.querySelector('.simplified-view-status');
                if (simpleStatus) {
                    simpleStatus.innerText = b.status;
                    simpleStatus.className = \`simplified-view-status text-xs font-bold \${isOnline ? 'text-emerald-400' : 'text-red-400'}\`;
                }
                
                const dot = card.querySelector('.simplified-status-dot');
                if (dot) {
                    dot.className = \`w-2 h-2 rounded-full \${isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'} simplified-status-dot\`;
                }
                
                updateCookieSimilarityIndicator(card, b);
                
                const lb = card.querySelector('.log-box');
                const html = b.logs.map(l => '<div class="mb-1.5 ' + l.color + '"><span class="opacity-30 mr-2">[' + l.time + ']</span>' + l.msg + '</div>').join('');
                const h = html.length + (b.logs[0]?.msg || "");
                if (logHashes.get(b.id) !== h) { 
                    lb.innerHTML = html; 
                    logHashes.set(b.id, h); 
                }
                if (document.activeElement.tagName !== 'INPUT' && !card.dataset.lock) syncBtnStyle(card, b.settings);
            });
            
            updateBulkButtonState();
        } catch(e){}
    }
    
    function updateCookieSimilarityIndicator(card, botData) {
        const similarityIndicator = card.querySelector('.cookie-similarity-indicator');
        const similarityText = card.querySelector('.cookie-similarity-text');
        
        if (!similarityIndicator || !similarityText) return;
        
        const lastSuccessCookie = botData.lastSuccessCookie || "";
        const currentCookie = botData.settings?.renew?.cookie || "";
        
        if (!lastSuccessCookie || !currentCookie) {
            similarityIndicator.className = 'similarity-indicator similarity-bad';
            similarityText.innerText = '无历史Cookie';
            similarityText.className = 'cookie-similarity-text text-[9px] text-slate-500';
            return;
        }
        
        similarityIndicator.className = 'similarity-indicator similarity-warning';
        similarityText.innerText = '点击检测相似度';
        similarityText.className = 'cookie-similarity-text text-[9px] text-yellow-400 cursor-pointer';
        similarityText.onclick = () => checkCookieSimilarity(botData.id, similarityIndicator, similarityText);
    }
    
    async function checkCookieSimilarity(botId, indicator, textElement) {
        try {
            textElement.innerText = '检测中...';
            textElement.className = 'cookie-similarity-text text-[9px] text-blue-400';
            
            const response = await fetch(\`/api/bots/\${botId}/check-cookie-similarity\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            
            const data = await response.json();
            
        if (data.success) {
                const similarity = data.similarity;
                
                if (similarity >= 90) {
                    indicator.className = 'similarity-indicator similarity-good';
                    textElement.className = 'cookie-similarity-text text-[9px] text-emerald-400';
                } else if (similarity >= 70) {
                    indicator.className = 'similarity-indicator similarity-warning';
                    textElement.className = 'cookie-similarity-text text-[9px] text-yellow-400';
                } else {
                    indicator.className = 'similarity-indicator similarity-bad';
                    textElement.className = 'cookie-similarity-text text-[9px] text-red-400';
                }
                
                textElement.innerText = \`相似度: \${similarity}%\`;
                textElement.title = data.message;
            } else {
                indicator.className = 'similarity-indicator similarity-bad';
                textElement.className = 'cookie-similarity-text text-[9px] text-red-400';
                textElement.innerText = '检测失败';
                textElement.title = data.message || '未知错误';
            }
        } catch (error) {
            indicator.className = 'similarity-indicator similarity-bad';
            textElement.className = 'cookie-similarity-text text-[9px] text-red-400';
            textElement.innerText = '请求失败';
            textElement.title = error.message;
        }
    }
    
    function syncBtnStyle(card, s) {
        card.querySelector('.btn-ai').className = "btn-ai btn-action py-2 rounded-xl text-[10px] font-bold " + (s.ai?"bg-blue-600":"bg-slate-800");
        card.querySelector('.btn-walk').className = "btn-walk btn-action py-2 rounded-xl text-[10px] font-bold " + (s.walk?"bg-emerald-600":"bg-slate-800");
        card.querySelector('.btn-chat').className = "btn-chat btn-action py-2 rounded-xl text-[10px] font-bold " + (s.chat?"bg-orange-600":"bg-slate-800");
    }
    
    function renderCardBase(card, b) {
        card.className = "robot-card expanded glass rounded-[2rem] p-5 border-t-4 border-t-blue-500 mb-4 transition-all";
        const renewUrl = b.settings.renew.renewUrl || b.settings.renew.url || "";
        const loginUrl = b.settings.renew.loginUrl || "";
        const username = b.settings.renew.username || "";
        const password = b.settings.renew.password || "";
        const cookie = b.settings.renew.cookie || "";
        const method = b.settings.renew.method || "GET";
        const requestBody = b.settings.renew.requestBody || "";
        const customHeaders = b.settings.renew.customHeaders || "";
        const lastSuccessCookie = b.lastSuccessCookie || "";
        
        card.innerHTML = \`
            <div class="flex justify-between mb-4">
                <div>
                    <h3 class="font-bold text-lg">\${b.username}</h3>
                    <p class="text-[10px] text-slate-400">\${b.targetHost}:\${b.targetPort}</p>
                </div>
                <div class="flex items-center gap-2">
                    <span class="full-view-status status-text text-[10px] font-black">离线</span>
                    <button onclick="toggleRobotCard('\${b.id}', this)" class="minimize-btn" title="缩小视图">−</button>
                    <button onclick="removeBot('\${b.id}')" class="text-slate-600 text-xs hover:text-white">✕</button>
                </div>
            </div>
            
            <!-- 原有的完整视图 -->
            <div id="full-view-\${b.id}" class="full-view">
                <div class="bg-cyan-950/20 p-4 rounded-3xl mb-4 border border-cyan-500/20 shadow-inner">
                    <div class="flex justify-between items-center mb-2">
                        <span class="text-[10px] font-bold text-cyan-400 uppercase italic">高级自动续期 (DOM扫描+网络监听)</span>
                        <div class="flex items-center gap-2">
                            <select id="re-method-\${b.id}" class="bg-slate-800 text-[10px] rounded-xl px-2 py-1 outline-none">
                                <option value="GET" \${method === 'GET' ? 'selected' : ''}>GET</option>
                                <option value="POST" \${method === 'POST' ? 'selected' : ''}>POST</option>
                                <option value="PUT" \${method === 'PUT' ? 'selected' : ''}>PUT</option>
                            </select>
                            <input type="checkbox" id="re-en-\${b.id}" \${b.settings.renew.enabled?"checked":""} onchange="showRenewTip('\${b.id}', this.checked)">
                        </div>
                    </div>
                    <input id="re-url-\${b.id}" placeholder="续期接口 URL（可自动检测）" value="\${renewUrl}" class="w-full rounded-xl px-2 py-1 text-[10px] mb-1 outline-none">
                    
                    <!-- Cookie相似度指示器 -->
                    <div class="mb-2">
                        <div class="flex justify-between items-center mb-1">
                            <span class="text-[9px] text-slate-400">Cookie相似度检测</span>
                            <div class="flex items-center gap-2">
                                <div class="cookie-similarity-indicator similarity-indicator similarity-bad w-16"></div>
                                <span class="cookie-similarity-text text-[9px] text-slate-500 cursor-pointer" 
                                      onclick="checkCookieSimilarity('\${b.id}', this.previousElementSibling, this)">
                                    点击检测
                                </span>
                            </div>
                        </div>
                    </div>
                    
                    <div class="mb-2">
                        <button onclick="this.nextElementSibling.classList.toggle('hidden')" class="btn-action w-full bg-cyan-900/40 text-[9px] py-1 rounded-lg text-cyan-300 mb-1">基础请求配置 ▾</button>
                        <div>
                            <textarea id="re-ck-\${b.id}" placeholder="Cookie（自动抓取/手动填写）" class="w-full h-10 rounded-lg px-2 py-1 text-[10px] mb-2 outline-none">\${cookie}</textarea>
                            <textarea id="re-headers-\${b.id}" placeholder="自定义请求头（格式：key1:value1\\nkey2:value2）" class="w-full h-8 rounded-lg px-2 py-1 text-[10px] mb-1 outline-none">\${customHeaders}</textarea>
                            <textarea id="re-body-\${b.id}" placeholder="自定义请求体（JSON 格式优先，仅 POST/PUT 生效）" class="w-full h-12 rounded-lg px-2 py-1 text-[10px] mb-2 outline-none">\${requestBody}</textarea>
                        </div>
                    </div>
                    <div class="mb-2">
                        <button onclick="this.nextElementSibling.classList.toggle('hidden')" class="btn-action w-full bg-cyan-900/40 text-[9px] py-1 rounded-lg text-cyan-300 mb-1">🔍 高级抓取配置（带相似度检测）▾</button>
                        <div class="hidden space-y-1">
                            <input id="re-lurl-\${b.id}" placeholder="登录地址（必填，关联Cookie抓取位置）" value="\${loginUrl}" class="w-full rounded px-2 py-1 text-[10px] mb-1">
                            <input id="re-user-\${b.id}" placeholder="登录用户名（必填）" value="\${username}" class="w-full rounded px-2 py-1 text-[10px] mb-1">
                            <input id="re-pass-\${b.id}" type="password" placeholder="登录密码（必填）" value="\${password}" class="w-full rounded px-2 py-1 text-[10px] mb-1">
                            <button onclick="fetchCookieWithSimilarity('\${b.id}', this)" class="btn-action w-full bg-purple-600/50 py-1 rounded text-[10px] font-bold">✨ 高级检测模式（带Cookie相似度验证）</button>
                            <div class="text-[8px] text-slate-400 p-1 bg-slate-900/30 rounded">
                                <span class="text-emerald-400">✓</span> 自动检测与上次成功Cookie的相似度<br>
                                <span class="text-yellow-400">⚠</span> 低于90%会提示验证<br>
                                <span class="text-cyan-400">ⓘ</span> 确保Cookie有效性
                            </div>
                        </div>
                    </div>
                    <button onclick="saveRenew('\${b.id}')" class="btn-action w-full bg-cyan-600 py-1.5 rounded-xl text-[10px] font-bold">保存设置并测试</button>
                </div>
                <div class="grid grid-cols-3 gap-2 mb-4">
                    <button onclick="toggle('\${b.id}','ai',this)" class="btn-ai btn-action py-2 rounded-xl text-[10px] font-bold \${b.settings.ai?'bg-blue-600':'bg-slate-800'}">AI视角</button>
                    <button onclick="toggle('\${b.id}','walk',this)" class="btn-walk btn-action py-2 rounded-xl text-[10px] font-bold \${b.settings.walk?'bg-emerald-600':'bg-slate-800'}">巡逻模式</button>
                    <button onclick="toggle('\${b.id}','chat',this)" class="btn-chat btn-action py-2 rounded-xl text-[10px] font-bold \${b.settings.chat?'bg-orange-600':'bg-slate-800'}">自动喊话</button>
                </div>
                <div class="bg-slate-900/50 p-4 rounded-3xl border border-slate-800 mb-4">
                    <div class="grid grid-cols-2 gap-2 mb-2">
                        <div><input id="min-\${b.id}" type="number" placeholder="分" class="w-full rounded px-2 py-1 text-[10px]"><button onclick="setTimer('\${b.id}',document.getElementById('min-\${b.id}').value,'min')" class="btn-action w-full mt-1 bg-slate-800 py-1 rounded text-[8px] font-bold">设分</button></div>
                        <div><input id="hour-\${b.id}" type="number" placeholder="时" class="w-full rounded px-2 py-1 text-[10px]"><button onclick="setTimer('\${b.id}',document.getElementById('hour-\${b.id}').value,'hour')" class="btn-action w-full mt-1 bg-slate-800 py-1 rounded text-[8px] font-bold">设时</button></div>
                    </div>
                    <button onclick="restartNow('\${b.id}')" class="btn-action w-full bg-red-600 py-2 rounded-xl text-xs font-bold uppercase">⚡ 立即指令重启</button>
                </div>
                <div class="bg-black/40 p-4 rounded-3xl mb-4 border border-slate-800 text-[10px]">
                    <input id="pto-url-\${b.id}" placeholder="面板 URL" value="\${b.settings.pterodactyl?.url||''}" class="w-full rounded px-2 py-1 mb-1 outline-none">
                    <div class="flex gap-1 mb-1">
                        <input id="pto-sid-\${b.id}" placeholder="ID" value="\${b.settings.pterodactyl?.id||''}" class="flex-1 rounded px-2 py-1 outline-none">
                        <input id="pto-ddir-\${b.id}" placeholder="/" value="\${b.settings.pterodactyl?.defaultDir||'/'}" class="flex-1 rounded px-2 py-1 outline-none">
                    </div>
                    <input id="pto-key-\${b.id}" type="password" placeholder="Key" value="\${b.settings.pterodactyl?.key||''}" class="w-full rounded px-2 py-1 mb-2 outline-none">
                    <div class="flex gap-2">
                        <button onclick="savePto('\${b.id}')" class="btn-action flex-1 bg-slate-800 py-1.5 rounded-lg font-bold">存凭据</button>
                        <button onclick="document.getElementById('f-\${b.id}').click()" class="btn-action flex-1 bg-indigo-600 py-1.5 rounded-lg font-bold">同步文件</button>
                        <input type="file" id="f-\${b.id}" class="hidden" onchange="uploadFile('\${b.id}', this)">
                    </div>
                </div>
                <div class="log-box bg-[#020617] rounded-2xl p-4 h-48 overflow-y-auto border-2 border-blue-500/40"></div>
            </div>
            
            <!-- 新增：简化视图（默认隐藏） -->
            <div id="simplified-view-\${b.id}" class="simplified-view" style="display: none;">
                <div class="connection-card p-4 sm:p-6 mb-4">
                    <div class="text-center mb-4">
                        <div class="inline-block p-3 rounded-2xl bg-blue-500/10 border border-blue-500/20 mb-2">
                            <span class="text-2xl">🤖</span>
                        </div>
                        <h3 class="text-lg font-bold text-white mb-1 truncate max-w-full px-2" 
                            title="\${b.username}">
                            \${b.username}
                        </h3>
                        <div class="flex items-center justify-center gap-2">
                            <div class="w-2 h-2 rounded-full \${b.status==='在线'?'bg-emerald-500 animate-pulse':'bg-red-500'} simplified-status-dot"></div>
                            <span class="simplified-view-status status-text text-xs font-bold \${b.status==='在线'?'text-emerald-400':'text-red-400'}">
                                \${b.status}
                            </span>
                        </div>
                    </div>
                    
                    <div class="space-y-3">
                        <!-- 连接地址 -->
                        <div class="info-item">
                            <div class="text-[10px] text-slate-400 mb-1 flex items-center gap-1">
                                <span>🌐</span>
                                <span>连接地址</span>
                            </div>
                            <div class="ip-port-display text-sm font-mono truncate max-w-full" 
                                 title="\${b.targetHost}:\${b.targetPort}">
                                \${b.targetHost}:\${b.targetPort}
                            </div>
                        </div>
                        
                        <!-- 玩家名称 -->
                        <div class="info-item">
                            <div class="text-[10px] text-slate-400 mb-1 flex items-center gap-1">
                                <span>👤</span>
                                <span>玩家名称</span>
                            </div>
                            <div class="player-display text-sm truncate max-w-full" 
                                 title="\${b.username}">
                                \${b.username}
                            </div>
                        </div>
                        
                        <!-- Cookie状态 -->
                        <div class="info-item">
                            <div class="text-[10px] text-slate-400 mb-1 flex items-center gap-1">
                                <span>🍪</span>
                                <span>Cookie状态</span>
                            </div>
                            <div class="flex items-center justify-between">
                                <span class="text-xs \${b.settings.renew.cookie?'text-emerald-400':'text-red-400'}">
                                    \${b.settings.renew.cookie?'已配置':'未配置'}
                                </span>
                                <span class="text-xs text-slate-400">
                                    \${b.lastSuccessCookie?'有历史':'无历史'}
                                </span>
                            </div>
                        </div>
                        
                        <!-- 功能状态 -->
                        <div class="info-item">
                            <div class="text-[10px] text-slate-400 mb-1 flex items-center gap-1">
                                <span>📊</span>
                                <span>功能状态</span>
                            </div>
                            <div class="flex items-center gap-2 flex-wrap">
                                <span class="text-xs px-2 py-1 rounded \${b.settings.ai?'bg-blue-500/20 text-blue-400':'bg-slate-800/30 text-slate-500'}">AI</span>
                                <span class="text-xs px-2 py-1 rounded \${b.settings.walk?'bg-emerald-500/20 text-emerald-400':'bg-slate-800/30 text-slate-500'}">巡逻</span>
                                <span class="text-xs px-2 py-1 rounded \${b.settings.chat?'bg-orange-500/20 text-orange-400':'bg-slate-800/30 text-slate-500'}">喊话</span>
                                <span class="text-xs px-2 py-1 rounded \${b.settings.renew.enabled?'bg-cyan-500/20 text-cyan-400':'bg-slate-800/30 text-slate-500'}">续期</span>
                            </div>
                        </div>
                    </div>
                    
                    <div class="mt-6 pt-4 border-t border-slate-700/50">
                        <div class="text-[9px] text-slate-500 text-center">
                            点击上方 <span class="text-blue-400 font-bold">−</span> 按钮返回完整视图
                        </div>
                    </div>
                </div>
            </div>
        \`;
    }
    
    // ==================== 简化视图功能函数 ====================
    
    function toggleRobotCard(botId, buttonElement) {
        const fullView = document.getElementById(\`full-view-\${botId}\`);
        const simplifiedView = document.getElementById(\`simplified-view-\${botId}\`);
        const card = document.getElementById(\`card-\${botId}\`);
        
        if (!fullView || !simplifiedView || !card) return;
        
        const isSimplified = fullView.style.display === 'none';
        
        if (isSimplified) {
            fullView.style.display = 'block';
            simplifiedView.style.display = 'none';
            buttonElement.textContent = '−';
            buttonElement.title = '缩小视图';
            card.classList.remove('minimized');
            card.classList.add('expanded');
        } else {
            fullView.style.display = 'none';
            simplifiedView.style.display = 'block';
            buttonElement.textContent = '+';
            buttonElement.title = '展开视图';
            card.classList.add('minimized');
            card.classList.remove('expanded');
        }
        
        updateBulkButtonState();
    }
    
    function toggleAllRobotCards() {
        const cards = document.querySelectorAll('.robot-card');
        const bulkButton = document.getElementById('bulk-view-btn');
        
        if (cards.length === 0) return;
        
        let allSimplified = true;
        cards.forEach(card => {
            const botId = card.id.replace('card-', '');
            const fullView = document.getElementById(\`full-view-\${botId}\`);
            if (fullView && fullView.style.display !== 'none') {
                allSimplified = false;
            }
        });
        
        cards.forEach(card => {
            const botId = card.id.replace('card-', '');
            const button = card.querySelector(\`.minimize-btn[onclick*="toggleRobotCard('\${botId}'"]\`);
            const fullView = document.getElementById(\`full-view-\${botId}\`);
            const simplifiedView = document.getElementById(\`simplified-view-\${botId}\`);
            
            if (button && fullView && simplifiedView) {
                if (allSimplified) {
                    fullView.style.display = 'block';
                    simplifiedView.style.display = 'none';
                    button.textContent = '−';
                    button.title = '缩小视图';
                    card.classList.remove('minimized');
                    card.classList.add('expanded');
                } else {
                    fullView.style.display = 'none';
                    simplifiedView.style.display = 'block';
                    button.textContent = '+';
                    button.title = '展开视图';
                    card.classList.add('minimized');
                    card.classList.remove('expanded');
                }
            }
        });
        
        allCardsSimplified = !allSimplified;
        if (bulkButton) {
            bulkButton.innerHTML = allCardsSimplified ? 
                '<span class="text-sm">📱 全部展开</span>' : 
                '<span class="text-sm">📱 全部简化</span>';
            bulkButton.title = allCardsSimplified ? 
                '展开所有机器人卡片' : 
                '简化所有机器人卡片';
        }
    }
    
    function updateBulkButtonState() {
        const cards = document.querySelectorAll('.robot-card');
        const bulkButton = document.getElementById('bulk-view-btn');
        
        if (!cards.length || !bulkButton) return;
        
        let allSimplified = true;
        let allExpanded = true;
        
        cards.forEach(card => {
            const botId = card.id.replace('card-', '');
            const fullView = document.getElementById(\`full-view-\${botId}\`);
            if (fullView) {
                if (fullView.style.display !== 'none') {
                    allSimplified = false;
                } else {
                    allExpanded = false;
                }
            }
        });
        
        if (allSimplified) {
            bulkButton.innerHTML = '<span class="text-sm">📱 全部展开</span>';
            bulkButton.title = '展开所有机器人卡片';
            allCardsSimplified = true;
        } else if (allExpanded) {
            bulkButton.innerHTML = '<span class="text-sm">📱 全部简化</span>';
            bulkButton.title = '简化所有机器人卡片';
            allCardsSimplified = false;
        } else {
            bulkButton.innerHTML = '<span class="text-sm">📱 统一视图</span>';
            bulkButton.title = '将所有卡片设置为相同视图';
        }
    }
    
    // ==================== 原有功能函数 ====================
    
    function showRenewTip(id, isChecked) {
        const card = document.getElementById('card-' + id);
        const logBox = card.querySelector('.log-box');
        const tipText = isChecked ? "⚠️ 已勾选自动续期，点击「保存设置并测试」即可正式开启" : "⚠️ 已取消自动续期，点击「保存设置并测试」即可正式关闭";
        const tipColor = isChecked ? "text-yellow-400" : "text-slate-400";
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        const tipHtml = '<div class="mb-1.5 ' + tipColor + '"><span class="opacity-30 mr-2">[' + time + ']</span>' + tipText + '</div>';
        logBox.innerHTML = tipHtml + logBox.innerHTML;
    }
    
    async function saveRenew(id) { 
        const btn = document.querySelector(\`#card-\${id} button[onclick*="saveRenew"]\`);
        const oldText = btn.innerText;
        const d = { 
            enabled: document.getElementById('re-en-'+id).checked, 
            renewUrl: document.getElementById('re-url-'+id).value, 
            loginUrl: document.getElementById('re-lurl-'+id).value, 
            username: document.getElementById('re-user-'+id).value, 
            password: document.getElementById('re-pass-'+id).value,
            cookie: document.getElementById('re-ck-'+id).value,
            method: document.getElementById('re-method-'+id).value,
            requestBody: document.getElementById('re-body-'+id).value,
            customHeaders: document.getElementById('re-headers-'+id).value
        }; 
        btn.innerText = "⏳ 正在同步并测试...";
        try {
            const res = await fetch('/api/bots/'+id+'/renew-config', { 
                method: 'POST', 
                headers: {'Content-Type': 'application/json'}, 
                body: JSON.stringify(d)
            }); 
            if(res.ok) { 
                btn.innerText = "✅ 已保存并触发测试"; 
                setTimeout(() => btn.innerText = oldText, 2500); 
            }
        } catch (e) {
            btn.innerText = "❌ 保存失败";
            setTimeout(() => btn.innerText = oldText, 2500);
        }
    }
    
    async function addBot() { 
        const host = document.getElementById('h').value;
        const username = document.getElementById('u').value;
        if (!host || !username) {
            alert('请填写IP:端口和角色名');
            return;
        }
        await fetch('/api/bots', { 
            method: 'POST', 
            headers: {'Content-Type': 'application/json'}, 
            body: JSON.stringify({ host, username })
        }); 
        updateUI(); 
    }
    
    async function toggle(id, type, btn) { 
        const colors = { ai: 'bg-blue-600', walk: 'bg-emerald-600', chat: 'bg-orange-600' };
        const activeColor = colors[type];
        const isCurrentlyOff = btn.className.includes('bg-slate-800');
        if (isCurrentlyOff) {
            btn.classList.remove('bg-slate-800');
            btn.classList.add(activeColor);
        } else {
            btn.classList.remove(activeColor);
            btn.classList.add('bg-slate-800');
        }
        const card = document.getElementById('card-'+id); card.dataset.lock = "true";
        await fetch('/api/bots/'+id+'/toggle', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ type })}); 
        setTimeout(() => delete card.dataset.lock, 1200);
    }
    
    async function setTimer(id, value, unit) { 
        if (!value || value <= 0) {
            alert('请输入有效的时间值');
            return;
        }
        await fetch('/api/bots/'+id+'/set-timer', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ value, unit })}); 
    }
    
    async function restartNow(id) { 
        if (!confirm('确定要立即重启该机器人吗？')) return;
        await fetch('/api/bots/'+id+'/restart-now', { method: 'POST' }); 
    }
    
    async function fetchCookieWithSimilarity(id, btn) {
        const oldText = btn.innerText;
        btn.innerText = "⏳ 正在启动高级检测（带相似度验证）...";
        btn.disabled = true;
        try {
            const res = await fetch(\`/api/bots/\${id}/fetch-cookie\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await res.json();
            if (data.success) {
                const cookieInput = document.getElementById(\`re-ck-\${id}\`);
                if (cookieInput) {
                    cookieInput.value = data.cookie;
                    
                    const card = document.getElementById(\`card-\${id}\`);
                    const similarityText = card.querySelector('.cookie-similarity-text');
                    const similarityIndicator = card.querySelector('.cookie-similarity-indicator');
                    
                    if (similarityText && similarityIndicator) {
                        similarityText.innerText = \`相似度: \${data.similarity || '检测中'}\`;
                        if (data.similarity) {
                            const similarityPercent = parseInt(data.similarity) || 0;
                            if (similarityPercent >= 90) {
                                similarityIndicator.className = 'similarity-indicator similarity-good';
                                similarityText.className = 'cookie-similarity-text text-[9px] text-emerald-400';
                            } else if (similarityPercent >= 70) {
                                similarityIndicator.className = 'similarity-indicator similarity-warning';
                                similarityText.className = 'cookie-similarity-text text-[9px] text-yellow-400';
                            } else {
                                similarityIndicator.className = 'similarity-indicator similarity-bad';
                                similarityText.className = 'cookie-similarity-text text-[9px] text-red-400';
                            }
                        }
                    }
                }
                await updateUI();
            }
        } catch (err) {
        } finally {
            btn.innerText = oldText;
            btn.disabled = false;
        }
    }
    
    async function savePto(id) { 
        const d = { 
            url: document.getElementById('pto-url-'+id).value, 
            id: document.getElementById('pto-sid-'+id).value, 
            key: document.getElementById('pto-key-'+id).value, 
            defaultDir: document.getElementById('pto-ddir-'+id).value 
        }; 
        await fetch('/api/bots/'+id+'/pto-config', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(d)}); 
        alert('翼龙面板凭据已保存'); 
    }
    
    async function uploadFile(id, el) { 
        if(!el.files[0]) return; 
        const f = new FormData(); 
        f.append('file', el.files[0]); 
        await fetch('/api/bots/'+id+'/upload', { method: 'POST', body: f }); 
        el.value = ''; 
    }
    
    async function updateSys() { 
        try { 
            const r = await fetch('/api/system/status'); 
            const d = await r.json(); 
            document.getElementById('cpu-val').innerText = d.cpu + '%'; 
            document.getElementById('mem-val').innerText = d.ram + '%'; 
            document.getElementById('disk-val').innerText = d.disk; 
        } catch(e){} 
    }
    
    async function removeBot(id) { 
        if(confirm('确定要彻底移除该机器人吗？此操作不可撤销！')) { 
            await fetch('/api/bots/'+id, { method: 'DELETE' }); 
            document.getElementById('card-'+id).remove(); 
            updateBulkButtonState();
        } 
    }
    
    // ==================== 任务中心功能函数（增强版） ====================
    
    // 页面切换
    function showPage(pageId) {
        const robotPage = document.getElementById('robot-page');
        const taskCenterPage = document.getElementById('task-center-page');
        const navRobot = document.getElementById('nav-robot');
        const navTask = document.getElementById('nav-task');
        
        if (pageId === 'robot-page') {
            robotPage.classList.remove('hidden');
            taskCenterPage.classList.add('hidden');
            navRobot.classList.remove('bg-slate-800');
            navRobot.classList.add('bg-blue-600');
            navTask.classList.remove('bg-blue-600');
            navTask.classList.add('bg-slate-800');
        } else {
            robotPage.classList.add('hidden');
            taskCenterPage.classList.remove('hidden');
            navTask.classList.remove('bg-slate-800');
            navTask.classList.add('bg-blue-600');
            navRobot.classList.remove('bg-blue-600');
            navRobot.classList.add('bg-slate-800');
            
            loadTaskCenter();
        }
    }
    
    // 显示创建任务模态框
    function showCreateTaskModal() {
        const modal = document.getElementById('create-task-modal');
        modal.classList.remove('hidden');
        updateNewTaskTypeConfig();
    }
    
    // 隐藏创建任务模态框
    function hideCreateTaskModal() {
        const modal = document.getElementById('create-task-modal');
        modal.classList.add('hidden');
    }
    
    // 更新新建任务的类型配置（增强版）
    function updateNewTaskTypeConfig(task = null) {
        const type = document.getElementById('new-task-type').value;
        const container = document.getElementById('new-task-type-config');
        let html = '';
        
        // 公共的登录配置字段
        const commonLoginFields = \`
            <div class="login-config-section">
                <h4 class="text-sm font-bold text-slate-300 mb-2">登录配置（可选）</h4>
                <div class="space-y-2">
                    <div>
                        <label class="block text-xs text-slate-400 mb-1">登录URL</label>
                        <input id="login-url" type="url" class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                               placeholder="https://example.com/login" value="\${task?.config?.loginUrl || ''}">
                    </div>
                    <div class="grid grid-cols-2 gap-2">
                        <div>
                            <label class="block text-xs text-slate-400 mb-1">用户名</label>
                            <input id="login-username" type="text" class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                   placeholder="用户名" value="\${task?.config?.username || ''}">
                        </div>
                        <div>
                            <label class="block text-xs text-slate-400 mb-1">密码</label>
                            <input id="login-password" type="password" class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                   placeholder="密码" value="\${task?.config?.password ? '********' : ''}">
                        </div>
                    </div>
                    <div>
                        <label class="block text-xs text-slate-400 mb-1">Cookie（可选，会覆盖登录）</label>
                        <textarea id="login-cookie" rows="2" class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                  placeholder="session=xxx; token=yyy">\${task?.config?.cookie || ''}</textarea>
                    </div>
                    <div class="text-xs text-slate-500">
                        <i class="fas fa-info-circle"></i> 填写Cookie将直接使用，不执行登录流程
                    </div>
                </div>
            </div>
        \`;
        
        switch(type) {
            case 'renew':
                html = \`
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">续期URL *</label>
                            <input id="renew-url" type="url" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                   placeholder="https://example.com/renew" required value="\${task?.config?.renewUrl || ''}">
                        </div>
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">续期方式</label>
                            <select id="renew-method" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm">
                                <option value="auto" \${task?.config?.method === 'auto' ? 'selected' : ''}>自动续期</option>
                                <option value="manual" \${task?.config?.method === 'manual' ? 'selected' : ''}>手动确认</option>
                            </select>
                        </div>
                        \${commonLoginFields}
                    </div>
                \`;
                break;
                
            case 'afk':
                html = \`
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">挂机网址 *</label>
                            <input id="afk-url" type="url" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                   placeholder="https://example.com/dashboard" required value="\${task?.config?.afkUrl || ''}">
                        </div>
                        <div class="grid grid-cols-2 gap-4">
                            <div>
                                <label class="block text-sm text-slate-400 mb-1">AFK时长(分钟)</label>
                                <input id="afk-duration" type="number" min="1" value="\${task?.config?.duration || 30}" 
                                       class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm">
                            </div>
                            <div>
                                <label class="block text-sm text-slate-400 mb-1">AFK动作</label>
                                <select id="afk-action" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm">
                                    <option value="simulate" \${task?.config?.action === 'simulate' ? 'selected' : ''}>模拟活动</option>
                                    <option value="notification" \${task?.config?.action === 'notification' ? 'selected' : ''}>发送通知</option>
                                    <option value="auto-login" \${task?.config?.action === 'auto-login' ? 'selected' : ''}>自动登录保持</option>
                                </select>
                            </div>
                        </div>
                        \${commonLoginFields}
                    </div>
                \`;
                break;
                
            case 'timed-url':
                html = \`
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">目标URL *</label>
                            <input id="target-url" type="url" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                   placeholder="https://example.com" required value="\${task?.config?.targetUrl || ''}">
                        </div>
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">访问方式</label>
                            <select id="access-method" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm">
                                <option value="get" \${task?.config?.method === 'get' ? 'selected' : ''}>GET请求</option>
                                <option value="post" \${task?.config?.method === 'post' ? 'selected' : ''}>POST请求</option>
                                <option value="simulate" \${task?.config?.method === 'simulate' ? 'selected' : ''}>模拟浏览器</option>
                                <option value="with-login" \${task?.config?.method === 'with-login' ? 'selected' : ''}>带登录访问</option>
                            </select>
                        </div>
                        \${commonLoginFields}
                    </div>
                \`;
                break;
                
            case 'pteranodon':
                html = \`
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">Pteranodon URL *</label>
                            <input id="pteranodon-url" type="url" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                   placeholder="https://panel.example.com" required value="\${task?.config?.url || ''}">
                        </div>
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">API Key *</label>
                            <input id="pteranodon-key" type="password" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                   placeholder="请输入API Key" required value="\${task?.config?.apiKey ? '********' : ''}">
                        </div>
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">服务器ID *</label>
                            <input id="pteranodon-server-id" type="text" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                   placeholder="服务器ID" required value="\${task?.config?.serverId || ''}">
                        </div>
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">默认操作</label>
                            <select id="pteranodon-action" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm">
                                <option value="start" \${task?.config?.action === 'start' ? 'selected' : ''}>启动</option>
                                <option value="restart" \${task?.config?.action === 'restart' ? 'selected' : ''}>重启</option>
                                <option value="stop" \${task?.config?.action === 'stop' ? 'selected' : ''}>停止</option>
                                <option value="status" \${task?.config?.action === 'status' ? 'selected' : ''}>状态检查</option>
                                <option value="renew" \${task?.config?.action === 'renew' ? 'selected' : ''}>续期</option>
                            </select>
                        </div>
                        <div class="login-config-section">
                            <h4 class="text-sm font-bold text-slate-300 mb-2">续期配置（可选）</h4>
                            <div class="space-y-2">
                                <div class="flex items-center gap-2">
                                    <input id="pteranodon-renew-enabled" type="checkbox" \${task?.config?.renewEnabled ? 'checked' : ''}>
                                    <label class="text-sm text-slate-400">启用续期功能</label>
                                </div>
                                <div>
                                    <label class="block text-xs text-slate-400 mb-1">续期URL</label>
                                    <input id="pteranodon-renew-url" type="url" class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                           placeholder="https://example.com/renew" value="\${task?.config?.renewUrl || ''}">
                                </div>
                                <div>
                                    <label class="block text-xs text-slate-400 mb-1">续期Cookie</label>
                                    <textarea id="pteranodon-renew-cookie" rows="2" class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                              placeholder="session=xxx; token=yyy">\${task?.config?.renewCookie || ''}</textarea>
                                </div>
                            </div>
                        </div>
                    </div>
                \`;
                break;
                
            case 'discord':
                html = \`
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">消息内容 *</label>
                            <textarea id="discord-message" rows="3" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                      placeholder="输入要发送的Discord消息内容" required>\${task?.config?.message || ''}</textarea>
                        </div>
                        
                        <div class="login-config-section">
                            <h4 class="text-sm font-bold text-slate-300 mb-2">发送方式配置</h4>
                            <div class="space-y-3">
                                <div>
                                    <label class="block text-xs text-slate-400 mb-1">Discord Webhook URL（传统方式）</label>
                                    <input id="discord-webhook" type="url" class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                           placeholder="https://discord.com/api/webhooks/..." value="\${task?.config?.discordWebhookUrl || ''}">
                                    <p class="text-xs text-slate-500 mt-1">从Discord频道设置中获取Webhook URL</p>
                                </div>
                                
                                <div class="border-t border-slate-700 pt-3">
                                    <div class="flex items-center gap-2 mb-2">
                                        <input id="discord-selfbot-mode" type="checkbox" \${task?.config?.discordSelfBotMode ? 'checked' : ''}>
                                        <label class="text-sm text-slate-300 font-medium">启用 Self-bot 模式</label>
                                    </div>
                                    <p class="text-xs text-slate-500 mb-3">Self-bot使用个人账户Token直接发送消息，需要频道ID</p>
                                    
                                    <div id="selfbot-config" class="space-y-2 \${task?.config?.discordSelfBotMode ? '' : 'hidden'}">
                                        <div>
                                            <label class="block text-xs text-slate-400 mb-1">Self-bot Token</label>
                                            <input id="discord-selfbot-token" type="password" class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                                   placeholder="个人账户Token（开发者工具获取）" value="\${task?.config?.discordSelfBotToken ? '********' : ''}">
                                            <p class="text-xs text-slate-500 mt-1">⚠️ 使用Self-bot可能违反Discord服务条款</p>
                                        </div>
                                        <div>
                                            <label class="block text-xs text-slate-400 mb-1">频道ID</label>
                                            <input id="discord-channel-id" type="text" class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                                   placeholder="频道ID（右键频道复制ID）" value="\${task?.config?.discordChannelId || ''}">
                                        </div>
                                    </div>
                                    
                                    <div class="text-xs text-slate-500 bg-slate-900/50 p-2 rounded border border-slate-700">
                                        <p class="font-medium mb-1">配置说明：</p>
                                        <p>1. 传统方式：填写Webhook URL即可，不需要Token和频道ID</p>
                                        <p>2. Self-bot方式：需要个人账户Token和频道ID</p>
                                        <p>3. 优先使用Self-bot方式（如果启用）</p>
                                    </div>
                                </div>
                                
                                <div class="grid grid-cols-2 gap-2">
                                    <div>
                                        <label class="block text-xs text-slate-400 mb-1">发送者名称</label>
                                        <input id="discord-username" type="text" class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                               placeholder="发送者显示名称" value="\${task?.config?.discordUsername || ''}">
                                    </div>
                                    <div>
                                        <label class="block text-xs text-slate-400 mb-1">头像URL</label>
                                        <input id="discord-avatar" type="url" class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                               placeholder="头像图片URL" value="\${task?.config?.discordAvatarUrl || ''}">
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                \`;
                
                // 为Discord Self-bot模式添加切换事件
                setTimeout(() => {
                    const selfbotCheckbox = document.getElementById('discord-selfbot-mode');
                    const selfbotConfig = document.getElementById('selfbot-config');
                    if (selfbotCheckbox && selfbotConfig) {
                        selfbotCheckbox.addEventListener('change', function() {
                            selfbotConfig.classList.toggle('hidden', !this.checked);
                        });
                    }
                }, 100);
                break;

            // 新增：网页自定义点击配置
            case 'web-click':
                html = \`
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">目标网址 *</label>
                            <input id="target-url" type="url" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                   placeholder="https://example.com/dashboard (登录后导航至此)" required value="\${task?.config?.targetUrl || ''}">
                        </div>
                        
                        <div class="login-config-section">
                            <h4 class="text-sm font-bold text-slate-300 mb-2">登录凭据（用于自动登录）</h4>
                            <div class="space-y-2">
                                <div>
                                    <label class="block text-xs text-slate-400 mb-1">登录地址 (URL)</label>
                                    <input id="login-url" type="url" class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                           placeholder="https://example.com/login" value="\${task?.config?.loginUrl || ''}">
                                </div>
                                <div class="grid grid-cols-2 gap-2">
                                    <div>
                                        <label class="block text-xs text-slate-400 mb-1">用户名</label>
                                        <input id="login-username" type="text" class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                               placeholder="用户名" value="\${task?.config?.username || ''}">
                                    </div>
                                    <div>
                                        <label class="block text-xs text-slate-400 mb-1">密码</label>
                                        <input id="login-password" type="password" class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                               placeholder="密码" value="\${task?.config?.password ? '********' : ''}">
                                    </div>
                                </div>
                                <div>
                                    <label class="block text-xs text-slate-400 mb-1">Cookie（可选，如果有则不登录）</label>
                                    <textarea id="login-cookie" rows="2" class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                              placeholder="session=xxx; token=yyy">\${task?.config?.cookie || ''}</textarea>
                                </div>
                            </div>
                        </div>
                        
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">按钮特征词 *</label>
                            <input id="button-text" type="text" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                   placeholder="例如: Reset Time, Submit, 确认提交 (支持智能模糊匹配)" required value="\${task?.config?.buttonText || ''}">
                            <p class="text-xs text-slate-500 mt-1">输入 "reset" 可以匹配 "Reset Time"</p>
                        </div>
                    </div>
                \`;
                break;
        }
        
        container.innerHTML = html;
        
        // 更新定时显示
        if (type === 'pteranodon') {
            updateTimeTotalDisplay();
        }
    }
    
    // 更新定时显示
    function updateTimeTotalDisplay() {
        const minutes = parseInt(document.getElementById('new-task-minutes').value) || 0;
        const hours = parseInt(document.getElementById('new-task-hours').value) || 0;
        const days = parseInt(document.getElementById('new-task-days').value) || 0;
        const totalMinutes = minutes + (hours * 60) + (days * 24 * 60);
        document.getElementById('new-total-interval').textContent = totalMinutes + '分钟';
    }
    
    // 确认创建任务
    async function confirmCreateTask() {
        const name = document.getElementById('new-task-name').value.trim();
        const type = document.getElementById('new-task-type').value;
        
        // 获取定时设置
        const minutes = parseInt(document.getElementById('new-task-minutes').value) || 0;
        const hours = parseInt(document.getElementById('new-task-hours').value) || 0;
        const days = parseInt(document.getElementById('new-task-days').value) || 0;
        const totalMinutes = minutes + (hours * 60) + (days * 24 * 60);
        
        // 如果总分钟数为0，使用默认间隔
        const interval = totalMinutes > 0 ? totalMinutes : (parseInt(document.getElementById('new-task-interval')?.value) || 5);
        
        if (!name) {
            alert('请输入任务名称');
            return;
        }
        
        // 收集配置
        const config = { interval, minutes, hours, days };
        
        switch(type) {
            case 'renew':
                const renewUrl = document.getElementById('renew-url').value;
                if (!renewUrl) {
                    alert('请输入续期URL');
                    return;
                }
                config.renewUrl = renewUrl;
                config.method = document.getElementById('renew-method').value;
                break;
            case 'afk':
                const afkUrl = document.getElementById('afk-url').value;
                if (!afkUrl) {
                    alert('请输入挂机网址');
                    return;
                }
                config.afkUrl = afkUrl;
                config.duration = parseInt(document.getElementById('afk-duration').value) || 30;
                config.action = document.getElementById('afk-action').value;
                break;
            case 'timed-url':
                const targetUrl = document.getElementById('target-url').value;
                if (!targetUrl) {
                    alert('请输入目标URL');
                    return;
                }
                config.targetUrl = targetUrl;
                config.method = document.getElementById('access-method').value;
                break;
            case 'pteranodon':
                const pteranodonUrl = document.getElementById('pteranodon-url').value;
                const apiKey = document.getElementById('pteranodon-key').value;
                const serverId = document.getElementById('pteranodon-server-id').value;
                
                if (!pteranodonUrl || !apiKey || !serverId) {
                    alert('请填写Pteranodon配置信息');
                    return;
                }
                
                config.url = pteranodonUrl;
                config.apiKey = apiKey;
                config.serverId = serverId;
                config.action = document.getElementById('pteranodon-action').value;
                config.renewEnabled = document.getElementById('pteranodon-renew-enabled').checked;
                config.renewUrl = document.getElementById('pteranodon-renew-url').value;
                config.renewCookie = document.getElementById('pteranodon-renew-cookie').value;
                break;
            case 'discord':
                const message = document.getElementById('discord-message').value;
                if (!message) {
                    alert('请输入Discord消息内容');
                    return;
                }
                
                config.message = message;
                config.discordWebhookUrl = document.getElementById('discord-webhook').value;
                config.discordSelfBotMode = document.getElementById('discord-selfbot-mode').checked;
                config.discordSelfBotToken = document.getElementById('discord-selfbot-token').value;
                config.discordChannelId = document.getElementById('discord-channel-id').value;
                config.discordUsername = document.getElementById('discord-username').value;
                config.discordAvatarUrl = document.getElementById('discord-avatar').value;
                
                if (!config.discordWebhookUrl && (!config.discordSelfBotMode || !config.discordSelfBotToken || !config.discordChannelId)) {
                    alert('请配置Discord Webhook URL或启用Self-bot并填写Token和频道ID');
                    return;
                }
                break;
            
            // 新增 Web Click 处理
            case 'web-click':
                const clickTargetUrl = document.getElementById('target-url').value;
                const clickButtonText = document.getElementById('button-text').value;
                
                if (!clickTargetUrl) {
                    alert('请输入目标网址');
                    return;
                }
                if (!clickButtonText) {
                    alert('请输入按钮特征词');
                    return;
                }

                config.targetUrl = clickTargetUrl;
                config.buttonText = clickButtonText;
                
                // 登录信息收集
                config.loginUrl = document.getElementById('login-url').value;
                config.username = document.getElementById('login-username').value;
                config.password = document.getElementById('login-password').value;
                config.cookie = document.getElementById('login-cookie').value;
                break;
        }
        
        // 收集登录配置（如果有的话）
        if (type !== 'pteranodon' && type !== 'discord' && type !== 'web-click') {
            const loginUrl = document.getElementById('login-url')?.value;
            const username = document.getElementById('login-username')?.value;
            const password = document.getElementById('login-password')?.value;
            const cookie = document.getElementById('login-cookie')?.value;
            
            if (loginUrl) config.loginUrl = loginUrl;
            if (username) config.username = username;
            if (password && password !== '********') config.password = password;
            if (cookie) config.cookie = cookie;
        }
        
        try {
            const response = await fetch('/api/task-center/create-task', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name,
                    type,
                    config
                })
            });
            
            const data = await response.json();
            if (data.success) {
                hideCreateTaskModal();
                loadTaskCenter();
            } else {
                alert('创建任务失败: ' + (data.message || '未知错误'));
            }
        } catch (error) {
            alert('请求失败: ' + error.message);
        }
    }
    
    // 加载任务中心
    async function loadTaskCenter() {
        try {
            const response = await fetch('/api/task-center/config');
            taskCenterData = await response.json();
            
            document.getElementById('auto-clear-logs').checked = taskCenterData.settings.autoClearLogs || true;
            document.getElementById('max-log-entries').value = taskCenterData.settings.maxLogEntries || 100;
            document.getElementById('enable-auto-login').checked = taskCenterData.settings.enableAutoLogin || true;
            
            renderTaskList(taskCenterData.tasks);
            updateTaskbar(taskCenterData.tasks);
            
            if (selectedTaskId) {
                const task = taskCenterData.tasks.find(t => t.id === selectedTaskId);
                if (task) {
                    updateTaskDetail(task);
                } else {
                    selectedTaskId = null;
                    resetTaskDetail();
                }
            }
        } catch (error) {}
    }
    
    // 渲染任务列表
    function renderTaskList(tasks) {
        const container = document.getElementById('task-list');
        
        if (!tasks || tasks.length === 0) {
            container.innerHTML = '<div class="text-center text-slate-500 py-8">暂无任务，点击"创建新任务"开始</div>';
            return;
        }
        
        const typeLabels = {
            'renew': '续期',
            'afk': 'AFK',
            'pteranodon': 'Pteranodon',
            'discord': 'Discord',
            'web-click': '网页点击',
            'timed-url': '访问URL'
        };

        container.innerHTML = tasks.map(task => \`
            <div class="task-card p-3 \${selectedTaskId === task.id ? 'selected' : ''}" onclick="selectTask('\${task.id}')">
                <div class="flex justify-between items-center mb-2">
                    <span class="font-bold text-white truncate">\${task.name}</span>
                    <div class="flex items-center gap-2">
                        \${task.lastLoginStatus === '已登录' ? 
                            '<span class="text-xs text-emerald-400" title="已登录"><i class="fas fa-check-circle"></i></span>' : 
                            '<span class="text-xs text-slate-500" title="未登录"><i class="fas fa-times-circle"></i></span>'
                        }
                        <span class="text-xs px-2 py-1 rounded-full \${task.status === 'running' ? 'task-status-running' : 'task-status-stopped'}">
                            \${task.status === 'running' ? '运行中' : '已停止'}
                        </span>
                    </div>
                </div>
                <div class="flex items-center justify-between text-xs text-slate-400">
                    <div class="flex items-center gap-2">
                        <span class="px-2 py-1 rounded bg-slate-900/50">
                            \${typeLabels[task.type] || task.type}
                        </span>
                        <span>\${task.config.interval || 5}分钟</span>
                    </div>
                    <span>\${new Date(task.createdAt).toLocaleDateString()}</span>
                </div>
            </div>
        \`).join('');
    }
    
    // 选择任务
    function selectTask(taskId) {
        selectedTaskId = taskId;
        renderTaskList(taskCenterData.tasks);
        loadTaskDetail(taskId);
    }
    
    // 加载任务详情
    async function loadTaskDetail(taskId) {
        try {
            const response = await fetch('/api/task-center/config');
            taskCenterData = await response.json();
            const task = taskCenterData.tasks.find(t => t.id === taskId);
            
            if (task) {
                updateTaskDetail(task);
            }
        } catch (error) {}
    }
    
    // 更新任务详情（增强版）
    function updateTaskDetail(task) {
        document.getElementById('selected-task-title').textContent = task.name;
        
        const controls = document.getElementById('task-controls');
        controls.classList.remove('hidden');
        
        const toggleBtn = document.getElementById('toggle-task-btn');
        if (task.status === 'running') {
            toggleBtn.innerHTML = '<i class="fas fa-stop"></i> 停止';
            toggleBtn.classList.remove('bg-emerald-600');
            toggleBtn.classList.add('bg-red-600');
        } else {
            toggleBtn.innerHTML = '<i class="fas fa-play"></i> 启动';
            toggleBtn.classList.remove('bg-red-600');
            toggleBtn.classList.add('bg-emerald-600');
        }
        
        // 显示/隐藏测试按钮
        const testLoginBtn = document.getElementById('test-login-btn');
        const testRenewBtn = document.getElementById('test-renew-btn');
        const testPteranodonBtn = document.getElementById('test-pteranodon-btn');
        const testDiscordBtn = document.getElementById('test-discord-btn');
        
        if (task.config.loginUrl || task.config.cookie) {
            testLoginBtn.classList.remove('hidden');
        } else {
            testLoginBtn.classList.add('hidden');
        }
        
        if (task.type === 'renew' && task.config.renewUrl) {
            testRenewBtn.classList.remove('hidden');
        } else {
            testRenewBtn.classList.add('hidden');
        }
        
        if (task.type === 'pteranodon' && task.config.url) {
            testPteranodonBtn.classList.remove('hidden');
        } else {
            testPteranodonBtn.classList.add('hidden');
        }
        
        if (task.type === 'discord' && (task.config.discordWebhookUrl || task.config.discordSelfBotToken)) {
            testDiscordBtn.classList.remove('hidden');
        } else {
            testDiscordBtn.classList.add('hidden');
        }
        
        // 显示/隐藏Pteranodon控制按钮
        const pteranodonControls = document.getElementById('pteranodon-controls');
        if (task.type === 'pteranodon') {
            pteranodonControls.classList.remove('hidden');
        } else {
            pteranodonControls.classList.add('hidden');
        }
        
        document.getElementById('clear-logs-btn').disabled = false;
        
        const configArea = document.getElementById('task-config');
        configArea.classList.remove('hidden');
        
        document.getElementById('task-config-name').value = task.name;
        document.getElementById('task-config-type').value = task.type === 'renew' ? '续期任务' : 
                                                          task.type === 'afk' ? 'AFK任务' : 
                                                          task.type === 'pteranodon' ? 'Pteranodon控制' : 
                                                          task.type === 'discord' ? 'Discord消息' : 
                                                          task.type === 'web-click' ? '网页自定义点击' : '定时访问URL';
        
        // 设置定时输入框
        document.getElementById('task-config-minutes').value = task.config.minutes || 0;
        document.getElementById('task-config-hours').value = task.config.hours || 0;
        document.getElementById('task-config-days').value = task.config.days || 0;
        updateTaskTimeTotalDisplay(task.config);
        
        document.getElementById('task-config-interval').value = task.config.interval || 5;
        document.getElementById('task-config-lastrun').value = task.lastRun ? 
            new Date(task.lastRun).toLocaleString('zh-CN') : '从未运行';
        document.getElementById('task-config-nextrun').value = task.nextRun ? 
            new Date(task.nextRun).toLocaleString('zh-CN') : '未计划';
        
        updateTaskTypeConfig(task);
        updateTaskLogs(task.logs);
        
        // 更新登录状态显示
        const loginStatusSection = document.getElementById('task-login-status');
        const loginStatusBadge = document.getElementById('login-status-badge');
        const loginDetails = document.getElementById('login-details');
        
        if (task.config.loginUrl || task.config.cookie) {
            loginStatusSection.classList.remove('hidden');
            
            if (task.lastLoginStatus === '已登录') {
                loginStatusBadge.innerHTML = '<i class="fas fa-check-circle"></i><span>已登录</span>';
                loginStatusBadge.className = 'login-status login-status-logged';
                loginDetails.innerHTML = \`上次登录时间: \${task.config.lastLoginTime ? new Date(task.config.lastLoginTime).toLocaleString('zh-CN') : '未知'}\`;
            } else {
                loginStatusBadge.innerHTML = '<i class="fas fa-times-circle"></i><span>未登录</span>';
                loginStatusBadge.className = 'login-status login-status-not-logged';
                loginDetails.innerHTML = '上次登录时间: 无';
            }
        } else {
            loginStatusSection.classList.add('hidden');
        }
    }
    
    // 更新任务定时总计显示
    function updateTaskTimeTotalDisplay(config) {
        const minutes = parseInt(config.minutes) || 0;
        const hours = parseInt(config.hours) || 0;
        const days = parseInt(config.days) || 0;
        const totalMinutes = minutes + (hours * 60) + (days * 24 * 60);
        document.getElementById('total-interval').textContent = totalMinutes + '分钟';
    }
    
    // 更新任务类型配置（增强版）
    function updateTaskTypeConfig(task) {
        const container = document.getElementById('task-type-config');
        let html = '';
        
        switch(task.type) {
            case 'renew':
                html = \`
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">续期URL</label>
                            <input type="text" value="\${task.config.renewUrl || ''}" 
                                   class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                   onchange="updateTaskConfig('\${task.id}', 'renewUrl', this.value)">
                        </div>
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">续期方式</label>
                            <select class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                    onchange="updateTaskConfig('\${task.id}', 'method', this.value)">
                                <option value="auto" \${task.config.method === 'auto' ? 'selected' : ''}>自动续期</option>
                                <option value="manual" \${task.config.method === 'manual' ? 'selected' : ''}>手动确认</option>
                            </select>
                        </div>
                    </div>
                \`;
                break;
                
            case 'afk':
                html = \`
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">挂机网址</label>
                            <input type="text" value="\${task.config.afkUrl || ''}" 
                                   class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                   onchange="updateTaskConfig('\${task.id}', 'afkUrl', this.value)">
                        </div>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label class="block text-sm text-slate-400 mb-1">AFK时长(分钟)</label>
                                <input type="number" min="1" value="\${task.config.duration || 30}" 
                                       class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                       onchange="updateTaskConfig('\${task.id}', 'duration', this.value)">
                            </div>
                            <div>
                                <label class="block text-sm text-slate-400 mb-1">AFK动作</label>
                                <select class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                        onchange="updateTaskConfig('\${task.id}', 'action', this.value)">
                                    <option value="simulate" \${task.config.action === 'simulate' ? 'selected' : ''}>模拟活动</option>
                                    <option value="notification" \${task.config.action === 'notification' ? 'selected' : ''}>发送通知</option>
                                    <option value="auto-login" \${task.config.action === 'auto-login' ? 'selected' : ''}>自动登录保持</option>
                                </select>
                            </div>
                        </div>
                    </div>
                \`;
                break;
                
            case 'timed-url':
                html = \`
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">目标URL</label>
                            <input type="text" value="\${task.config.targetUrl || ''}" 
                                   class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                   onchange="updateTaskConfig('\${task.id}', 'targetUrl', this.value)">
                        </div>
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">访问方式</label>
                            <select class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                    onchange="updateTaskConfig('\${task.id}', 'method', this.value)">
                                <option value="get" \${task.config.method === 'get' ? 'selected' : ''}>GET请求</option>
                                <option value="post" \${task.config.method === 'post' ? 'selected' : ''}>POST请求</option>
                                <option value="simulate" \${task.config.method === 'simulate' ? 'selected' : ''}>模拟浏览器</option>
                                <option value="with-login" \${task.config.method === 'with-login' ? 'selected' : ''}>带登录访问</option>
                            </select>
                        </div>
                    </div>
                \`;
                break;
                
            case 'pteranodon':
                html = \`
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">Pteranodon URL</label>
                            <input type="text" value="\${task.config.url || ''}" 
                                   class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                   onchange="updateTaskConfig('\${task.id}', 'url', this.value)">
                        </div>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label class="block text-sm text-slate-400 mb-1">API Key</label>
                                <input type="password" value="\${task.config.apiKey ? '********' : ''}" 
                                       class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                       onchange="updateTaskConfig('\${task.id}', 'apiKey', this.value)">
                            </div>
                            <div>
                                <label class="block text-sm text-slate-400 mb-1">服务器ID</label>
                                <input type="text" value="\${task.config.serverId || ''}" 
                                       class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                       onchange="updateTaskConfig('\${task.id}', 'serverId', this.value)">
                            </div>
                        </div>
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">默认操作</label>
                            <select class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                    onchange="updateTaskConfig('\${task.id}', 'action', this.value)">
                                <option value="start" \${task?.config?.action === 'start' ? 'selected' : ''}>启动</option>
                                <option value="restart" \${task?.config?.action === 'restart' ? 'selected' : ''}>重启</option>
                                <option value="stop" \${task?.config?.action === 'stop' ? 'selected' : ''}>停止</option>
                                <option value="status" \${task?.config?.action === 'status' ? 'selected' : ''}>状态检查</option>
                                <option value="renew" \${task?.config?.action === 'renew' ? 'selected' : ''}>续期</option>
                            </select>
                        </div>
                        <div class="login-config-section">
                            <h4 class="text-sm font-bold text-slate-300 mb-2">续期配置</h4>
                            <div class="space-y-2">
                                <div class="flex items-center gap-2">
                                    <input type="checkbox" \${task.config.renewEnabled ? 'checked' : ''} 
                                           onchange="updateTaskConfig('\${task.id}', 'renewEnabled', this.checked)">
                                    <label class="text-sm text-slate-400">启用续期功能</label>
                                </div>
                                <div>
                                    <label class="block text-xs text-slate-400 mb-1">续期URL</label>
                                    <input type="text" value="\${task.config.renewUrl || ''}" 
                                           class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                           onchange="updateTaskConfig('\${task.id}', 'renewUrl', this.value)">
                                </div>
                                <div>
                                    <label class="block text-xs text-slate-400 mb-1">续期Cookie</label>
                                    <textarea rows="2" class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                              onchange="updateTaskConfig('\${task.id}', 'renewCookie', this.value)">\${task.config.renewCookie || ''}</textarea>
                                </div>
                            </div>
                        </div>
                    </div>
                \`;
                break;
                
            case 'discord':
                html = \`
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">消息内容</label>
                            <textarea rows="3" class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                      onchange="updateTaskConfig('\${task.id}', 'message', this.value)">\${task.config.message || ''}</textarea>
                        </div>
                        
                        <div class="login-config-section">
                            <h4 class="text-sm font-bold text-slate-300 mb-2">发送方式配置</h4>
                            <div class="space-y-3">
                                <div>
                                    <label class="block text-xs text-slate-400 mb-1">Discord Webhook URL</label>
                                    <input type="url" value="\${task.config.discordWebhookUrl || ''}" 
                                           class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                           onchange="updateTaskConfig('\${task.id}', 'discordWebhookUrl', this.value)">
                                </div>
                                
                                <div class="border-t border-slate-700 pt-3">
                                    <div class="flex items-center gap-2 mb-2">
                                        <input type="checkbox" \${task.config.discordSelfBotMode ? 'checked' : ''}
                                               onchange="updateTaskConfig('\${task.id}', 'discordSelfBotMode', this.checked)">
                                        <label class="text-sm text-slate-300 font-medium">启用 Self-bot 模式</label>
                                    </div>
                                    
                                    <div id="selfbot-config-\${task.id}" class="space-y-2 \${task.config.discordSelfBotMode ? '' : 'hidden'}">
                                        <div>
                                            <label class="block text-xs text-slate-400 mb-1">Self-bot Token</label>
                                            <input type="password" value="\${task.config.discordSelfBotToken ? '********' : ''}" 
                                                   class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                                   onchange="updateTaskConfig('\${task.id}', 'discordSelfBotToken', this.value)">
                                        </div>
                                        <div>
                                            <label class="block text-xs text-slate-400 mb-1">频道ID</label>
                                            <input type="text" value="\${task.config.discordChannelId || ''}" 
                                                   class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                                   onchange="updateTaskConfig('\${task.id}', 'discordChannelId', this.value)">
                                        </div>
                                    </div>
                                    
                                    <div class="grid grid-cols-2 gap-2 mt-2">
                                        <div>
                                            <label class="block text-xs text-slate-400 mb-1">发送者名称</label>
                                            <input type="text" value="\${task.config.discordUsername || ''}" 
                                                   class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                                   onchange="updateTaskConfig('\${task.id}', 'discordUsername', this.value)">
                                        </div>
                                        <div>
                                            <label class="block text-xs text-slate-400 mb-1">头像URL</label>
                                            <input type="url" value="\${task.config.discordAvatarUrl || ''}" 
                                                   class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                                   onchange="updateTaskConfig('\${task.id}', 'discordAvatarUrl', this.value)">
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                \`;
                
                // 为Discord Self-bot模式添加切换事件
                setTimeout(() => {
                    const selfbotCheckbox = document.querySelector(\`#selfbot-config-\${task.id} + div input[type="checkbox"]\`);
                    const selfbotConfig = document.getElementById(\`selfbot-config-\${task.id}\`);
                    if (selfbotCheckbox && selfbotConfig) {
                        selfbotCheckbox.addEventListener('change', function() {
                            selfbotConfig.classList.toggle('hidden', !this.checked);
                        });
                    }
                }, 100);
                break;
            
            // 新增 Web Click 详情配置
            case 'web-click':
                html = \`
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">目标网址</label>
                            <input type="text" value="\${task.config.targetUrl || ''}" 
                                   class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                   onchange="updateTaskConfig('\${task.id}', 'targetUrl', this.value)">
                        </div>
                        
                        <div class="login-config-section">
                            <h4 class="text-sm font-bold text-slate-300 mb-2">登录凭据</h4>
                            <div class="space-y-2">
                                <div>
                                    <label class="block text-xs text-slate-400 mb-1">登录URL</label>
                                    <input type="text" value="\${task.config.loginUrl || ''}" 
                                           class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                           onchange="updateTaskConfig('\${task.id}', 'loginUrl', this.value)">
                                </div>
                                <div class="grid grid-cols-2 gap-2">
                                    <div>
                                        <label class="block text-xs text-slate-400 mb-1">用户名</label>
                                        <input type="text" value="\${task.config.username || ''}" 
                                               class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                               onchange="updateTaskConfig('\${task.id}', 'username', this.value)">
                                    </div>
                                    <div>
                                        <label class="block text-xs text-slate-400 mb-1">密码</label>
                                        <input type="password" value="\${task.config.password ? '********' : ''}" 
                                               class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                               onchange="updateTaskConfig('\${task.id}', 'password', this.value)">
                                    </div>
                                </div>
                                <div>
                                    <label class="block text-xs text-slate-400 mb-1">Cookie</label>
                                    <textarea rows="2" class="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                              onchange="updateTaskConfig('\${task.id}', 'cookie', this.value)">\${task.config.cookie || ''}</textarea>
                                </div>
                            </div>
                        </div>
                        
                        <div>
                            <label class="block text-sm text-slate-400 mb-1">按钮特征词</label>
                            <input type="text" value="\${task.config.buttonText || ''}" 
                                   class="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm" 
                                   onchange="updateTaskConfig('\${task.id}', 'buttonText', this.value)">
                        </div>
                    </div>
                \`;
                break;
        }
        
        container.innerHTML = html;
    }
    
    // 更新任务日志
    function updateTaskLogs(logs) {
        const container = document.getElementById('task-log-content');
        
        if (!logs || logs.length === 0) {
            container.innerHTML = '<div class="text-slate-500">暂无日志记录</div>';
            return;
        }
        
        container.innerHTML = logs.map(log => \`
            <div class="mb-2 pb-2 border-b border-slate-800/50 \${getTaskLogColorClass(log.type)}">
                <div class="flex justify-between text-xs text-slate-500 mb-1">
                    <span>[\${log.timestamp}]</span>
                    <span class="px-2 py-0.5 rounded bg-slate-800/50">\${log.type}</span>
                </div>
                <div>\${log.message}</div>
            </div>
        \`).join('');
        
        container.scrollTop = 0;
    }
    
    function getTaskLogColorClass(type) {
        switch(type) {
            case 'success': return 'log-entry-success';
            case 'warning': return 'log-entry-warning';
            case 'error': return 'log-entry-error';
            default: return 'log-entry-info';
        }
    }
    
    // 重置任务详情
    function resetTaskDetail() {
        document.getElementById('selected-task-title').textContent = '选择任务以查看详情';
        document.getElementById('task-controls').classList.add('hidden');
        document.getElementById('task-config').classList.add('hidden');
        document.getElementById('pteranodon-controls').classList.add('hidden');
        document.getElementById('clear-logs-btn').disabled = true;
        document.getElementById('task-log-content').innerHTML = '<div class="text-slate-500">选择一个任务查看日志</div>';
    }
    
    // 切换任务状态
    async function toggleSelectedTask() {
        if (!selectedTaskId) return;
        
        try {
            const response = await fetch(\`/api/task-center/\${selectedTaskId}/toggle\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            
            const data = await response.json();
            if (data.success) {
                loadTaskCenter();
            }
        } catch (error) {
            alert('操作失败: ' + error.message);
        }
    }
    
    // 测试任务登录
    async function testTaskLogin() {
        if (!selectedTaskId) return;
        
        try {
            const response = await fetch(\`/api/task-center/\${selectedTaskId}/test-login\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            
            const data = await response.json();
            if (data.success) {
                alert('登录测试成功！');
                loadTaskDetail(selectedTaskId);
            } else {
                alert('登录测试失败: ' + data.message);
            }
        } catch (error) {
            alert('请求失败: ' + error.message);
        }
    }
    
    // 测试任务续期
    async function testTaskRenew() {
        if (!selectedTaskId) return;
        
        try {
            const response = await fetch(\`/api/task-center/\${selectedTaskId}/test-renew\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            
            const data = await response.json();
            if (data.success) {
                alert('续期测试成功！');
                loadTaskDetail(selectedTaskId);
            } else {
                alert('续期测试失败: ' + data.message);
            }
        } catch (error) {
            alert('请求失败: ' + error.message);
        }
    }
    
    // 测试Pteranodon连接
    async function testTaskPteranodon() {
        if (!selectedTaskId) return;
        
        try {
            const response = await fetch(\`/api/task-center/\${selectedTaskId}/test-pteranodon\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            
            const data = await response.json();
            if (data.success) {
                alert('Pteranodon连接测试成功！');
                loadTaskDetail(selectedTaskId);
            } else {
                alert('Pteranodon连接测试失败: ' + data.message);
            }
        } catch (error) {
            alert('请求失败: ' + error.message);
        }
    }
    
    // 测试Discord消息
    async function testTaskDiscord() {
        if (!selectedTaskId) return;
        
        try {
            const response = await fetch(\`/api/task-center/\${selectedTaskId}/test-discord\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            
            const data = await response.json();
            if (data.success) {
                alert('Discord消息测试成功！');
                loadTaskDetail(selectedTaskId);
            } else {
                alert('Discord消息测试失败: ' + data.message);
            }
        } catch (error) {
            alert('请求失败: ' + error.message);
        }
    }
    
    // 控制Pteranodon服务器
    async function controlPteranodon(action) {
        if (!selectedTaskId) return;
        
        try {
            const response = await fetch(\`/api/task-center/\${selectedTaskId}/control-pteranodon\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action })
            });
            
            const data = await response.json();
            if (data.success) {
                alert(\`Pteranodon \${action} 操作成功！\`);
                loadTaskDetail(selectedTaskId);
            } else {
                alert(\`Pteranodon \${action} 操作失败: \${data.message}\`);
            }
        } catch (error) {
            alert('请求失败: ' + error.message);
        }
    }
    
    // 删除任务
    async function deleteSelectedTask() {
        if (!selectedTaskId || !confirm('确定要删除这个任务吗？此操作不可撤销！')) return;
        
        try {
            const response = await fetch(\`/api/task-center/\${selectedTaskId}\`, {
                method: 'DELETE'
            });
            
            const data = await response.json();
            if (data.success) {
                selectedTaskId = null;
                loadTaskCenter();
                resetTaskDetail();
            }
        } catch (error) {
            alert('删除失败: ' + error.message);
        }
    }
    
    // 清理任务日志
    async function clearSelectedTaskLogs() {
        if (!selectedTaskId) return;
        
        try {
            const response = await fetch(\`/api/task-center/\${selectedTaskId}/clear-logs\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            
            const data = await response.json();
            if (data.success) {
                loadTaskDetail(selectedTaskId);
            }
        } catch (error) {
            alert('清理日志失败: ' + error.message);
        }
    }
    
    // 更新任务中心设置
    async function updateTaskCenterSettings() {
        const autoClearLogs = document.getElementById('auto-clear-logs').checked;
        const maxLogEntries = parseInt(document.getElementById('max-log-entries').value) || 100;
        const enableAutoLogin = document.getElementById('enable-auto-login').checked;
        
        try {
            const response = await fetch('/api/task-center/update-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    settings: {
                        autoClearLogs,
                        maxLogEntries,
                        enableAutoLogin
                    }
                })
            });
            
            await response.json();
        } catch (error) {}
    }
    
    // 切换任务栏显示
    function toggleTaskbar() {
        const taskbar = document.getElementById('taskbar');
        const toggleBtn = document.getElementById('taskbar-toggle');
        
        taskbarVisible = !taskbarVisible;
        
        if (taskbarVisible) {
            taskbar.classList.remove('hidden');
            toggleBtn.innerHTML = '<i class="fas fa-chevron-down"></i>';
        } else {
            taskbar.classList.add('hidden');
            toggleBtn.innerHTML = '<i class="fas fa-chevron-up"></i>';
        }
    }
    
    // 更新任务栏
    function updateTaskbar(tasks) {
        const runningTasks = tasks.filter(t => t.status === 'running');
        const countElement = document.getElementById('running-task-count');
        const itemsContainer = document.getElementById('taskbar-items');
        
        countElement.textContent = runningTasks.length;
        
        if (runningTasks.length === 0) {
            itemsContainer.innerHTML = '<div class="text-center text-slate-500 py-4">无运行中的任务</div>';
            return;
        }
        
        const typeLabels = {
            'renew': '续期', 'afk': 'AFK', 'pteranodon': 'Pteranodon', 
            'discord': 'Discord', 'web-click': '网页点击', 'timed-url': '访问URL'
        };

        itemsContainer.innerHTML = runningTasks.map(task => \`
            <div class="taskbar-item">
                <div class="flex justify-between items-center mb-1">
                    <span class="text-sm font-bold text-white truncate">\${task.name}</span>
                    <span class="text-xs text-emerald-400 animate-pulse">●</span>
                </div>
                <div class="flex justify-between text-xs text-slate-400">
                    <span>\${typeLabels[task.type] || task.type}</span>
                    <span>\${task.config.interval || 5}分钟</span>
                </div>
            </div>
        \`).join('');
    }
    
    // 更新任务配置
    async function updateTaskConfig(key, value) {
        if (!selectedTaskId) return;
        
        try {
            const response = await fetch('/api/task-center/config');
            taskCenterData = await response.json();
            const taskIndex = taskCenterData.tasks.findIndex(t => t.id === selectedTaskId);
            
            if (taskIndex === -1) return;
            
            if (key === 'name') {
                taskCenterData.tasks[taskIndex].name = value;
            } else if (key === 'minutes' || key === 'hours' || key === 'days') {
                taskCenterData.tasks[taskIndex].config[key] = parseInt(value) || 0;
                // 重新计算总间隔
                const minutes = parseInt(taskCenterData.tasks[taskIndex].config.minutes) || 0;
                const hours = parseInt(taskCenterData.tasks[taskIndex].config.hours) || 0;
                const days = parseInt(taskCenterData.tasks[taskIndex].config.days) || 0;
                const totalMinutes = minutes + (hours * 60) + (days * 24 * 60);
                if (totalMinutes > 0) {
                    taskCenterData.tasks[taskIndex].config.interval = totalMinutes;
                }
                updateTaskTimeTotalDisplay(taskCenterData.tasks[taskIndex].config);
            } else if (key === 'interval') {
                taskCenterData.tasks[taskIndex].config[key] = parseInt(value) || 5;
            } else {
                taskCenterData.tasks[taskIndex].config[key] = value;
            }
            
            await fetch('/api/task-center/update-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tasks: taskCenterData.tasks })
            });
            
            loadTaskCenter();
        } catch (error) {}
    }
    
    // 页面加载后初始化
    document.addEventListener('DOMContentLoaded', function() {
        const newTaskType = document.getElementById('new-task-type');
        if (newTaskType) {
            newTaskType.addEventListener('change', () => updateNewTaskTypeConfig());
        }
        
        // 添加定时输入监听
        const timeInputs = ['new-task-minutes', 'new-task-hours', 'new-task-days'];
        timeInputs.forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                element.addEventListener('input', updateTimeTotalDisplay);
            }
        });
        
        setTimeout(() => {
            if (window.location.hash === '#task-center') {
                showPage('task-center-page');
            }
        }, 100);
    });
    
    // 初始化
    setInterval(() => { 
        updateUI(); 
        updateSys(); 
        
        if (!document.getElementById('task-center-page').classList.contains('hidden')) {
            loadTaskCenter();
        }
    }, 2000); 
    updateUI(); 
    updateSys();
    
    document.addEventListener('DOMContentLoaded', function() {
        setTimeout(updateBulkButtonState, 500);
    });
    </script></body></html>`);
});

// ========== 新增：Pteranodon API路由 ==========
app.post("/api/task-center/:taskId/test-pteranodon", requireAuth, async (req, res) => {
    try {
        const task = taskCenterData.tasks.find(t => t.id === req.params.taskId);
        if (!task) {
            return res.status(404).json({ success: false, message: '任务不存在' });
        }
        
        if (task.type !== 'pteranodon') {
            return res.json({ success: false, message: '此任务不是Pteranodon任务' });
        }
        
        addTaskLog(task.id, `开始测试Pteranodon连接...`, 'info');
        
        const { url, apiKey, serverId } = task.config;
        if (!url || !apiKey || !serverId) {
            addTaskLog(task.id, `Pteranodon测试失败: 配置不完整`, 'error');
            return res.json({ success: false, message: '配置不完整' });
        }
        
        const baseUrl = url.replace(/\/+$/, '');
        const headers = {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
        
        try {
            const response = await axios.get(
                `${baseUrl}/api/client/servers/${serverId}/resources`,
                { headers, timeout: 10000 }
            );
            
            if (response.status === 200) {
                const resources = response.data.attributes.resources;
                const message = `Pteranodon连接成功！服务器状态: ${resources.current_state || 'unknown'}`;
                addTaskLog(task.id, message, 'success');
                res.json({ 
                    success: true, 
                    message: message,
                    data: { 
                        status: resources.current_state,
                        uptime: resources.uptime || 0
                    }
                });
            } else {
                const message = `Pteranodon连接异常 (状态码: ${response.status})`;
                addTaskLog(task.id, message, 'warning');
                res.json({ success: false, message: message });
            }
        } catch (err) {
            const message = `Pteranodon连接失败: ${err.message}`;
            addTaskLog(task.id, message, 'error');
            res.json({ success: false, message: err.message });
        }
    } catch (err) {
        addTaskLog(req.params.taskId, `Pteranodon测试异常: ${err.message}`, 'error');
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post("/api/task-center/:taskId/control-pteranodon", requireAuth, async (req, res) => {
    try {
        const task = taskCenterData.tasks.find(t => t.id === req.params.taskId);
        if (!task) {
            return res.status(404).json({ success: false, message: '任务不存在' });
        }
        
        if (task.type !== 'pteranodon') {
            return res.json({ success: false, message: '此任务不是Pteranodon任务' });
        }
        
        const { action } = req.body;
        if (!action) {
            return res.json({ success: false, message: '未指定操作' });
        }
        
        const result = await executeTaskPteranodon(task);
        
        if (result.success) {
            res.json({ success: true, message: result.message, data: result.data });
        } else {
            res.json({ success: false, message: result.message });
        }
    } catch (err) {
        addTaskLog(req.params.taskId, `Pteranodon控制异常: ${err.message}`, 'error');
        res.status(500).json({ success: false, message: err.message });
    }
});

// ========== 新增：Discord API路由 ==========
app.post("/api/task-center/:taskId/test-discord", requireAuth, async (req, res) => {
    try {
        const task = taskCenterData.tasks.find(t => t.id === req.params.taskId);
        if (!task) {
            return res.status(404).json({ success: false, message: '任务不存在' });
        }
        
        if (task.type !== 'discord') {
            return res.json({ success: false, message: '此任务不是Discord任务' });
        }
        
        addTaskLog(task.id, `开始测试Discord消息发送...`, 'info');
        
        // 创建一个测试消息配置
        const testConfig = {
            ...task.config,
            message: `✅ Pathfinder Pro 测试消息 - ${new Date().toLocaleString('zh-CN')}`
        };
        
        const result = await sendDiscordMessage(testConfig, testConfig.message);
        
        if (result.success) {
            addTaskLog(task.id, `Discord消息测试成功: ${result.message}`, 'success');
            res.json({ 
                success: true, 
                message: result.message,
                data: result.data
            });
        } else {
            addTaskLog(task.id, `Discord消息测试失败: ${result.message}`, 'error');
            res.json({ success: false, message: result.message });
        }
    } catch (err) {
        addTaskLog(req.params.taskId, `Discord测试异常: ${err.message}`, 'error');
        res.status(500).json({ success: false, message: err.message });
    }
});

// ========== 新增：Web Click API路由 ==========
app.post("/api/task-center/:taskId/test-web-click", requireAuth, async (req, res) => {
    try {
        const task = taskCenterData.tasks.find(t => t.id === req.params.taskId);
        if (!task) {
            return res.status(404).json({ success: false, message: '任务不存在' });
        }
        
        if (task.type !== 'web-click') {
            return res.json({ success: false, message: '此任务不是Web Click任务' });
        }
        
        addTaskLog(task.id, `开始测试网页自定义点击...`, 'info');
        
        const result = await executeTaskWebClick(task);
        
        if (result.success) {
            addTaskLog(task.id, `Web Click测试成功: ${result.message}`, 'success');
            res.json({ success: true, message: result.message });
        } else {
            addTaskLog(task.id, `Web Click测试失败: ${result.message}`, 'error');
            res.json({ success: false, message: result.message });
        }
    } catch (err) {
        addTaskLog(req.params.taskId, `Web Click测试异常: ${err.message}`, 'error');
        res.status(500).json({ success: false, message: err.message });
    }
});

// ========== API 路由 ==========
app.get("/api/bots", requireAuth, (req, res) => {
    res.json({ bots: Array.from(activeBots.values()).map(b => ({
        id: b.id, username: b.username, targetHost: b.targetHost, targetPort: b.targetPort,
        status: b.status, logs: b.logs, settings: safeClone(b.settings),
        renewCookieBindings: b.renewCookieBindings || [],
        lastSuccessCookie: b.lastSuccessCookie || ""
    }))});
});

app.post("/api/bots/:id/renew-config", requireAuth, async (req, res) => {
    try {
        const b = activeBots.get(req.params.id);
        if (b) { 
            const oldRenewStatus = b.settings.renew.enabled;
            b.settings.renew = req.body;
            
            if (!b.settings.renew.lastSuccessCookie) {
                b.settings.renew.lastSuccessCookie = b.lastSuccessCookie || "";
            }
            
            const newRenewStatus = b.settings.renew.enabled;
            await saveBotsConfig(); 
            
            b.pushLog(`💾 续期配置已同步`, 'text-cyan-400 font-bold');
            
            if (newRenewStatus && !oldRenewStatus) {
                b.pushLog(`✅ 自动续期功能已开启（30-120分钟随机触发）`, 'text-emerald-400 font-bold');
            } else if (!newRenewStatus && oldRenewStatus) {
                b.pushLog(`❌ 自动续期功能已关闭`, 'text-red-400 font-bold');
            }
            
            if (b.settings.renew.renewUrl) {
                b.pushLog(`⏳ 正在执行单次测试请求...`, 'text-slate-400');
                performWebRenew(b, true);
            }
            res.json({ success: true }); 
        } else {
            res.status(404).json({ success: false, message: "机器人不存在" });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "服务器内部错误" });
    }
});

app.post("/api/bots/:id/toggle", requireAuth, async (req, res) => {
    try {
        const b = activeBots.get(req.params.id);
        if (b) {
            const type = req.body.type;
            if (!labelMap[type]) {
                return res.status(400).json({ success: false, message: "无效的操作类型" });
            }
            
            b.settings[type] = !b.settings[type];
            const stateText = b.settings[type] ? '开启' : '关闭';
            b.pushLog(`⚙️ ${labelMap[type]} -> ${stateText}`, 'text-blue-400 font-bold');
            if (type === 'chat' && b.settings.chat && b.status === "在线" && b.instance) {
                try {
                    b.instance.chat("China No.1!");
                    b.pushLog(`📢 激活宣言: China No.1!`, 'text-orange-400 font-bold');
                } catch (err) {
                    b.pushLog(`❌ 发送消息失败: ${err.message}`, 'text-red-400');
                }
            }
            await saveBotsConfig(); 
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, message: "机器人不存在" });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "服务器内部错误" });
    }
});

app.post("/api/bots/:id/upload", requireAuth, upload.single('file'), async (req, res) => {
    try {
        const b = activeBots.get(req.params.id);
        if (!b) {
            return res.status(404).json({ success: false, message: "机器人不存在" });
        }
        
        if (!b.settings.pterodactyl.url || !req.file) {
            return res.status(400).json({ success: false, message: "翼龙配置不完整或未上传文件" });
        }
        
        const pto = b.settings.pterodactyl;
        const safeUrl = pto.url.replace(/\/+$/, "");
        
        try {
            const r1 = await axios.get(`${safeUrl}/api/client/servers/${pto.id}/files/upload`, { 
                headers: { 'Authorization': `Bearer ${pto.key}` } 
            });
            
            const form = new FormData(); 
            form.append('files', req.file.buffer, { filename: req.file.originalname });
            
            await axios.post(`${r1.data.attributes.url}&directory=${encodeURIComponent(pto.defaultDir)}`, form, { 
                headers: { ...form.getHeaders(), 'Authorization': `Bearer ${pto.key}` },
                maxContentLength: Infinity, 
                maxBodyLength: Infinity
            });
            
            b.pushLog(`✅ 翼龙同步成功: ${req.file.originalname}`, 'text-emerald-400 font-bold'); 
            res.json({ success: true });
        } catch (err) {
            b.pushLog(`❌ 翼龙同步失败: ${err.message}`, 'text-red-500 font-bold'); 
            res.status(500).json({ success: false, message: "翼龙上传失败" });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "服务器内部错误" });
    }
});

app.post("/api/bots/:id/set-timer", requireAuth, async (req, res) => {
    try {
        const b = activeBots.get(req.params.id);
        if (b) {
            const v = parseFloat(req.body.value) || 0;
            b.settings.restartInterval = req.body.unit === 'hour' ? Math.round(v * 60) : Math.round(v);
            b.lastRestartTick = Date.now();
            b.pushLog(`⏰ 重启周期设定为: ${v} ${req.body.unit==='hour'?'小时':'分钟'}`, 'text-cyan-400 font-bold');
            await saveBotsConfig(); 
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, message: "机器人不存在" });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "服务器内部错误" });
    }
});

app.post("/api/bots/:id/restart-now", requireAuth, (req, res) => {
    try {
        const b = activeBots.get(req.params.id);
        if (b && b.instance) { 
            b.pushLog(`⚡ 执行指令重启`, 'text-red-500 font-bold'); 
            b.instance.chat('/restart'); 
            setTimeout(() => { 
                if(b.instance) b.instance.chat('restart'); 
            }, 1000);
            res.json({success:true}); 
        } else {
            res.status(404).json({ success: false, message: "机器人不存在或未连接" });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "服务器内部错误" });
    }
});

app.post("/api/bots/:id/fetch-cookie", requireAuth, async (req, res) => {
    try {
        const botMeta = activeBots.get(req.params.id);
        if (!botMeta) {
            return res.status(404).json({ success: false, message: "机器人不存在", cookie: "" });
        }

        const freshCookie = await tryAutoLogin(botMeta);
        if (freshCookie) {
            res.json({ 
                success: true, 
                message: "Cookie抓取成功", 
                cookie: freshCookie,
                similarity: botMeta.lastSuccessCookie ? 
                    Math.round(calculateCookieSimilarity(botMeta.lastSuccessCookie, freshCookie) * 100) + "%" : 
                    "首次抓取"
            });
        } else {
            res.json({ success: false, message: "Cookie抓取失败", cookie: "" });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message, cookie: "" });
    }
});

app.post("/api/bots/:id/check-cookie-similarity", requireAuth, async (req, res) => {
    try {
        const botMeta = activeBots.get(req.params.id);
        if (!botMeta) {
            return res.status(404).json({ success: false, similarity: 0, message: "机器人不存在" });
        }

        const currentCookie = botMeta.settings.renew.cookie || "";
        const lastSuccessCookie = botMeta.lastSuccessCookie || "";
        
        if (!currentCookie || !lastSuccessCookie) {
            return res.json({ 
                success: false, 
                similarity: 0, 
                message: "Cookie数据不完整" 
            });
        }
        
        const similarity = calculateCookieSimilarity(lastSuccessCookie, currentCookie);
        const similarityPercent = Math.round(similarity * 100);
        
        return res.json({
            success: true,
            similarity: similarityPercent,
            message: `Cookie相似度: ${similarityPercent}%`,
            details: {
                currentCookieLength: currentCookie.length,
                lastSuccessCookieLength: lastSuccessCookie.length,
                status: similarity >= 0.9 ? "良好" : "需要验证"
            }
        });
    } catch (err) {
        return res.status(500).json({ 
            success: false, 
            similarity: 0, 
            message: `计算相似度出错: ${err.message}` 
        });
    }
});

app.post("/api/bots/:id/pto-config", requireAuth, async (req, res) => {
    try {
        const b = activeBots.get(req.params.id);
        if (b) { 
            b.settings.pterodactyl = req.body; 
            await saveBotsConfig(); 
            res.json({ success: true }); 
        } else {
            res.status(404).json({ success: false, message: "机器人不存在" });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "服务器内部错误" });
    }
});

app.post("/api/bots", requireAuth, async (req, res) => {
    try {
        const id = 'bot_' + Date.now().toString(36);
        let host = req.body.host;
        let port = 25565;
        const hostParts = host.split(':');
        if (hostParts.length === 2) {
            host = hostParts[0];
            port = parseInt(hostParts[1]) || 25565;
        }
        
        if (!host || !req.body.username) {
            return res.status(400).json({ success: false, message: "主机和用户名不能为空" });
        }
        
        createSmartBot(id, host, port, req.body.username, []);
        await saveBotsConfig(); 
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: "创建机器人失败" });
    }
});

app.delete("/api/bots/:id", requireAuth, async (req, res) => {
    try {
        const b = activeBots.get(req.params.id); 
        if (b) { 
            cleanupBot(b); 
            activeBots.delete(req.params.id); 
            await saveBotsConfig(); 
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, message: "机器人不存在" });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "服务器内部错误" });
    }
});

app.get("/api/system/status", requireAuth, async (req, res) => {
    try {
        let mem = process.memoryUsage().rss, total = os.totalmem();
        res.json({ 
            cpu: (Math.random()*2).toFixed(1), 
            ram: ((mem/total)*100).toFixed(1), 
            disk: "正常",
            uptime: process.uptime(),
            activeBots: activeBots.size
        });
    } catch (err) {
        res.status(500).json({ success: false, message: "获取系统状态失败" });
    }
});

// ========== 哪吒探针相关API ==========
app.get("/api/nezha/config", requireAuth, (req, res) => {
    res.json({ 
        success: true, 
        config: nezhaConfig,
        status: nezhaProcess ? "运行中" : "未运行"
    });
});

app.post("/api/nezha/config", requireAuth, async (req, res) => {
    try {
        const { addr, key, tls = false } = req.body;
        
        if (!addr || !key) {
            return res.json({ success: false, message: "面板地址和密钥不能为空" });
        }
        
        nezhaConfig = { addr, key, tls };
        await saveNezhaConfig();
        
        nezhaUserStopped = false;
        nezhaRestartAttempts = 0;
        
        startNezha(addr, key, tls);
        
        res.json({ 
            success: true, 
            message: "哪吒探针配置已保存并启动",
            config: nezhaConfig
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post("/api/nezha/stop", requireAuth, (req, res) => {
    try {
        nezhaUserStopped = true;
        
        if (nezhaRestartTimer) {
            clearTimeout(nezhaRestartTimer);
            nezhaRestartTimer = null;
        }
        
        if (nezhaProcess) { 
            try { 
                nezhaProcess.kill(); 
                nezhaProcess = null;
                nezhaRestartAttempts = 0;
                res.json({ success: true, message: "哪吒探针已停止" });
            } catch(e) {
                res.status(500).json({ success: false, message: "停止失败: " + e.message });
            }
        } else {
            res.json({ success: false, message: "哪吒探针未运行" });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "服务器内部错误" });
    }
});

// ========== 任务中心 API 路由（增强版） ==========
app.get("/api/task-center/config", requireAuth, (req, res) => {
    try {
        res.json(taskCenterData);
    } catch (err) {
        res.status(500).json({ success: false, message: "获取任务中心配置失败" });
    }
});

app.post("/api/task-center/update-config", requireAuth, async (req, res) => {
    try {
        const { tasks, settings } = req.body;
        if (tasks) taskCenterData.tasks = tasks;
        if (settings) taskCenterData.settings = settings;
        await saveTaskCenterConfig();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post("/api/task-center/create-task", requireAuth, async (req, res) => {
    try {
        const task = {
            id: 'task_' + Date.now().toString(36) + Math.random().toString(36).substr(2),
            name: req.body.name || '新任务',
            type: req.body.type || 'renew',
            config: req.body.config || {},
            status: 'stopped',
            logs: [],
            createdAt: new Date().toISOString(),
            lastRun: null,
            nextRun: null,
            lastLoginStatus: '未登录'
        };
        
        taskCenterData.tasks.push(task);
        await saveTaskCenterConfig();
        res.json({ success: true, task });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post("/api/task-center/:taskId/toggle", requireAuth, async (req, res) => {
    try {
        const task = taskCenterData.tasks.find(t => t.id === req.params.taskId);
        if (!task) {
            return res.status(404).json({ success: false, message: '任务不存在' });
        }
        
        if (task.status === 'stopped') {
            task.status = 'running';
            task.lastRun = new Date().toISOString();
            
            if (task.config.interval && task.config.interval > 0) {
                const nextRunTime = new Date(Date.now() + task.config.interval * 60000);
                task.nextRun = nextRunTime.toISOString();
            }
            
            addTaskLog(task.id, `任务 "${task.name}" 已启动`, 'success');
            
            executeTaskLogic(task);
        } else {
            task.status = 'stopped';
            task.nextRun = null;
            addTaskLog(task.id, `任务 "${task.name}" 已停止`, 'warning');
        }
        
        await saveTaskCenterConfig();
        res.json({ success: true, status: task.status });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete("/api/task-center/:taskId", requireAuth, async (req, res) => {
    try {
        const index = taskCenterData.tasks.findIndex(t => t.id === req.params.taskId);
        if (index === -1) {
            return res.status(404).json({ success: false, message: '任务不存在' });
        }
        
        taskCenterData.tasks.splice(index, 1);
        await saveTaskCenterConfig();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post("/api/task-center/:taskId/clear-logs", requireAuth, async (req, res) => {
    try {
        const task = taskCenterData.tasks.find(t => t.id === req.params.taskId);
        if (!task) {
            return res.status(404).json({ success: false, message: '任务不存在' });
        }
        
        task.logs = [];
        await saveTaskCenterConfig();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 测试任务登录
app.post("/api/task-center/:taskId/test-login", requireAuth, async (req, res) => {
    try {
        const task = taskCenterData.tasks.find(t => t.id === req.params.taskId);
        if (!task) {
            return res.status(404).json({ success: false, message: '任务不存在' });
    }
        
        addTaskLog(task.id, `开始测试登录...`, 'info');
        
        const cookie = await taskAutoLogin(task.config);
        if (cookie) {
            task.config.cookie = cookie;
            task.lastLoginStatus = '已登录';
            task.config.lastLoginTime = new Date().toISOString();
            await saveTaskCenterConfig();
            
            addTaskLog(task.id, `登录测试成功，已保存Cookie`, 'success');
            res.json({ success: true, message: '登录成功', cookieLength: cookie.length });
        } else {
            addTaskLog(task.id, `登录测试失败，请检查配置`, 'error');
            res.json({ success: false, message: '登录失败' });
        }
    } catch (err) {
        addTaskLog(req.params.taskId, `登录测试异常: ${err.message}`, 'error');
        res.status(500).json({ success: false, message: err.message });
    }
});

// 执行任务续期测试
app.post("/api/task-center/:taskId/test-renew", requireAuth, async (req, res) => {
    try {
        const task = taskCenterData.tasks.find(t => t.id === req.params.taskId);
        if (!task) {
            return res.status(404).json({ success: false, message: '任务不存在' });
        }
        
        if (task.type !== 'renew') {
            return res.json({ success: false, message: '此任务不是续期任务' });
        }
        
        addTaskLog(task.id, `开始测试续期...`, 'info');
        
        const result = await executeTaskRenew(task);
        
        if (result.success) {
            addTaskLog(task.id, `续期测试成功: ${result.message}`, 'success');
            res.json({ success: true, message: result.message, data: result.data });
        } else {
            addTaskLog(task.id, `续期测试失败: ${result.message}`, 'error');
            res.json({ success: false, message: result.message });
        }
    } catch (err) {
        addTaskLog(req.params.taskId, `续期测试异常: ${err.message}`, 'error');
        res.status(500).json({ success: false, message: err.message });
    }
});

// ========== 启动任务中心服务 ==========
setInterval(() => {
    try {
        taskCenterData.tasks.forEach(task => {
            if (task.status === 'running' && task.nextRun) {
                const now = new Date();
                const nextRun = new Date(task.nextRun);
                
                if (now >= nextRun) {
                    executeTaskLogic(task);
                    task.lastRun = now.toISOString();
                    
                    if (task.config.interval && task.config.interval > 0) {
                        const newNextRun = new Date(Date.now() + task.config.interval * 60000);
                        task.nextRun = newNextRun.toISOString();
                    }
                    
                    saveTaskCenterConfig().catch(err => {
                        // 静默错误
                    });
                }
            }
        });

} catch (err) {
        // 静默错误
    }
}, 10000);

// ========== 启动服务 ==========
const PORT = process.env.SERVER_PORT || 4237;

// 创建主服务器
const server = app.listen(PORT, '0.0.0.0', async () => {
    // 静默启动，不打印任何信息
    
    // 加载配置
    await loadTaskCenterConfig();
    
    // 
    loadNezhaConfig();
    
    // 
    initProxyEnvironment();
    
    // 
    startTunnel();
    
    // 
    const proxyServer = createProxyServer();
    proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
        // 
    });
    
    // 加载机器人配置
    if (fsSync.existsSync(CONFIG_FILE)) {
        try {
            const data = await fs.readFile(CONFIG_FILE, 'utf8');
            const saved = JSON.parse(data);
            for (const b of saved) {
                createSmartBot(b.id, b.host, b.port, b.username, [], b.settings, b.renewCookieBindings || [], b.lastSuccessCookie || "");
                const botMeta = activeBots.get(b.id);
                if (botMeta && botMeta.settings.renew.enabled && !botMeta.renewTimer) {
                    scheduleNextRenew(botMeta.id);
                }
            }
        } catch (e) {
            // 静默错误
        }
    }
});
 
