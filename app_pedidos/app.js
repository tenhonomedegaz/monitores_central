// Frontend JavaScript for Orders Monitor Dashboard with Pagination & Custom Styles

let allOrders = [];
let allNotifications = [];
let filteredOrders = [];
let loadedNotificationIds = new Set();
let isFirstLoad = true;
let multiFilterState = {
    supplier: new Set(),
    franchise: new Set(),
    status: new Set()
};
let initialDataLoaded = false;
let startupOverlayDone = false;
let lastDataRevision = null;
let lastPayloadSignature = null;
let dataFetchInFlight = false;
const isElectronRuntime = navigator.userAgent.toLowerCase().includes('electron');

// Pagination State
let currentPage = 1;
let pageSize = 25;

// Web Notifications Settings (Loaded from localStorage)
let notificationPrefs = {
    enableNative: false,
    enableSound: true,
    statusRules: {} // { "status_description": true/false }
};

// DOM Elements
const syncStatusEl = document.getElementById('sync-status');
const btnSync = document.getElementById('btn-sync');
const btnSettings = document.getElementById('btn-settings');

// Settings Modal Elements
const settingsModal = document.getElementById('settings-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnCancelSettings = document.getElementById('btn-cancel-settings');
const btnSaveSettings = document.getElementById('btn-save-settings');
const chkEnableNative = document.getElementById('chk-enable-native');
const chkEnableSound = document.getElementById('chk-enable-sound');
const statusRulesList = document.getElementById('status-rules-list');

// KPI Elements
const valTotalEl = document.getElementById('val-total');
const valWaitingEl = document.getElementById('val-waiting');
const valStuck3dEl = document.getElementById('val-stuck-3d');
const valStuck7dEl = document.getElementById('val-stuck-7d');

// Filter Elements
const searchInput = document.getElementById('search-input');
const filterStuckDays = document.getElementById('filter-stuck-days');
const btnClearFilters = document.getElementById('btn-clear-filters');
const btnToggleFilters = document.getElementById('btn-toggle-filters');
const filtersContainer = document.querySelector('.filters-container');

// Custom Select Elements
const selectSupplier = document.getElementById('select-supplier');
const selectFranchise = document.getElementById('select-franchise');
const selectStatus = document.getElementById('select-status');
const selectSort = document.getElementById('select-sort');

// Count Badges
const ordersCountEl = document.getElementById('orders-count');
const notificationsCountEl = document.getElementById('notifications-count');

// Container lists
const ordersList = document.getElementById('orders-list');
const notificationsList = document.getElementById('notifications-list');
const toastContainer = document.getElementById('toast-container');
const startupLoading = document.getElementById('startup-loading');

// Pagination Elements
const pagStartEl = document.getElementById('pag-start');
const pagEndEl = document.getElementById('pag-end');
const pagTotalEl = document.getElementById('pag-total');
const pagPrevBtn = document.getElementById('pag-prev');
const pagNextBtn = document.getElementById('pag-next');
const pagCurrentNumEl = document.getElementById('pag-current-num');
const pagTotalPagesEl = document.getElementById('pag-total-pages');
const sizeButtons = document.querySelectorAll('.btn-size');

// Initial Load Setup
document.addEventListener('DOMContentLoaded', () => {
    loadNotificationPrefs();
    loadSharedNotificationPrefs();
    restoreFiltersVisibility();
    fetchData();
    setupEventListeners();
    setupCustomDropdowns();
    refreshSyncStatus();

    setInterval(refreshSyncStatus, 3000);
});

function repairMojibake(value) {
    if (typeof value !== 'string') return value;
    if (!/[\u00c3\u00c2\u00e2\u00f0]/.test(value)) return value;

    let repaired = value;
    try {
        repaired = decodeURIComponent(escape(value));
    } catch (err) {
        repaired = value;
    }

    return repaired
        .replace(/\u00e2\u009d\u008c/g, 'Erro:')
        .replace(/\u00e2\u009c\u0085/g, 'OK:')
        .replace(/\u00e2\u009a\u00a0\u00ef\u00b8\u008f/g, 'Atenção:')
        .replace(/\u00f0\u0178\u201d\u201d/g, 'Alerta:')
        .replace(/\u00e2\u20ac\u0093/g, '●')
        .replace(/\u00e2\u017e\u201d/g, '→')
        .replace(/\u00c2\u00b7/g, '·')
        .replace(/\u00c2\u00ba/g, 'º')
        .replace(/\u00c3\u0091/g, 'Ñ');
}

function cleanJsonStrings(value) {
    if (Array.isArray(value)) return value.map(cleanJsonStrings);
    if (value && typeof value === 'object') {
        Object.keys(value).forEach((key) => {
            value[key] = cleanJsonStrings(value[key]);
        });
        return value;
    }
    return repairMojibake(value);
}

// Event Listeners Setup
function setupEventListeners() {
    btnSync.addEventListener('click', forceSync);

    // Settings Modal Toggles
    btnSettings.addEventListener('click', openSettingsModal);
    btnCloseModal.addEventListener('click', closeSettingsModal);
    btnCancelSettings.addEventListener('click', closeSettingsModal);
    btnSaveSettings.addEventListener('click', saveNotificationPrefs);
    btnToggleFilters.addEventListener('click', toggleFiltersVisibility);

    // Native checkbox request permission
    chkEnableNative.addEventListener('change', async (e) => {
        if (e.target.checked && typeof Notification === 'undefined') {
            e.target.checked = false;
            showToast('Notificações nativas não estão disponíveis neste navegador.');
            return;
        }
        if (e.target.checked && Notification.permission !== 'granted') {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                e.target.checked = false;
                showToast('Erro: Permissão de notificação do Windows foi recusada.');
            }
        }
    });

    // Filtering events
    searchInput.addEventListener('input', () => { resetPage(); applyFilters(); });
    filterStuckDays.addEventListener('input', () => { resetPage(); applyFilters(); });

    btnClearFilters.addEventListener('click', () => {
        searchInput.value = '';
        filterStuckDays.value = '';
        resetCustomDropdowns();
        resetPage();
        applyFilters();
        showToast('Filtros limpos!');
    });

    // Pagination controls
    pagPrevBtn.addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage--;
            renderOrdersList();
            scrollToTopPanel();
        }
    });

    pagNextBtn.addEventListener('click', () => {
        const totalPages = Math.ceil(filteredOrders.length / pageSize);
        if (currentPage < totalPages) {
            currentPage++;
            renderOrdersList();
            scrollToTopPanel();
        }
    });

    // Page Size button handlers
    sizeButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            sizeButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            pageSize = parseInt(btn.dataset.size);
            resetPage();
            renderOrdersList();
        });
    });
}

function restoreFiltersVisibility() {
    const collapsed = localStorage.getItem('pedidos_filters_collapsed') === 'true';
    setFiltersVisibility(collapsed);
}

function toggleFiltersVisibility() {
    setFiltersVisibility(!filtersContainer.classList.contains('collapsed'));
}

function setFiltersVisibility(collapsed) {
    filtersContainer.classList.toggle('collapsed', collapsed);
    btnToggleFilters.querySelector('span').textContent = collapsed ? 'Mostrar filtros' : 'Ocultar filtros';
    localStorage.setItem('pedidos_filters_collapsed', String(collapsed));
}

async function refreshSyncStatus() {
    try {
        const response = await fetch('/api/pedidos/status');
        if (!response.ok) return;
        const status = await response.json();
        if (!startupOverlayDone && !initialDataLoaded && status.is_syncing) {
            startupLoading.classList.remove('hidden');
            startupLoading.querySelector('span').textContent = status.phase || 'sincronizando dados';
        } else if (!startupOverlayDone && initialDataLoaded) {
            startupLoading.classList.add('hidden');
            startupOverlayDone = true;
        }

        if (lastDataRevision === null) {
            lastDataRevision = status.revision;
        } else if (!status.is_syncing && status.revision !== lastDataRevision) {
            lastDataRevision = status.revision;
            await fetchData(false);
        }
    } catch (err) {
        // Keep the loading screen visible while the local server is starting.
    }
}

function payloadSignature(parts) {
    let hash = 2166136261;
    parts.forEach((part) => {
        for (let i = 0; i < part.length; i++) {
            hash ^= part.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
    });
    return `${hash >>> 0}:${parts.map(part => part.length).join(':')}`;
}

function resetPage() {
    currentPage = 1;
}

function scrollToTopPanel() {
    ordersList.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Custom Styled Select Dropdown logic
function setupCustomDropdowns() {
    // Helper to toggle dropdown
    const toggleDropdown = (el) => {
        const isOpen = el.classList.contains('open');
        // Close all dropdowns
        document.querySelectorAll('.custom-select').forEach(d => d.classList.remove('open'));
        if (!isOpen) {
            el.classList.add('open');
        }
    };

    // Bind triggers click
    document.querySelectorAll('.custom-select').forEach(el => {
        const trigger = el.querySelector('.select-trigger');
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleDropdown(el);
        });
    });

    // Close dropdowns on outside click
    document.addEventListener('click', () => {
        document.querySelectorAll('.custom-select').forEach(d => d.classList.remove('open'));
    });

    // Sort Select option handlers (they are hardcoded in HTML)
    const sortSelect = document.getElementById('select-sort');
    sortSelect.querySelectorAll('.option').forEach(opt => {
        opt.addEventListener('click', (e) => {
            e.stopPropagation();

            sortSelect.querySelectorAll('.option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');

            const trigger = sortSelect.querySelector('.select-trigger');
            trigger.dataset.value = opt.dataset.value;
            trigger.querySelector('span').textContent = opt.textContent;
            sortSelect.classList.remove('open');

            resetPage();
            applyFilters();
        });
    });
}

function updateMultiSelectTrigger(selectEl, selectedSet, defaultLabel) {
    const trigger = selectEl.querySelector('.select-trigger');
    const labelEl = trigger.querySelector('span');
    trigger.dataset.value = selectedSet.size === 0 ? 'all' : 'custom';

    if (selectedSet.size === 0) {
        labelEl.textContent = defaultLabel;
    } else if (selectedSet.size === 1) {
        labelEl.textContent = Array.from(selectedSet)[0];
    } else {
        labelEl.textContent = `${selectedSet.size} selecionados`;
    }
}

function registerMultiOptionClick(selectEl, selectedSet, defaultLabel) {
    selectEl.querySelectorAll('.checkbox-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
            e.stopPropagation();

            if (opt.dataset.value === 'all') {
                selectedSet.clear();
            } else if (selectedSet.has(opt.dataset.value)) {
                selectedSet.delete(opt.dataset.value);
            } else {
                selectedSet.add(opt.dataset.value);
            }

            renderMultiSelectState(selectEl, selectedSet, defaultLabel);
            resetPage();
            applyFilters();
        });
    });
}

function renderMultiSelectState(selectEl, selectedSet, defaultLabel) {
    selectEl.querySelectorAll('.checkbox-option').forEach(opt => {
        const isAll = opt.dataset.value === 'all';
        const isSelected = isAll ? selectedSet.size === 0 : selectedSet.has(opt.dataset.value);
        opt.classList.toggle('selected', isSelected);
    });
    updateMultiSelectTrigger(selectEl, selectedSet, defaultLabel);
}

function createCheckboxOption(value, label, selectedSet) {
    const div = document.createElement('div');
    const isSelected = value === 'all' ? selectedSet.size === 0 : selectedSet.has(value);
    div.className = `option checkbox-option ${isSelected ? 'selected' : ''}`;
    div.dataset.value = value;
    div.title = label;
    div.innerHTML = `
        <span class="option-check"><i class="fa-solid fa-check"></i></span>
        <span class="option-label"></span>
    `;
    div.querySelector('.option-label').textContent = label;
    return div;
}

function resetCustomDropdowns() {
    multiFilterState.supplier.clear();
    multiFilterState.franchise.clear();
    multiFilterState.status.clear();
    renderMultiSelectState(selectSupplier, multiFilterState.supplier, 'Todos fornecedores');
    renderMultiSelectState(selectFranchise, multiFilterState.franchise, 'Todas franquias');
    renderMultiSelectState(selectStatus, multiFilterState.status, 'Todas situações');

    // Reset Sort Select
    const trigSort = selectSort.querySelector('.select-trigger');
    trigSort.dataset.value = 'stuck-desc';
    trigSort.querySelector('span').textContent = 'Mais tempo sem alteração';
    selectSort.querySelectorAll('.option').forEach(o => {
        if (o.dataset.value === 'stuck-desc') o.classList.add('selected');
        else o.classList.remove('selected');
    });
}

// Fetch all data from local backend server
async function fetchData(showLoader = true) {
    if (dataFetchInFlight) return;
    dataFetchInFlight = true;
    if (showLoader) {
        setSyncState(true, 'Carregando...');
    }

    try {
        const [ordersRes, notificationsRes] = await Promise.all([
            fetch('/api/pedidos/list'),
            fetch('/api/pedidos/notificacoes')
        ]);

        if (!ordersRes.ok || !notificationsRes.ok) {
            throw new Error('Falha ao obter dados do servidor local.');
        }

        const payloads = await Promise.all([ordersRes.text(), notificationsRes.text()]);
        const signature = payloadSignature(payloads);
        const dataChanged = signature !== lastPayloadSignature;
        const isInitialRender = lastPayloadSignature === null;
        const hasSelectedOrder = Boolean(document.querySelector('.order-card.expanded'));
        initialDataLoaded = true;
        refreshSyncStatus();

        if (dataChanged) {
            allOrders = cleanJsonStrings(JSON.parse(payloads[0]));
            allNotifications = cleanJsonStrings(JSON.parse(payloads[1]));
            lastPayloadSignature = signature;
            if (isInitialRender || !hasSelectedOrder) {
                populateFilterDropdowns();
                populateStatusRulesList();
                renderDashboard();
            } else {
                updateKPIs();
                applyFilters(false);
            }
        }

        if (showLoader) {
            setSyncState(false, 'Atualizado');
        }
    } catch (err) {
        console.error(err);
        setSyncState(false, 'Erro de Conexão');
        showToast('Erro: Erro ao conectar com o servidor local.');
    } finally {
        dataFetchInFlight = false;
    }
}

// Sync with Franchisee Center API
async function forceSync() {
    btnSync.disabled = true;
    btnSync.classList.add('loading');
    setSyncState(true, 'Buscando atualizações recentes...');

    try {
        const response = await fetch('/api/pedidos/atualizar', { method: 'POST' });
        const result = await response.json();

        if (result.success) {
            showToast('OK: Banco de dados sincronizado e atualizado!');
            await fetchData(true);
        } else {
            showToast('Atenção: Falha ao sincronizar. Tente novamente.');
            setSyncState(false, 'Falha na Sincronização');
        }
    } catch (err) {
        console.error(err);
        showToast('Erro: Erro de rede ao tentar sincronizar.');
        setSyncState(false, 'Erro de Sincronização');
    } finally {
        btnSync.disabled = false;
        btnSync.classList.remove('loading');
    }
}

// Set header status text
function setSyncState(isLoading, message) {
    if (isLoading) {
        syncStatusEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>${message}</span>`;
    } else {
        const now = new Date();
        const formattedTime = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        syncStatusEl.innerHTML = `<i class="fa-solid fa-check-double" style="color: var(--success)"></i> <span>${message} às ${formattedTime}</span>`;
    }
}

// Populate Supplier, Franchise and Status filters
function populateFilterDropdowns() {
    const suppliers = new Set();
    const franchises = new Set();
    const statuses = new Set();

    allOrders.forEach(o => {
        if (o.fornecedor && o.fornecedor.nome) suppliers.add(o.fornecedor.nome);
        if (o.franqueado && o.franqueado.nome) franchises.add(o.franqueado.nome);
        if (o.situacao && o.situacao.descricao) statuses.add(o.situacao.descricao);
    });

    multiFilterState.supplier = new Set(Array.from(multiFilterState.supplier).filter(v => suppliers.has(v)));
    multiFilterState.franchise = new Set(Array.from(multiFilterState.franchise).filter(v => franchises.has(v)));
    multiFilterState.status = new Set(Array.from(multiFilterState.status).filter(v => statuses.has(v)));

    const optionsSupplier = document.getElementById('options-supplier');
    const optionsFranchise = document.getElementById('options-franchise');
    const optionsStatus = document.getElementById('options-status');

    optionsSupplier.innerHTML = '';
    optionsFranchise.innerHTML = '';
    optionsStatus.innerHTML = '';

    optionsSupplier.appendChild(createCheckboxOption('all', 'Todos fornecedores', multiFilterState.supplier));
    optionsFranchise.appendChild(createCheckboxOption('all', 'Todas franquias', multiFilterState.franchise));
    optionsStatus.appendChild(createCheckboxOption('all', 'Todas situações', multiFilterState.status));

    // Append suppliers
    Array.from(suppliers).sort().forEach(s => {
        optionsSupplier.appendChild(createCheckboxOption(s, s, multiFilterState.supplier));
    });

    // Append franchises
    Array.from(franchises).sort().forEach(f => {
        optionsFranchise.appendChild(createCheckboxOption(f, f, multiFilterState.franchise));
    });

    Array.from(statuses).sort().forEach(status => {
        optionsStatus.appendChild(createCheckboxOption(status, status, multiFilterState.status));
    });

    registerMultiOptionClick(selectSupplier, multiFilterState.supplier, 'Todos fornecedores');
    registerMultiOptionClick(selectFranchise, multiFilterState.franchise, 'Todas franquias');
    registerMultiOptionClick(selectStatus, multiFilterState.status, 'Todas situações');
    renderMultiSelectState(selectSupplier, multiFilterState.supplier, 'Todos fornecedores');
    renderMultiSelectState(selectFranchise, multiFilterState.franchise, 'Todas franquias');
    renderMultiSelectState(selectStatus, multiFilterState.status, 'Todas situações');
}

// Apply filters, sorting and paginate
function applyFilters(renderList = true) {
    const query = searchInput.value.toLowerCase().trim();
    const stuckDaysVal = filterStuckDays.value ? parseInt(filterStuckDays.value) : null;
    const sortVal = selectSort.querySelector('.select-trigger').dataset.value;

    // 1. Filtering
    filteredOrders = allOrders.filter(o => {
        // Query search
        const code = String(o.codigo || '').toLowerCase();
        const supplierName = (o.fornecedor?.nome || '').toLowerCase();
        const franchiseName = (o.franqueado?.nome || '').toLowerCase();
        const matchesQuery = !query ||
            code.includes(query) ||
            supplierName.includes(query) ||
            franchiseName.includes(query) ||
            (o.itensPedido && o.itensPedido.some(item => (item.descricaoProduto || '').toLowerCase().includes(query)));

        // Supplier
        const matchesSupplier = multiFilterState.supplier.size === 0 || multiFilterState.supplier.has(o.fornecedor?.nome);

        // Franchise
        const matchesFranchise = multiFilterState.franchise.size === 0 || multiFilterState.franchise.has(o.franqueado?.nome);

        // Status
        const matchesStatus = multiFilterState.status.size === 0 || multiFilterState.status.has(o.situacao?.descricao);

        // Inactivity (stuck days input)
        const lastDate = new Date(o.situacao?.dataAlteracao || o.updatedAt || o.dataCriacao || o.createdAt);
        const daysStuck = Math.floor((new Date() - lastDate) / (1000 * 60 * 60 * 24));
        const matchesInactivity = stuckDaysVal === null || daysStuck >= stuckDaysVal;

        return matchesQuery && matchesSupplier && matchesFranchise && matchesStatus && matchesInactivity;
    });

    // 2. Sorting
    filteredOrders.sort((a, b) => {
        const lastDateA = new Date(a.situacao?.dataAlteracao || a.updatedAt || a.dataCriacao || a.createdAt);
        const lastDateB = new Date(b.situacao?.dataAlteracao || b.updatedAt || b.dataCriacao || b.createdAt);

        const diffMsA = new Date() - lastDateA;
        const diffMsB = new Date() - lastDateB;

        if (sortVal === 'stuck-desc') {
            return diffMsB - diffMsA; // Longest stuck first
        } else if (sortVal === 'stuck-asc') {
            return diffMsA - diffMsB; // Shortest stuck first
        } else if (sortVal === 'date-desc') {
            const dateA = new Date(a.dataCriacao || a.createdAt);
            const dateB = new Date(b.dataCriacao || b.createdAt);
            return dateB - dateA; // Newest order date first
        } else if (sortVal === 'date-asc') {
            const dateA = new Date(a.dataCriacao || a.createdAt);
            const dateB = new Date(b.dataCriacao || b.createdAt);
            return dateA - dateB; // Oldest order date first
        }
        return 0;
    });

    ordersCountEl.textContent = filteredOrders.length;
    if (renderList) renderOrdersList();
    renderNotifications(!renderList);
}

// Render Dashboard components
function renderDashboard() {
    updateKPIs();
    applyFilters(); // will apply filters and render list
}

// Update KPI counts
function updateKPIs() {
    valTotalEl.textContent = allOrders.length;

    const waitingOrders = allOrders.filter(o => {
        const desc = (o.situacao?.descricao || '').toLowerCase();
        const status = (o.situacao?.status || '').toLowerCase();
        return desc.includes('pendente') || desc.includes('aguardando') || status.includes('pendente') || status.includes('aguardando');
    });
    valWaitingEl.textContent = waitingOrders.length;

    let stuck3d = 0;
    let stuck7d = 0;

    allOrders.forEach(o => {
        const lastDate = new Date(o.situacao?.dataAlteracao || o.updatedAt || o.dataCriacao || o.createdAt);
        const days = Math.floor((new Date() - lastDate) / (1000 * 60 * 60 * 24));
        if (days > 7) {
            stuck7d++;
            stuck3d++;
        } else if (days > 3) {
            stuck3d++;
        }
    });

    valStuck3dEl.textContent = stuck3d;
    valStuck7dEl.textContent = stuck7d;
}

// Format R$ currency
function formatCurrency(val) {
    if (val === undefined || val === null || isNaN(val)) return 'R$ 0,00';
    return val.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Calculate elapsed inactivity time
function getElapsedInfo(order) {
    const lastDate = new Date(order.situacao?.dataAlteracao || order.updatedAt || order.dataCriacao || order.createdAt);
    const now = new Date();
    const diffMs = now - lastDate;
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    let text = '';
    let statusClass = 'active-green';

    if (diffDays > 7) {
        text = `Inativo há ${diffDays} dias`;
        statusClass = 'active-danger';
    } else if (diffDays > 3) {
        text = `Inativo há ${diffDays} dias`;
        statusClass = 'active-warning';
    } else if (diffDays > 0) {
        text = diffDays === 1 ? 'Atualizado ontem' : `Atualizado há ${diffDays} dias`;
    } else if (diffHrs > 0) {
        text = diffHrs === 1 ? 'Atualizado há 1 hora' : `Atualizado há ${diffHrs} horas`;
    } else {
        text = diffMins <= 5 ? 'Atualizado agora mesmo' : `Atualizado há ${diffMins} minutos`;
    }

    return { text, statusClass, lastDateStr: lastDate.toLocaleString('pt-BR'), days: diffDays };
}

// Render paginated orders list
function renderOrdersList() {
    const totalCount = filteredOrders.length;

    // Pagination boundaries
    const totalPages = Math.ceil(totalCount / pageSize) || 1;
    if (currentPage > totalPages) currentPage = totalPages;

    const startIdx = (currentPage - 1) * pageSize;
    const endIdx = Math.min(startIdx + pageSize, totalCount);

    // Update pagination indicators
    pagStartEl.textContent = totalCount === 0 ? 0 : startIdx + 1;
    pagEndEl.textContent = endIdx;
    pagTotalEl.textContent = totalCount;
    pagCurrentNumEl.textContent = currentPage;
    pagTotalPagesEl.textContent = totalPages;

    pagPrevBtn.disabled = currentPage === 1;
    pagNextBtn.disabled = currentPage === totalPages;

    if (totalCount === 0) {
        ordersList.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-clipboard-question"></i>
                <p>Nenhum pedido correspondente encontrado.</p>
            </div>
        `;
        return;
    }

    ordersList.innerHTML = '';

    // Get the paginated subset of orders
    const pageOrders = filteredOrders.slice(startIdx, endIdx);

    pageOrders.forEach(o => {
        const elapsed = getElapsedInfo(o);
        const code = escapeHtml(o.codigo || 'S/N');
        const supplier = escapeHtml(o.fornecedor?.nome || 'Fornecedor Desconhecido');
        const franchise = escapeHtml(o.franqueado?.nome || 'Franquia Desconhecida');
        const orderIdAttr = escapeHtml(o._id || '');

        let statusBadgeColor = 'default';
        const statusColor = (o.situacao?.color || o.situacao?.cor || '').toLowerCase();
        if (statusColor.includes('orange') || statusColor.includes('gold') || statusColor === '#724d4b') statusBadgeColor = 'orange';
        else if (statusColor.includes('red') || statusColor === 'danger') statusBadgeColor = 'red';
        else if (statusColor.includes('green') || statusColor === 'success') statusBadgeColor = 'green';
        else if (statusColor.includes('blue') || statusColor === 'primary') statusBadgeColor = 'blue';
        else if (statusColor.includes('cyan') || statusColor === 'info') statusBadgeColor = 'cyan';

        const statusLabel = o.situacao?.descricao || 'Sem Situação';
        const safeStatusLabel = escapeHtml(statusLabel);

        let orderTotal = 0;
        let itemsHTML = '';
        if (o.itensPedido && Array.isArray(o.itensPedido)) {
            o.itensPedido.forEach(item => {
                const totalItem = (item.valorUnitario || 0) * (item.quantidadeProdutos || 0);
                orderTotal += totalItem;
                itemsHTML += `
                    <tr>
                        <td class="code-cell">${escapeHtml(item.codigo || '-')}</td>
                        <td>${escapeHtml(item.descricaoProduto || 'Produto sem descrição')}</td>
                        <td class="num-cell">${item.quantidadeProdutos || 0}</td>
                        <td class="num-cell">${formatCurrency(item.valorUnitario)}</td>
                        <td class="num-cell">${formatCurrency(totalItem)}</td>
                    </tr>
                `;
            });
        }

        const card = document.createElement('div');
        card.className = 'order-card';
        card.id = `card-${orderIdAttr}`;

        card.innerHTML = `
            <!-- Clickable Accordion Header -->
            <div class="order-card-header" onclick="toggleOrderAccordion('${orderIdAttr}')">
                <div class="order-meta-info">
                    <span class="order-code">
                        <i class="fa-solid fa-file-invoice"></i> #${code}
                    </span>
                    <span class="order-brief-info" title="${supplier} → ${franchise}">
                        ${supplier} → ${franchise}
                    </span>
                </div>
                <div class="header-actions-right">
                    <div class="time-elapsed-badge ${elapsed.statusClass}" style="padding: 4px 8px; font-size: 11px;">
                        ${elapsed.text}
                    </div>
                    <div class="status-badge ${statusBadgeColor}">
                        <span class="status-dot">●</span> ${safeStatusLabel}
                    </div>
                    <i class="fa-solid fa-chevron-down chevron-icon"></i>
                </div>
            </div>

            <!-- Collapsible Body Details -->
            <div class="order-card-body">
                <div class="order-parties">
                    <div class="party-info">
                        <span class="party-label">Fornecedor</span>
                        <span class="party-name" title="${supplier}">${supplier}</span>
                    </div>
                    <div class="party-info">
                        <span class="party-label">Franquia</span>
                        <span class="party-name" title="${franchise}">${franchise}</span>
                    </div>
                </div>

                <div class="order-meta-dates" style="margin-bottom: 6px;">
                    <span><i class="fa-regular fa-calendar-plus"></i> Criado em: ${new Date(o.dataCriacao || o.createdAt).toLocaleDateString('pt-BR')} ${new Date(o.dataCriacao || o.createdAt).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'})}</span>
                    <span><i class="fa-regular fa-clock"></i> Última alteração: ${elapsed.lastDateStr}</span>
                </div>

                <div class="order-items-preview">
                    <div class="items-list-container">
                        <table class="items-table">
                            <thead>
                                <tr>
                                    <th>Cód</th>
                                    <th>Produto</th>
                                    <th class="num-cell">Qtd</th>
                                    <th class="num-cell">Unit</th>
                                    <th class="num-cell">Total</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${itemsHTML || '<tr><td colspan="5" style="text-align:center">Nenhum item listado</td></tr>'}
                            </tbody>
                        </table>
                    </div>
                </div>

                <div class="order-card-footer">
                    <div class="time-elapsed-badge ${elapsed.statusClass}">
                        <i class="fa-regular fa-clock"></i> Sem alteração há ${elapsed.days} dias
                    </div>
                    <div class="order-total-preview">
                        Total: <strong>${formatCurrency(orderTotal)}</strong>
                    </div>
                </div>
            </div>
        `;

        ordersList.appendChild(card);
    });
}

// Toggle expansion of order accordion card
window.toggleOrderAccordion = function(orderId) {
    const card = document.getElementById(`card-${orderId}`);
    if (card) {
        card.classList.toggle('expanded');
    }
};

function renderNotificationItem(n) {
    const item = document.createElement('div');
    item.className = 'notification-item';

    const iconType = n.tipo === 'novo_pedido' ? 'fa-solid fa-file-circle-plus' : 'fa-solid fa-rotate';
    const typeClass = n.tipo || 'alteracao_status';

    const timestampDate = new Date(n.timestamp);
    const formattedTime = timestampDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) +
                          ' - ' + timestampDate.toLocaleDateString('pt-BR');

    item.innerHTML = `
        <div class="notif-icon ${typeClass}">
            <i class="${iconType}"></i>
        </div>
        <div class="notif-content">
            <div class="notif-message">${escapeHtml(n.mensagem)}</div>
            <div class="notif-time">${formattedTime}</div>
        </div>
    `;

    notificationsList.appendChild(item);
}

// Render recent status notifications log
function renderNotifications(preserveScroll = false) {
    const previousScrollTop = notificationsList.scrollTop;
    const previousScrollHeight = notificationsList.scrollHeight;
    const wasAtTop = previousScrollTop < 20;
    // Sort notifications by timestamp descending (newest first)
    allNotifications.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const visibleOrderIds = new Set(filteredOrders.map(o => o._id).filter(Boolean));
    const matchingNotifications = filteredOrders.length === allOrders.length
        ? allNotifications
        : allNotifications.filter(n => visibleOrderIds.has(n.order_id));
    const visibleNotifications = matchingNotifications.slice(0, 100);

    notificationsCountEl.textContent = visibleNotifications.length;

    if (visibleNotifications.length === 0) {

        notificationsList.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-bell-slash"></i>
                <p>Nenhuma alteração de situação detectada recentemente.</p>
            </div>
        `;
    } else {
        notificationsList.innerHTML = '';
        visibleNotifications.forEach(renderNotificationItem);
    }

    if (preserveScroll && !wasAtTop) {
        requestAnimationFrame(() => {
            notificationsList.scrollTop = previousScrollTop +
                Math.max(0, notificationsList.scrollHeight - previousScrollHeight);
        });
    }

    const pendingToasts = [];
    const pendingNativeAlerts = [];

    allNotifications.forEach((n) => {
        // Trigger alerts for unseen notifications
        if (!loadedNotificationIds.has(n.id)) {
            loadedNotificationIds.add(n.id);

            if (!isFirstLoad) {
                pendingToasts.push(n.mensagem);

                // Native windows notification check
                if (!isElectronRuntime && notificationPrefs.enableNative && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                    // Filter according to user preference rules
                    const statusVal = n.status_atual;
                    const ruleAllowed = notificationPrefs.statusRules[statusVal] !== false; // defaults to true
                    if (ruleAllowed) {
                        pendingNativeAlerts.push(n);
                    }
                }
            }
        }
    });

    // Display toasts (merged if many)
    if (pendingToasts.length > 0) {
        playNotificationSound();
        if (pendingToasts.length > 3) {
            showToast(`Alerta: ${pendingToasts.length} novas atualizações de pedidos recebidas!`);
        } else {
            pendingToasts.forEach(msg => showToast(`Alerta: ${msg}`));
        }
    }

    // Fire Native Windows Notifications
    if (pendingNativeAlerts.length > 0) {
        pendingNativeAlerts.forEach(n => {
            try {
                new Notification(n.tipo === 'novo_pedido' ? 'Novo Pedido Criado' : 'Situação do Pedido Alterada', {
                    body: n.mensagem,
                    icon: '/favicon.ico'
                });
            } catch (err) {
                console.error('Erro ao disparar notificação nativa:', err);
            }
        });
    }

    isFirstLoad = false;
}

function playNotificationSound() {
    if (!notificationPrefs.enableSound) return;

    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;

        const ctx = new AudioContext();
        const now = ctx.currentTime;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
        gain.connect(ctx.destination);

        [740, 988].forEach((freq, index) => {
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.value = freq;
            osc.connect(gain);
            osc.start(now + index * 0.12);
            osc.stop(now + 0.22 + index * 0.12);
        });

        setTimeout(() => ctx.close(), 700);
    } catch (err) {
        console.error('Falha ao tocar som de notificação:', err);
    }
}

// Toast notification pop-up
function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';

    toast.innerHTML = `
        <i class="fa-solid fa-bell"></i>
        <div class="toast-content"></div>
        <button class="toast-close" onclick="this.parentElement.classList.add('removing'); setTimeout(() => this.parentElement.remove(), 300);"><i class="fa-solid fa-xmark"></i></button>
    `;
    toast.querySelector('.toast-content').textContent = message;

    toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 300);
    }, 6000);
}

// Modal Toggle Functions
function openSettingsModal() {
    // Set checkbox checked state
    chkEnableNative.checked = notificationPrefs.enableNative;
    chkEnableSound.checked = notificationPrefs.enableSound;

    // Render status checkboxes inside modal
    populateStatusRulesList();

    settingsModal.classList.add('open');
}

function closeSettingsModal() {
    settingsModal.classList.remove('open');
}

// Fetch all distinct statuses from the cache and render checkboxes
function populateStatusRulesList() {
    const statusSet = new Set();

    allOrders.forEach(o => {
        if (o.situacao && o.situacao.descricao) {
            statusSet.add(o.situacao.descricao);
        }
    });

    // Also scan notifications to capture statuses of recently finished orders
    allNotifications.forEach(n => {
        if (n.status_atual) statusSet.add(n.status_atual);
        if (n.status_anterior) statusSet.add(n.status_anterior);
    });

    if (statusSet.size === 0) {
        statusRulesList.innerHTML = `<p class="settings-desc">Sem situações carregadas. Sincronize primeiro.</p>`;
        return;
    }

    statusRulesList.innerHTML = '';

    Array.from(statusSet).sort().forEach(status => {
        const item = document.createElement('div');
        item.className = 'status-rule-item';

        // Checked if not explicitly false (defaults to true)
        const isChecked = notificationPrefs.statusRules[status] !== false;

        item.innerHTML = `
            <label class="checkbox-label" style="font-weight: 500; font-size: 12px;">
                <input type="checkbox" class="chk-status-rule" data-status="${escapeHtml(status)}" ${isChecked ? 'checked' : ''}>
                <span class="custom-checkbox"></span>
                <span>${escapeHtml(status)}</span>
            </label>
        `;

        statusRulesList.appendChild(item);
    });
}

// Load notification settings from localStorage
function loadNotificationPrefs() {
    try {
        const saved = localStorage.getItem('orders_monitor_notifications');
        if (saved) {
            const parsed = jsonParseSafe(saved);
            if (parsed) {
                notificationPrefs = Object.assign(notificationPrefs, parsed);
            }
        }
    } catch (e) {
        console.error('Erro ao ler preferences:', e);
    }
}

async function loadSharedNotificationPrefs() {
    try {
        const response = await fetch('/api/pedidos/preferencias', { cache: 'no-store' });
        if (!response.ok) return;
        notificationPrefs = Object.assign(notificationPrefs, await response.json());
        localStorage.setItem('orders_monitor_notifications', JSON.stringify(notificationPrefs));
    } catch (e) {
        console.error('Erro ao carregar preferencias compartilhadas:', e);
    }
}

// Save notification preferences
async function saveNotificationPrefs() {
    notificationPrefs.enableNative = chkEnableNative.checked;
    notificationPrefs.enableSound = chkEnableSound.checked;

    // Collect settings from status checkboxes
    const rules = {};
    document.querySelectorAll('.chk-status-rule').forEach(chk => {
        rules[chk.dataset.status] = chk.checked;
    });
    notificationPrefs.statusRules = rules;

    try {
        localStorage.setItem('orders_monitor_notifications', JSON.stringify(notificationPrefs));
        const response = await fetch('/api/pedidos/preferencias', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(notificationPrefs)
        });
        if (!response.ok) throw new Error('Falha ao salvar no servidor local');
        showToast('OK: Preferências de notificação salvas com sucesso!');
        closeSettingsModal();

        // Trigger list re-render just to apply updates
        renderNotifications();
    } catch (e) {
        console.error('Erro ao salvar preferences:', e);
        showToast('Erro: Falha ao salvar preferências localmente.');
    }
}

function jsonParseSafe(str) {
    try {
        return JSON.parse(str);
    } catch (e) {
        return null;
    }
}
