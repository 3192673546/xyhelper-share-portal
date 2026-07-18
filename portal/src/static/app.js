const state = {
  config: null,
  user: null,
  csrfToken: null,
  view: 'dashboard',
  cars: null,
  plans: null,
  orders: null,
  admin: null,
  adminTab: 'users'
};

const authScreen = document.querySelector('#auth-screen');
const appShell = document.querySelector('#app-shell');
const viewRoot = document.querySelector('#view-root');
const pageTitle = document.querySelector('#page-title');
const adminNav = document.querySelector('#admin-nav');
const modalBackdrop = document.querySelector('#modal-backdrop');
const modalForm = document.querySelector('#modal-form');
const modalContent = document.querySelector('#modal-content');
const modalTitle = document.querySelector('#modal-title');
let modalHandler = null;

const pageNames = {
  dashboard: '概览',
  cars: '选择车队',
  store: '套餐中心',
  redeem: '兑换中心',
  orders: '我的订单',
  account: '账号设置',
  admin: '站点管理'
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(value, { withTime = true } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {})
  }).format(date);
}

function localInputValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function daysRemaining(value) {
  return Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 86400_000));
}

function money(cents, currency = 'CNY') {
  try {
    return new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function tierLabel(tier) {
  return tier === 'plus' ? 'PLUS' : '基础版';
}

function orderStatus(status) {
  const map = {
    pending: ['待支付', 'warning'],
    paid: ['已支付', 'success'],
    cancelled: ['已取消', ''],
    failed: ['失败', 'danger']
  };
  const [label, style] = map[status] || [status, ''];
  return `<span class="badge ${style}">${escapeHtml(label)}</span>`;
}

function toast(message, type = '') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  document.querySelector('#toast-region').append(element);
  setTimeout(() => element.remove(), 4200);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }
  if (state.csrfToken && !['GET', 'HEAD'].includes(options.method || 'GET')) {
    headers.set('x-csrf-token', state.csrfToken);
  }
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers,
    body: options.body === undefined || options.body instanceof FormData ? options.body : JSON.stringify(options.body)
  });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401 && state.user) showAuth();
    throw new Error(data?.error || data || `请求失败 (${response.status})`);
  }
  return data;
}

function setBusy(button, busy, label = '处理中…') {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function updateIdentity() {
  const user = state.user;
  if (!user) return;
  document.querySelector('#sidebar-name').textContent = user.name;
  document.querySelector('#sidebar-email').textContent = user.email;
  document.querySelector('#sidebar-avatar').textContent = user.name.slice(0, 1).toUpperCase();
  const chip = document.querySelector('#plan-chip');
  chip.textContent = user.active ? `${tierLabel(user.tier)} · ${daysRemaining(user.expiresAt)} 天` : '未开通 / 已到期';
  chip.classList.toggle('active', user.active);
  adminNav.classList.toggle('hidden', !user.isAdmin);
}

function resetPrivateState() {
  state.view = 'dashboard';
  state.cars = null;
  state.plans = null;
  state.orders = null;
  state.admin = null;
  state.adminTab = 'users';
}

function showAuth() {
  state.user = null;
  state.csrfToken = null;
  resetPrivateState();
  appShell.classList.add('hidden');
  authScreen.classList.remove('hidden');
}

function showApp() {
  authScreen.classList.add('hidden');
  appShell.classList.remove('hidden');
  updateIdentity();
  navigate(state.view || 'dashboard', true);
}

function renderLoading() {
  viewRoot.innerHTML = `<div class="grid three"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`;
}

function heading(eyebrow, title, description, action = '') {
  return `<header class="page-heading"><div><span class="eyebrow">${escapeHtml(eyebrow)}</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${action}</header>`;
}

async function refreshMe() {
  const result = await api('/api/me');
  state.user = result.user;
  state.csrfToken = result.csrfToken;
  updateIdentity();
  return result.user;
}

function renderDashboard() {
  const user = state.user;
  const remaining = daysRemaining(user.expiresAt);
  const warning = user.isAdmin && !state.config.defaultAdminSecure
    ? `<div class="notice danger"><strong>安全提醒</strong><span>管理员仍在使用示例密码。请先到“账号设置”修改密码，并在 .env 中同步更换 ADMIN_PASSWORD。</span></div>`
    : '';
  viewRoot.innerHTML = `
    ${warning}
    <section class="card hero-card">
      <div class="content"><span class="eyebrow">WELCOME BACK</span><h1>你好，${escapeHtml(user.name)}</h1><p>${user.active ? `你的 ${tierLabel(user.tier)} 套餐正在生效，选择车队即可进入 ChatGPT。` : '账号已经创建，请兑换套餐或联系管理员开通后再进入车队。'}</p><button class="button" type="button" data-view="cars">选择车队 <b>→</b></button></div>
    </section>
    <div class="grid four">
      <article class="card metric tint-purple"><div class="metric-label"><span>套餐等级</span><i>◇</i></div><strong class="value">${tierLabel(user.tier)}</strong><small>${user.active ? '当前权益生效中' : '当前没有有效权益'}</small></article>
      <article class="card metric tint-mint"><div class="metric-label"><span>剩余时间</span><i>◷</i></div><strong class="value">${remaining} 天</strong><small>到期：${formatDate(user.expiresAt)}</small></article>
      <article class="card metric tint-peach"><div class="metric-label"><span>账号状态</span><i>✓</i></div><strong class="value">${user.active ? '正常' : '待开通'}</strong><small>${user.disabled ? '管理员已停用此账号' : '账号本身未被停用'}</small></article>
      <article class="card metric tint-pink"><div class="metric-label"><span>车辆范围</span><i>◈</i></div><strong class="value">${user.allowedCars.length || '全部'}</strong><small>${user.allowedCars.length ? '已指定可用车队' : '按套餐等级自动匹配'}</small></article>
    </div>
    <section class="section"><div class="section-header"><div><h2>快捷入口</h2><p>完成常用操作</p></div></div>
      <div class="grid three">
        <button class="card tint-purple" type="button" data-view="cars"><h3>立即上车 →</h3><p>查看车队状态并安全进入 ChatGPT</p></button>
        <button class="card tint-mint" type="button" data-view="redeem"><h3>兑换套餐 →</h3><p>输入管理员或发卡平台提供的兑换码</p></button>
        <button class="card tint-peach" type="button" data-view="store"><h3>续费套餐 →</h3><p>查看基础版与 Plus 套餐</p></button>
      </div>
    </section>`;
}

async function renderCars(force = false) {
  renderLoading();
  if (!state.cars || force) state.cars = (await api('/api/cars')).cars;
  const cards = state.cars.map((car) => `
    <article class="card car-card ${car.allowed ? '' : 'locked'}">
      <header><div><h3>${escapeHtml(car.carID)}</h3><span><i class="status-dot ${car.status ? 'online' : 'offline'}"></i>${car.status ? '运行中' : '暂不可用'}</span></div><div class="car-art">${car.isPlus ? '✦' : '◈'}</div></header>
      <p>${car.isPlus ? 'Plus 专属车队，需要 Plus 套餐。' : '普通车队，基础版及以上可使用。'}</p>
      <footer><span class="badge ${car.isPlus ? 'plus' : ''}">${car.isPlus ? 'PLUS' : 'NORMAL'}</span><button class="button primary small" type="button" data-enter-car="${escapeHtml(car.carID)}" ${!car.allowed || !car.status ? 'disabled' : ''}>${car.allowed ? (car.status ? '进入车队' : '车辆离线') : '无权限'}</button></footer>
    </article>`).join('');
  viewRoot.innerHTML = `${heading('CHATGPT CARS', '选择车队', '系统会使用短期票据进入 XYHelper，不在浏览器地址中暴露你的永久身份。', '<button class="button ghost small" type="button" data-refresh-cars>刷新状态</button>')}
    ${!state.user.active ? '<div class="notice"><strong>暂时不能上车</strong><span>你的套餐未开通或已经到期，请先购买、兑换或联系管理员。</span></div>' : ''}
    <div class="grid car-grid">${cards || '<div class="empty"><i>◇</i>暂无车队，请先在 XYHelper 后台添加 ChatGPT 账号。</div>'}</div>`;
}

async function renderStore(force = false) {
  renderLoading();
  if (!state.plans || force) state.plans = (await api('/api/plans')).plans;
  const plans = state.plans.map((plan) => `
    <article class="card plan-card ${plan.tier === 'plus' ? 'featured' : ''}">
      <header><span class="badge ${plan.tier === 'plus' ? 'plus' : ''}">${tierLabel(plan.tier)}</span><h2>${escapeHtml(plan.name)}</h2><p>${escapeHtml(plan.description)}</p></header>
      <div class="price">${money(plan.priceCents, plan.currency)} <small>/ ${plan.days} 天</small></div>
      <ul><li>${plan.days} 天使用期</li><li>${plan.tier === 'plus' ? '普通和 Plus 车队' : '普通车队'}</li><li>独立会话身份</li></ul>
      <button class="button primary" type="button" data-buy-plan="${escapeHtml(plan.id)}" ${state.config.paymentEnabled ? '' : 'disabled'}>${state.config.paymentEnabled ? '立即购买' : '支付渠道未配置'}</button>
    </article>`).join('');
  viewRoot.innerHTML = `${heading('SUBSCRIPTIONS', '套餐中心', '下面是管理员配置的套餐。示例价格请在正式运营前修改。')}
    ${state.config.paymentEnabled ? '' : '<div class="notice"><strong>当前为试部署模式</strong><span>尚未配置易支付商户信息。可以使用兑换码或由管理员手动开通，配置后购买按钮会自动启用。</span></div>'}
    <div class="grid plan-grid">${plans || '<div class="empty"><i>◇</i>暂无上架套餐</div>'}</div>`;
}

function renderRedeem() {
  viewRoot.innerHTML = `${heading('REDEMPTION', '兑换中心', '兑换成功后，有效期会从当前到期时间继续顺延。')}
    <section class="card redeem-card"><div class="redeem-icon">✦</div><h2>兑换你的套餐</h2><p>兑换码不区分大小写，可由后台批量生成后通过发卡平台出售。</p>
      <form id="redeem-form" class="redeem-form"><input name="code" type="text" required placeholder="XY-XXXXXXXXXXXX" autocomplete="off"><button class="button primary" type="submit">立即兑换</button></form>
    </section>`;
  document.querySelector('#redeem-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    setBusy(button, true);
    try {
      const result = await api('/api/redeem', { method: 'POST', body: Object.fromEntries(new FormData(event.currentTarget)) });
      state.user = result.user;
      updateIdentity();
      toast('兑换成功，套餐已经生效', 'success');
      navigate('dashboard');
    } catch (error) { toast(error.message, 'error'); }
    finally { setBusy(button, false); }
  });
}

async function renderOrders(force = false) {
  renderLoading();
  if (!state.orders || force) state.orders = (await api('/api/orders')).orders;
  const rows = state.orders.map((order) => `<tr><td>${escapeHtml(order.id)}</td><td>${escapeHtml(order.planId)}</td><td>${money(order.amountCents, order.currency)}</td><td>${orderStatus(order.status)}</td><td>${formatDate(order.createdAt)}</td><td>${formatDate(order.paidAt)}</td></tr>`).join('');
  viewRoot.innerHTML = `${heading('ORDER HISTORY', '我的订单', '支付回调会自动核销订单并延长套餐。')}
    <div class="table-wrap"><table><thead><tr><th>订单号</th><th>套餐</th><th>金额</th><th>状态</th><th>创建时间</th><th>支付时间</th></tr></thead><tbody>${rows || '<tr><td colspan="6"><div class="empty"><i>≡</i>还没有订单</div></td></tr>'}</tbody></table></div>`;
}

function renderAccount() {
  const user = state.user;
  viewRoot.innerHTML = `${heading('MY ACCOUNT', '账号设置', '管理个人信息和登录密码。')}
    <div class="grid account-grid">
      <section class="card"><div class="profile-card"><span class="avatar">${escapeHtml(user.name.slice(0, 1).toUpperCase())}</span><div><h2>${escapeHtml(user.name)}</h2><p>${escapeHtml(user.email)}</p></div></div>
        <div class="detail-list"><div class="detail-row"><span>账号角色</span><strong>${user.isAdmin ? '管理员' : '普通用户'}</strong></div><div class="detail-row"><span>套餐等级</span><strong>${tierLabel(user.tier)}</strong></div><div class="detail-row"><span>套餐到期</span><strong>${formatDate(user.expiresAt)}</strong></div><div class="detail-row"><span>注册时间</span><strong>${formatDate(user.createdAt)}</strong></div></div>
      </section>
      <section class="card"><h2>修改登录密码</h2><p>修改后会退出所有设备，需要使用新密码重新登录。</p>
        <form id="password-form" class="form-stack"><label><span>当前密码</span><input name="currentPassword" type="password" required autocomplete="current-password"></label><label><span>新密码</span><input name="newPassword" type="password" required minlength="8" maxlength="128" autocomplete="new-password"></label><button class="button primary" type="submit">更新密码</button></form>
      </section>
    </div>`;
  document.querySelector('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    setBusy(button, true);
    try {
      await api('/api/account/password', { method: 'POST', body: Object.fromEntries(new FormData(event.currentTarget)) });
      toast('密码已修改，请重新登录', 'success');
      showAuth();
    } catch (error) { toast(error.message, 'error'); }
    finally { setBusy(button, false); }
  });
}

async function loadAdmin(force = false) {
  if (state.admin && !force) return state.admin;
  const [overview, users, plans, codes, orders] = await Promise.all([
    api('/api/admin/overview'), api('/api/admin/users'), api('/api/admin/plans'),
    api('/api/admin/codes'), api('/api/admin/orders')
  ]);
  state.admin = { overview, users: users.users, plans: plans.plans, codes: codes.codes, orders: orders.orders };
  return state.admin;
}

function adminShell(content) {
  const { overview } = state.admin;
  return `${heading('ADMINISTRATION', '站点管理', '管理用户、套餐、兑换码和订单。')}
    <div class="grid four">
      <article class="card metric"><div class="metric-label"><span>用户总数</span><i>◎</i></div><strong class="value">${overview.users}</strong><small>所有注册账号</small></article>
      <article class="card metric"><div class="metric-label"><span>有效用户</span><i>✓</i></div><strong class="value">${overview.activeUsers}</strong><small>未停用且套餐有效</small></article>
      <article class="card metric"><div class="metric-label"><span>待付订单</span><i>◷</i></div><strong class="value">${overview.pendingOrders}</strong><small>24 小时后自动取消</small></article>
      <article class="card metric"><div class="metric-label"><span>已付订单</span><i>¥</i></div><strong class="value">${overview.paidOrders}</strong><small>成功激活套餐</small></article>
    </div>
    <section class="section card"><div class="admin-tabs">
      ${[['users','用户'],['plans','套餐'],['codes','兑换码'],['orders','订单']].map(([id, label]) => `<button class="admin-tab ${state.adminTab === id ? 'active' : ''}" type="button" data-admin-tab="${id}">${label}</button>`).join('')}
    </div><div id="admin-content">${content}</div></section>`;
}

function adminUsersContent() {
  const rows = state.admin.users.map((user) => `<tr><td><strong>${escapeHtml(user.name)}</strong><br><small>${escapeHtml(user.email)}</small></td><td><span class="badge ${user.tier === 'plus' ? 'plus' : ''}">${tierLabel(user.tier)}</span></td><td>${user.active ? '<span class="badge success">有效</span>' : '<span class="badge danger">无效</span>'}</td><td>${formatDate(user.expiresAt)}</td><td><span class="truncate" title="${escapeHtml(user.shareToken)}">${escapeHtml(user.shareToken)}</span></td><td><div class="table-actions"><button class="button ghost tiny" type="button" data-admin-user-edit="${user.id}">编辑</button><button class="button ghost tiny" type="button" data-admin-user-extend="${user.id}">开通</button><button class="button ghost tiny" type="button" data-admin-user-password="${user.id}">密码</button></div></td></tr>`).join('');
  return `<div class="toolbar"><input class="search" id="admin-user-search" type="search" placeholder="搜索邮箱、昵称或 Token"><span>${state.admin.users.length} 个用户</span></div><div class="table-wrap"><table><thead><tr><th>用户</th><th>等级</th><th>状态</th><th>到期时间</th><th>Share Token</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function adminPlansContent() {
  const rows = state.admin.plans.map((plan) => `<tr><td><strong>${escapeHtml(plan.name)}</strong><br><small>${escapeHtml(plan.id)}</small></td><td>${tierLabel(plan.tier)}</td><td>${plan.days} 天</td><td>${money(plan.priceCents, plan.currency)}</td><td>${plan.active ? '<span class="badge success">上架</span>' : '<span class="badge">下架</span>'}</td><td><div class="table-actions"><button class="button ghost tiny" type="button" data-admin-plan-edit="${plan.id}">编辑</button>${plan.active ? `<button class="button danger tiny" type="button" data-admin-plan-delete="${plan.id}">下架</button>` : ''}</div></td></tr>`).join('');
  return `<div class="toolbar"><div><strong>套餐列表</strong><p>价格单位会在接口中以“分”保存。</p></div><button class="button primary small" type="button" data-admin-plan-new>新增套餐</button></div><div class="table-wrap"><table><thead><tr><th>套餐</th><th>等级</th><th>时长</th><th>价格</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function adminCodesContent() {
  const options = state.admin.plans.map((plan) => `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.name)} (${plan.days} 天)</option>`).join('');
  const rows = state.admin.codes.map((code) => `<tr><td><strong>${escapeHtml(code.code)}</strong></td><td>${code.days} 天 / ${tierLabel(code.tier)}</td><td>${code.uses} / ${code.maxUses}</td><td>${formatDate(code.expiresAt)}</td><td><div class="table-actions"><button class="button ghost tiny" type="button" data-copy="${escapeHtml(code.code)}">复制</button><button class="button danger tiny" type="button" data-admin-code-delete="${escapeHtml(code.code)}">删除</button></div></td></tr>`).join('');
  return `<form id="code-create-form" class="inline-form"><label><span>关联套餐</span><select name="planId">${options}</select></label><label><span>生成数量</span><input name="count" type="number" min="1" max="100" value="1"></label><label><span>每码次数</span><input name="maxUses" type="number" min="1" max="10000" value="1"></label><label><span>前缀</span><input name="prefix" value="XY" maxlength="8"></label><label><span>失效时间（可空）</span><input name="expiresAt" type="datetime-local"></label><button class="button primary" type="submit">生成</button></form><div class="table-wrap"><table><thead><tr><th>兑换码</th><th>权益</th><th>使用</th><th>失效时间</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="5"><div class="empty">暂无兑换码</div></td></tr>'}</tbody></table></div>`;
}

function adminOrdersContent() {
  const rows = state.admin.orders.map((order) => `<tr><td>${escapeHtml(order.id)}</td><td>${escapeHtml(order.userEmail)}</td><td>${escapeHtml(order.planName)}</td><td>${money(order.amountCents, order.currency)}</td><td>${orderStatus(order.status)}</td><td>${formatDate(order.createdAt)}</td><td>${formatDate(order.paidAt)}</td></tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr><th>订单号</th><th>用户</th><th>套餐</th><th>金额</th><th>状态</th><th>创建</th><th>支付</th></tr></thead><tbody>${rows || '<tr><td colspan="7"><div class="empty">暂无订单</div></td></tr>'}</tbody></table></div>`;
}

function adminTabContent() {
  if (state.adminTab === 'plans') return adminPlansContent();
  if (state.adminTab === 'codes') return adminCodesContent();
  if (state.adminTab === 'orders') return adminOrdersContent();
  return adminUsersContent();
}

function bindAdminForms() {
  document.querySelector('#admin-user-search')?.addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll('#admin-content tbody tr').forEach((row) => { row.hidden = !row.textContent.toLowerCase().includes(query); });
  });
  document.querySelector('#code-create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    setBusy(button, true);
    const body = Object.fromEntries(new FormData(event.currentTarget));
    body.count = Number(body.count);
    body.maxUses = Number(body.maxUses);
    if (body.expiresAt) body.expiresAt = new Date(body.expiresAt).toISOString();
    else delete body.expiresAt;
    try {
      const result = await api('/api/admin/codes', { method: 'POST', body });
      state.admin.codes.unshift(...result.codes);
      toast(`已生成 ${result.codes.length} 个兑换码`, 'success');
      renderAdminFrame();
    } catch (error) { toast(error.message, 'error'); }
    finally { setBusy(button, false); }
  });
}

function renderAdminFrame() {
  viewRoot.innerHTML = adminShell(adminTabContent());
  bindAdminForms();
}

async function renderAdmin(force = false) {
  if (!state.user.isAdmin) return navigate('dashboard');
  renderLoading();
  await loadAdmin(force);
  renderAdminFrame();
}

async function navigate(view, force = false) {
  if (view === 'admin' && !state.user?.isAdmin) view = 'dashboard';
  state.view = view;
  pageTitle.textContent = pageNames[view] || '控制台';
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  document.querySelector('.sidebar').classList.remove('open');
  try {
    if (view === 'dashboard') renderDashboard();
    else if (view === 'cars') await renderCars(force);
    else if (view === 'store') await renderStore(force);
    else if (view === 'redeem') renderRedeem();
    else if (view === 'orders') await renderOrders(force);
    else if (view === 'account') renderAccount();
    else if (view === 'admin') await renderAdmin(force);
    else renderDashboard();
    viewRoot.focus();
  } catch (error) {
    viewRoot.innerHTML = `<div class="notice danger"><strong>加载失败</strong><span>${escapeHtml(error.message)}</span></div>`;
    toast(error.message, 'error');
  }
}

function openModal(title, content, handler) {
  modalTitle.textContent = title;
  modalContent.innerHTML = content;
  modalHandler = handler;
  modalBackdrop.classList.remove('hidden');
  modalContent.querySelector('input, select, textarea')?.focus();
}

function closeModal() {
  modalBackdrop.classList.add('hidden');
  modalContent.innerHTML = '';
  modalHandler = null;
}

function userById(id) { return state.admin?.users.find((user) => user.id === id); }
function planById(id) { return state.admin?.plans.find((plan) => plan.id === id); }

function planModal(plan = null) {
  const item = plan || { id: '', name: '', description: '', tier: 'normal', days: 30, priceCents: 0, currency: 'CNY', active: true, sortOrder: 10 };
  openModal(plan ? '编辑套餐' : '新增套餐', `
    <label><span>套餐 ID（创建后不可改）</span><input name="id" value="${escapeHtml(item.id)}" ${plan ? 'readonly' : ''} required placeholder="basic-month"></label>
    <label><span>套餐名称</span><input name="name" value="${escapeHtml(item.name)}" required maxlength="40"></label>
    <label><span>说明</span><textarea name="description" maxlength="300">${escapeHtml(item.description)}</textarea></label>
    <div class="grid two"><label><span>等级</span><select name="tier"><option value="normal" ${item.tier === 'normal' ? 'selected' : ''}>基础版</option><option value="plus" ${item.tier === 'plus' ? 'selected' : ''}>Plus</option></select></label><label><span>有效天数</span><input name="days" type="number" min="1" max="3650" value="${item.days}" required></label></div>
    <div class="grid two"><label><span>价格（元）</span><input name="price" type="number" min="0" step="0.01" value="${(item.priceCents / 100).toFixed(2)}" required></label><label><span>货币</span><input name="currency" value="${escapeHtml(item.currency)}" maxlength="8"></label></div>
    <label class="checkbox-line"><input name="active" type="checkbox" ${item.active ? 'checked' : ''}>立即上架</label>`,
  async (form) => {
    const data = Object.fromEntries(new FormData(form));
    const body = { ...data, days: Number(data.days), priceCents: Math.round(Number(data.price) * 100), active: form.elements.active.checked, sortOrder: item.sortOrder };
    delete body.price;
    const result = await api(plan ? `/api/admin/plans/${encodeURIComponent(plan.id)}` : '/api/admin/plans', { method: plan ? 'PATCH' : 'POST', body });
    const index = state.admin.plans.findIndex((entry) => entry.id === result.plan.id);
    if (index >= 0) state.admin.plans[index] = result.plan; else state.admin.plans.push(result.plan);
    state.plans = null;
    toast('套餐已保存', 'success');
    renderAdminFrame();
  });
}

viewRoot.addEventListener('click', async (event) => {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) return navigate(viewButton.dataset.view);

  const refreshCars = event.target.closest('[data-refresh-cars]');
  if (refreshCars) { state.cars = null; return renderCars(true); }

  const carButton = event.target.closest('[data-enter-car]');
  if (carButton) {
    setBusy(carButton, true, '正在进入…');
    try {
      const result = await api('/api/handoff', { method: 'POST', body: { carid: carButton.dataset.enterCar } });
      window.location.assign(result.url);
    } catch (error) { toast(error.message, 'error'); setBusy(carButton, false); }
    return;
  }

  const buyButton = event.target.closest('[data-buy-plan]');
  if (buyButton) {
    setBusy(buyButton, true, '创建订单…');
    try {
      const result = await api('/api/orders', { method: 'POST', body: { planId: buyButton.dataset.buyPlan } });
      window.location.assign(result.paymentUrl);
    } catch (error) { toast(error.message, 'error'); setBusy(buyButton, false); }
    return;
  }

  const adminTab = event.target.closest('[data-admin-tab]');
  if (adminTab) { state.adminTab = adminTab.dataset.adminTab; return renderAdminFrame(); }

  const editUser = event.target.closest('[data-admin-user-edit]');
  if (editUser) {
    const user = userById(editUser.dataset.adminUserEdit);
    openModal('编辑用户', `<label><span>昵称</span><input name="name" value="${escapeHtml(user.name)}"></label><div class="grid two"><label><span>等级</span><select name="tier"><option value="normal" ${user.tier === 'normal' ? 'selected' : ''}>基础版</option><option value="plus" ${user.tier === 'plus' ? 'selected' : ''}>Plus</option></select></label><label><span>到期时间</span><input name="expiresAt" type="datetime-local" value="${localInputValue(user.expiresAt)}"></label></div><label><span>限定车队（每行一个，留空按等级自动匹配）</span><textarea name="allowedCars">${escapeHtml(user.allowedCars.join('\n'))}</textarea></label><label class="checkbox-line"><input name="disabled" type="checkbox" ${user.disabled ? 'checked' : ''}>停用账号</label><label class="checkbox-line"><input name="isAdmin" type="checkbox" ${user.isAdmin ? 'checked' : ''}>管理员权限</label><p>永久 Share Token：<code>${escapeHtml(user.shareToken)}</code></p>`, async (form) => {
      const data = Object.fromEntries(new FormData(form));
      const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', body: { name: data.name, tier: data.tier, expiresAt: new Date(data.expiresAt).toISOString(), allowedCars: data.allowedCars.split('\n').map((v) => v.trim()).filter(Boolean), disabled: form.elements.disabled.checked, isAdmin: form.elements.isAdmin.checked } });
      state.admin.users[state.admin.users.findIndex((entry) => entry.id === user.id)] = result.user;
      if (user.id === state.user.id) {
        await refreshMe();
        if (!state.user.isAdmin) {
          state.admin = null;
          toast('用户信息已保存', 'success');
          return navigate('dashboard');
        }
      }
      toast('用户信息已保存', 'success'); renderAdminFrame();
    });
    return;
  }

  const extendUser = event.target.closest('[data-admin-user-extend]');
  if (extendUser) {
    const user = userById(extendUser.dataset.adminUserExtend);
    openModal('开通或续期', `<p>为 <strong>${escapeHtml(user.email)}</strong> 从当前到期日继续顺延。</p><label><span>增加天数</span><input name="days" type="number" min="1" max="3650" value="30" required></label><label><span>开通等级</span><select name="tier"><option value="normal" ${user.tier === 'normal' ? 'selected' : ''}>基础版</option><option value="plus" ${user.tier === 'plus' ? 'selected' : ''}>Plus</option></select></label>`, async (form) => {
      const data = Object.fromEntries(new FormData(form));
      const result = await api(`/api/admin/users/${encodeURIComponent(user.id)}/extend`, { method: 'POST', body: { days: Number(data.days), tier: data.tier } });
      state.admin.users[state.admin.users.findIndex((entry) => entry.id === user.id)] = result.user;
      toast('套餐已开通', 'success'); renderAdminFrame();
    });
    return;
  }

  const resetPassword = event.target.closest('[data-admin-user-password]');
  if (resetPassword) {
    const user = userById(resetPassword.dataset.adminUserPassword);
    openModal('重置用户密码', `<p>重置后，<strong>${escapeHtml(user.email)}</strong> 的所有登录会话都会失效。</p><label><span>新密码</span><input name="password" type="password" minlength="8" maxlength="128" required autocomplete="new-password"></label>`, async (form) => {
      await api(`/api/admin/users/${encodeURIComponent(user.id)}/reset-password`, { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      toast('密码已重置', 'success');
    });
    return;
  }

  const newPlan = event.target.closest('[data-admin-plan-new]');
  if (newPlan) return planModal();
  const editPlan = event.target.closest('[data-admin-plan-edit]');
  if (editPlan) return planModal(planById(editPlan.dataset.adminPlanEdit));
  const deletePlan = event.target.closest('[data-admin-plan-delete]');
  if (deletePlan && confirm('确认下架这个套餐？已有订单不会被删除。')) {
    try {
      await api(`/api/admin/plans/${encodeURIComponent(deletePlan.dataset.adminPlanDelete)}`, { method: 'DELETE' });
      planById(deletePlan.dataset.adminPlanDelete).active = false;
      state.plans = null; toast('套餐已下架', 'success'); renderAdminFrame();
    } catch (error) { toast(error.message, 'error'); }
    return;
  }

  const deleteCode = event.target.closest('[data-admin-code-delete]');
  if (deleteCode && confirm('确认删除这个兑换码？')) {
    try {
      await api(`/api/admin/codes/${encodeURIComponent(deleteCode.dataset.adminCodeDelete)}`, { method: 'DELETE' });
      state.admin.codes = state.admin.codes.filter((code) => code.code !== deleteCode.dataset.adminCodeDelete);
      toast('兑换码已删除', 'success'); renderAdminFrame();
    } catch (error) { toast(error.message, 'error'); }
    return;
  }

  const copy = event.target.closest('[data-copy]');
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copy); toast('已复制到剪贴板', 'success'); }
    catch { toast('复制失败，请手动选择', 'error'); }
  }
});

document.querySelectorAll('[data-auth-tab]').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('[data-auth-tab]').forEach((item) => item.classList.toggle('active', item === tab));
  document.querySelector('#login-form').classList.toggle('hidden', tab.dataset.authTab !== 'login');
  document.querySelector('#register-form').classList.toggle('hidden', tab.dataset.authTab !== 'register');
}));

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  setBusy(button, true, '正在登录…');
  try {
    const result = await api('/api/login', { method: 'POST', body: Object.fromEntries(new FormData(event.currentTarget)) });
    resetPrivateState();
    state.user = result.user; state.csrfToken = result.csrfToken; showApp(); toast('登录成功', 'success');
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

document.querySelector('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  setBusy(button, true, '正在创建…');
  try {
    const result = await api('/api/register', { method: 'POST', body: Object.fromEntries(new FormData(event.currentTarget)) });
    resetPrivateState();
    state.user = result.user; state.csrfToken = result.csrfToken; showApp(); toast('账号创建成功', 'success');
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});

document.querySelectorAll('.nav-item, .profile-mini').forEach((item) => item.addEventListener('click', () => navigate(item.dataset.view)));
document.querySelector('#logout-button').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* cookie is cleared by UI state as fallback */ }
  showAuth(); toast('已经退出登录');
});
document.querySelector('#refresh-view').addEventListener('click', async () => {
  if (state.view === 'cars') state.cars = null;
  if (state.view === 'store') state.plans = null;
  if (state.view === 'orders') state.orders = null;
  if (state.view === 'admin') state.admin = null;
  try { await refreshMe(); await navigate(state.view, true); toast('页面已刷新', 'success'); }
  catch (error) { toast(error.message, 'error'); }
});
document.querySelector('#mobile-menu').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));

modalForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!modalHandler) return;
  const button = event.currentTarget.querySelector('button[type="submit"]');
  setBusy(button, true);
  try { await modalHandler(event.currentTarget); closeModal(); }
  catch (error) { toast(error.message, 'error'); }
  finally { setBusy(button, false); }
});
document.querySelector('#modal-close').addEventListener('click', closeModal);
document.querySelector('#modal-cancel').addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', (event) => { if (event.target === modalBackdrop) closeModal(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });

async function initialize() {
  try {
    state.config = await api('/api/config');
    document.title = state.config.siteName;
    document.querySelectorAll('[data-site-name]').forEach((element) => { element.textContent = state.config.siteName; });
    if (!state.config.registrationEnabled) {
      const tab = document.querySelector('[data-auth-tab="register"]');
      tab.disabled = true;
      tab.title = '站点暂未开放注册';
    }
    const params = new URLSearchParams(location.search);
    if (params.get('payment') === 'return') toast('支付页面已返回，订单状态以异步通知为准', 'success');
    try { await refreshMe(); showApp(); }
    catch { showAuth(); }
  } catch (error) {
    toast(`初始化失败：${error.message}`, 'error');
  }
}

initialize();
