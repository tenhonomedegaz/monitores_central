// Frontend JavaScript for Tickets Monitor Dashboard (app_chamados)

let allTickets = [];
let allNotifications = [];
let feedbackStats = { average: null, count: 0 };
let filteredTickets = [];
let loadedNotificationIds = new Set();
let isFirstLoad = true;
let multiFilterState = {
    status: new Set(),
    attendant: new Set(),
    category: new Set(),
    franchise: new Set(),
    type: new Set(),
    waiting: new Set()
};
let filterOptionsCache = {
    attendants: new Set(),
    categories: new Set()
};
let initialDataLoaded = false;
let startupOverlayDone = false;

// Pagination State
let currentPage = 1;
let pageSize = 25;

// Web Notifications Preferences (Stored in localStorage)
let notificationPrefs = {
    enableNative: false,
    enableSound: true,
    ruleNew: true,
    ruleStatus: true,
    ruleReply: true,
    ruleCategory: true,
    ruleAttendant: true,
    attendantFilters: [],
    categoryFilters: []
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
const chkRuleNew = document.getElementById('chk-rule-new');
const chkRuleStatus = document.getElementById('chk-rule-status');
const chkRuleReply = document.getElementById('chk-rule-reply');
const chkRuleCategory = document.getElementById('chk-rule-category');
const chkRuleAttendant = document.getElementById('chk-rule-attendant');

// KPI Elements
const valTotalEl = document.getElementById('val-total');
const valWaitingFranchisorEl = document.getElementById('val-waiting-franchisor');
const valWaitingFranchiseeEl = document.getElementById('val-waiting-franchisee');
const valCriticalEl = document.getElementById('val-critical');
const valFeedbackEl = document.getElementById('val-feedback');
const valFeedbackDetailEl = document.getElementById('val-feedback-detail');
const feedbackBreakdownEl = document.getElementById('feedback-breakdown');

// Filter Elements
const searchInput = document.getElementById('search-input');
const filterStuckDays = document.getElementById('filter-stuck-days');
const filterCreatedFrom = document.getElementById('filter-created-from');
const filterCreatedTo = document.getElementById('filter-created-to');
const btnClearFilters = document.getElementById('btn-clear-filters');
const btnToggleFilters = document.getElementById('btn-toggle-filters');
const filtersPanel = document.getElementById('filters-panel');

// Custom Select Elements
const selectStatus = document.getElementById('select-status');
const selectAttendant = document.getElementById('select-attendant');
const selectCategory = document.getElementById('select-category');
const selectFranchise = document.getElementById('select-franchise');
const selectType = document.getElementById('select-type');
const selectWaiting = document.getElementById('select-waiting');
const selectSort = document.getElementById('select-sort');
const notifSelectAttendant = document.getElementById('notif-select-attendant');
const notifSelectCategory = document.getElementById('notif-select-category');

// Count Badges
const ticketsCountEl = document.getElementById('tickets-count');
const notificationsCountEl = document.getElementById('notifications-count');

// Container lists
const ticketsList = document.getElementById('tickets-list');
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

// Initial setup
document.addEventListener('DOMContentLoaded', () => {
    loadNotificationPrefs();
    restoreFiltersVisibility();
    fetchData();
    setupEventListeners();
    setupCustomDropdowns();
    populateStaticMultiDropdowns();
    refreshSyncStatus();

    // Auto-refresh data every 60 seconds
    setInterval(() => {
        fetchData(false);
    }, 60000);
    setInterval(refreshSyncStatus, 3000);
});

function htmlToPlainText(value) {
    if (value === null || value === undefined) return '';
    const html = String(value)
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/\s*p\s*>/gi, '\n')
        .replace(/<\s*p[^>]*>/gi, '')
        .replace(/<\/\s*div\s*>/gi, '\n')
        .replace(/<\s*div[^>]*>/gi, '');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body.textContent
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function formatTextBlock(value) {
    const text = htmlToPlainText(value);
    return escapeHtml(text).replace(/\n/g, '<br>');
}

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

// Setup event handlers
function setupEventListeners() {
    btnSync.addEventListener('click', forceSync);

    // Settings modal triggers
    btnSettings.addEventListener('click', openSettingsModal);
    btnCloseModal.addEventListener('click', closeSettingsModal);
    btnCancelSettings.addEventListener('click', closeSettingsModal);
    btnSaveSettings.addEventListener('click', saveNotificationPrefs);
    btnToggleFilters.addEventListener('click', toggleFiltersVisibility);

    // Request push notification permission
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
                showToast('Erro: Permissão de notificação do Windows recusada.');
            }
        }
    });

    // Filters events
    searchInput.addEventListener('input', () => { resetPage(); applyFilters(); });
    filterStuckDays.addEventListener('input', () => { resetPage(); applyFilters(); });
    filterCreatedFrom.addEventListener('change', () => { resetPage(); applyFilters(); });
    filterCreatedTo.addEventListener('change', () => { resetPage(); applyFilters(); });

    btnClearFilters.addEventListener('click', () => {
        searchInput.value = '';
        filterStuckDays.value = '';
        filterCreatedFrom.value = '';
        filterCreatedTo.value = '';
        resetCustomDropdowns();
        resetPage();
        applyFilters();
        showToast('Filtros limpos!');
    });

    // Pagination controls
    pagPrevBtn.addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage--;
            renderTicketsList();
            scrollToTopPanel();
        }
    });

    pagNextBtn.addEventListener('click', () => {
        const totalPages = Math.ceil(filteredTickets.length / pageSize);
        if (currentPage < totalPages) {
            currentPage++;
            renderTicketsList();
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
            renderTicketsList();
        });
    });
}

function restoreFiltersVisibility() {
    const collapsed = localStorage.getItem('chamados_filters_collapsed') === 'true';
    setFiltersVisibility(collapsed);
}

function toggleFiltersVisibility() {
    setFiltersVisibility(!filtersPanel.classList.contains('collapsed'));
}

function setFiltersVisibility(collapsed) {
    filtersPanel.classList.toggle('collapsed', collapsed);
    btnToggleFilters.querySelector('span').textContent = collapsed ? 'Mostrar filtros' : 'Ocultar filtros';
    btnToggleFilters.querySelector('i').className = collapsed ? 'fa-solid fa-sliders' : 'fa-solid fa-sliders';
    localStorage.setItem('chamados_filters_collapsed', String(collapsed));
}

async function refreshSyncStatus() {
    try {
        const response = await fetch('/api/chamados/status');
        if (!response.ok) return;
        const status = await response.json();
        if (startupOverlayDone) return;
        if (status.is_syncing) {
            startupLoading.classList.remove('hidden');
            startupLoading.querySelector('span').textContent = status.phase || 'sincronizando dados';
        } else if (initialDataLoaded) {
            startupLoading.classList.add('hidden');
            startupOverlayDone = true;
        }
    } catch (err) {
        // Keep the loading screen visible while the local server is starting.
    }
}

function resetPage() {
    currentPage = 1;
}

function scrollToTopPanel() {
    ticketsList.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Custom Select Menus handlers
function setupCustomDropdowns() {
    const toggleDropdown = (el) => {
        const isOpen = el.classList.contains('open');
        document.querySelectorAll('.custom-select').forEach(d => d.classList.remove('open'));
        if (!isOpen) {
            el.classList.add('open');
        }
    };

    document.querySelectorAll('.custom-select').forEach(el => {
        const trigger = el.querySelector('.select-trigger');
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleDropdown(el);
        });
    });

    document.addEventListener('click', () => {
        document.querySelectorAll('.custom-select').forEach(d => d.classList.remove('open'));
    });

    // Register clicks on hardcoded custom selects
    const hardcodedSelects = [selectSort];
    hardcodedSelects.forEach(selectEl => {
        selectEl.querySelectorAll('.option').forEach(opt => {
            opt.addEventListener('click', (e) => {
                e.stopPropagation();
                selectEl.querySelectorAll('.option').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');

                const trigger = selectEl.querySelector('.select-trigger');
                trigger.dataset.value = opt.dataset.value;
                trigger.querySelector('span').textContent = opt.textContent;
                selectEl.classList.remove('open');

                resetPage();
                applyFilters();
            });
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

function renderMultiSelectState(selectEl, selectedSet, defaultLabel) {
    selectEl.querySelectorAll('.checkbox-option').forEach(opt => {
        const isAll = opt.dataset.value === 'all';
        const isSelected = isAll ? selectedSet.size === 0 : selectedSet.has(opt.dataset.value);
        opt.classList.toggle('selected', isSelected);
    });
    updateMultiSelectTrigger(selectEl, selectedSet, defaultLabel);
}

function registerMultiOptionClick(selectEl, selectedSet, defaultLabel, callback) {
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
            callback();
        });
    });
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

function populateStaticMultiDropdowns() {
    const optionsStatus = document.getElementById('options-status');
    const optionsType = document.getElementById('options-type');
    const optionsWaiting = document.getElementById('options-waiting');
    if (!optionsStatus || !optionsType || !optionsWaiting) return;

    optionsStatus.innerHTML = '';
    optionsType.innerHTML = '';
    optionsWaiting.innerHTML = '';

    optionsStatus.appendChild(createCheckboxOption('all', 'Todos os status', multiFilterState.status));
    optionsStatus.appendChild(createCheckboxOption('open', 'Aberto', multiFilterState.status));
    optionsStatus.appendChild(createCheckboxOption('inAttendance', 'Em Atendimento / Em Andamento', multiFilterState.status));
    optionsStatus.appendChild(createCheckboxOption('awaitingFeedback', 'Aguardando Feedback', multiFilterState.status));
    optionsStatus.appendChild(createCheckboxOption('reopen', 'Reaberto', multiFilterState.status));
    optionsStatus.appendChild(createCheckboxOption('finished', 'Concluído / Finalizado', multiFilterState.status));

    optionsType.appendChild(createCheckboxOption('all', 'Todos', multiFilterState.type));
    optionsType.appendChild(createCheckboxOption('franchisee', 'Chamados de Franquias', multiFilterState.type));
    optionsType.appendChild(createCheckboxOption('internal', 'Chamados Internos', multiFilterState.type));
    optionsWaiting.appendChild(createCheckboxOption('all', 'Qualquer um', multiFilterState.waiting));
    optionsWaiting.appendChild(createCheckboxOption('franchisor', 'Franqueador (Suporte)', multiFilterState.waiting));
    optionsWaiting.appendChild(createCheckboxOption('franchisee', 'Franqueado (Solicitante)', multiFilterState.waiting));

    registerMultiOptionClick(selectStatus, multiFilterState.status, 'Todos os status', () => { resetPage(); applyFilters(); });
    registerMultiOptionClick(selectType, multiFilterState.type, 'Todos', () => { resetPage(); applyFilters(); });
    registerMultiOptionClick(selectWaiting, multiFilterState.waiting, 'Qualquer um', () => { resetPage(); applyFilters(); });

    renderMultiSelectState(selectStatus, multiFilterState.status, 'Todos os status');
    renderMultiSelectState(selectType, multiFilterState.type, 'Todos');
    renderMultiSelectState(selectWaiting, multiFilterState.waiting, 'Qualquer um');
}

function resetCustomDropdowns() {
    multiFilterState.status.clear();
    multiFilterState.attendant.clear();
    multiFilterState.category.clear();
    multiFilterState.franchise.clear();
    multiFilterState.type.clear();
    multiFilterState.waiting.clear();
    renderMultiSelectState(selectStatus, multiFilterState.status, 'Todos os status');
    renderMultiSelectState(selectAttendant, multiFilterState.attendant, 'Todos atendentes');
    renderMultiSelectState(selectCategory, multiFilterState.category, 'Todas categorias');
    renderMultiSelectState(selectFranchise, multiFilterState.franchise, 'Todas franquias');
    renderMultiSelectState(selectType, multiFilterState.type, 'Todos');
    renderMultiSelectState(selectWaiting, multiFilterState.waiting, 'Qualquer um');

    // Reset Sort Select
    const trigSort = selectSort.querySelector('.select-trigger');
    trigSort.dataset.value = 'stuck-desc';
    trigSort.querySelector('span').textContent = 'Mais tempo sem resposta';
    selectSort.querySelectorAll('.option').forEach(o => {
        if (o.dataset.value === 'stuck-desc') o.classList.add('selected');
        else o.classList.remove('selected');
    });
}

// Fetch all data from backend
async function fetchData(showLoader = true) {
    if (showLoader) {
        setSyncState(true, 'Carregando...');
    }

    try {
        const [ticketsRes, notificationsRes, feedbackRes] = await Promise.all([
            fetch('/api/chamados/list'),
            fetch('/api/chamados/notificacoes'),
            fetch('/api/chamados/feedback')
        ]);

        if (!ticketsRes.ok || !notificationsRes.ok || !feedbackRes.ok) {
            throw new Error('Falha ao se conectar com o servidor local.');
        }

        allTickets = cleanJsonStrings(await ticketsRes.json());
        allNotifications = cleanJsonStrings(await notificationsRes.json());
        feedbackStats = cleanJsonStrings(await feedbackRes.json());
        initialDataLoaded = true;
        refreshSyncStatus();

        populateFilterDropdowns();
        renderDashboard();

        if (showLoader) {
            setSyncState(false, 'Atualizado');
        }
    } catch (err) {
        console.error(err);
        setSyncState(false, 'Erro de Conexão');
        showToast('Erro: Erro de conexão com o servidor local.');
    }
}

// Force sync with Central do Franqueado API
async function forceSync() {
    btnSync.disabled = true;
    btnSync.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Sincronizando...</span>';
    setSyncState(true, 'Buscando API v3...');

    try {
        const response = await fetch('/api/chamados/atualizar', { method: 'POST' });
        const result = await response.json();

        if (result.success) {
            showToast('OK: Chamados atualizados e sincronizados!');
            await fetchData(true);
        } else {
            showToast('Atenção: Falha ao sincronizar. Tente novamente.');
            setSyncState(false, 'Falha na Sincronização');
        }
    } catch (err) {
        console.error(err);
        showToast('Erro: Erro de rede ao sincronizar.');
        setSyncState(false, 'Erro de Rede');
    } finally {
        btnSync.disabled = false;
        btnSync.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> <span>Sincronizar</span>';
    }
}

function setSyncState(isLoading, message) {
    if (isLoading) {
        syncStatusEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>${message}</span>`;
    } else {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        syncStatusEl.innerHTML = `<i class="fa-solid fa-check-double" style="color: var(--success)"></i> <span>${message} às ${timeStr}</span>`;
    }
}

// Populate Attendants and Categories dropdown options dynamically
function populateFilterDropdowns() {
    const attendants = new Set();
    const categories = new Set();
    const franchises = new Set();

    allTickets.forEach(t => {
        if (t.attendantName) attendants.add(t.attendantName);
        if (t.category && t.category.name) categories.add(t.category.name);
        if (t.franchisee && t.franchisee.name) franchises.add(t.franchisee.name);
    });
    filterOptionsCache = { attendants, categories };

    multiFilterState.attendant = new Set(Array.from(multiFilterState.attendant).filter(v => attendants.has(v)));
    multiFilterState.category = new Set(Array.from(multiFilterState.category).filter(v => categories.has(v)));
    multiFilterState.franchise = new Set(Array.from(multiFilterState.franchise).filter(v => franchises.has(v)));
    notificationPrefs.attendantFilters = (notificationPrefs.attendantFilters || []).filter(v => attendants.has(v));
    notificationPrefs.categoryFilters = (notificationPrefs.categoryFilters || []).filter(v => categories.has(v));

    const optionsAttendant = document.getElementById('options-attendant');
    const optionsCategory = document.getElementById('options-category');
    const optionsFranchise = document.getElementById('options-franchise');

    optionsAttendant.innerHTML = '';
    optionsCategory.innerHTML = '';
    optionsFranchise.innerHTML = '';
    optionsAttendant.appendChild(createCheckboxOption('all', 'Todos atendentes', multiFilterState.attendant));
    optionsCategory.appendChild(createCheckboxOption('all', 'Todas categorias', multiFilterState.category));
    optionsFranchise.appendChild(createCheckboxOption('all', 'Todas franquias', multiFilterState.franchise));

    Array.from(attendants).sort().forEach(att => {
        optionsAttendant.appendChild(createCheckboxOption(att, att, multiFilterState.attendant));
    });

    Array.from(categories).sort().forEach(cat => {
        optionsCategory.appendChild(createCheckboxOption(cat, cat, multiFilterState.category));
    });

    Array.from(franchises).sort().forEach(franchise => {
        optionsFranchise.appendChild(createCheckboxOption(franchise, franchise, multiFilterState.franchise));
    });

    registerMultiOptionClick(selectAttendant, multiFilterState.attendant, 'Todos atendentes', () => { resetPage(); applyFilters(); });
    registerMultiOptionClick(selectCategory, multiFilterState.category, 'Todas categorias', () => { resetPage(); applyFilters(); });
    registerMultiOptionClick(selectFranchise, multiFilterState.franchise, 'Todas franquias', () => { resetPage(); applyFilters(); });
    renderMultiSelectState(selectAttendant, multiFilterState.attendant, 'Todos atendentes');
    renderMultiSelectState(selectCategory, multiFilterState.category, 'Todas categorias');
    renderMultiSelectState(selectFranchise, multiFilterState.franchise, 'Todas franquias');
    populateNotificationFilterDropdowns(attendants, categories);
}

function populateNotificationFilterDropdowns(attendants, categories) {
    if (!notifSelectAttendant || !notifSelectCategory) return;

    const attendantSet = new Set(notificationPrefs.attendantFilters || []);
    const categorySet = new Set(notificationPrefs.categoryFilters || []);
    const optionsAttendant = document.getElementById('notif-options-attendant');
    const optionsCategory = document.getElementById('notif-options-category');

    optionsAttendant.innerHTML = '';
    optionsCategory.innerHTML = '';
    optionsAttendant.appendChild(createCheckboxOption('all', 'Todos atendentes', attendantSet));
    optionsCategory.appendChild(createCheckboxOption('all', 'Todas categorias', categorySet));

    Array.from(attendants).sort().forEach(att => {
        optionsAttendant.appendChild(createCheckboxOption(att, att, attendantSet));
    });

    Array.from(categories).sort().forEach(cat => {
        optionsCategory.appendChild(createCheckboxOption(cat, cat, categorySet));
    });

    registerMultiOptionClick(notifSelectAttendant, attendantSet, 'Todos atendentes', () => {
        notificationPrefs.attendantFilters = Array.from(attendantSet);
    });
    registerMultiOptionClick(notifSelectCategory, categorySet, 'Todas categorias', () => {
        notificationPrefs.categoryFilters = Array.from(categorySet);
    });
    renderMultiSelectState(notifSelectAttendant, attendantSet, 'Todos atendentes');
    renderMultiSelectState(notifSelectCategory, categorySet, 'Todas categorias');
}

// Helper to determine who the ticket is waiting response from
function getWaitingInfo(t) {
    if (t.status === 'finished') {
        return { value: 'none', label: 'Concluído', badgeClass: '' };
    }
    let lastActor = t.lastInteractionBy;
    if (!lastActor && Array.isArray(t.answers) && t.answers.length > 0) {
        const lastAnswer = t.answers[t.answers.length - 1];
        lastActor = lastAnswer.isUserResponse ? 'franchisee' : 'franchisor';
    }
    if (lastActor === 'franchisor' || lastActor === 'attendant') {
        return { value: 'franchisee', label: 'Aguardando Franqueado', badgeClass: 'waiting-franchisee' };
    } else {
        // Defaults to waiting for franchisor if no messages or last message is from franchisee
        return { value: 'franchisor', label: 'Aguardando Franqueador', badgeClass: 'waiting-franchisor' };
    }
}

function getLastTicketInteractionDate(t) {
    if (Array.isArray(t.answers) && t.answers.length > 0) {
        const lastAnswer = t.answers[t.answers.length - 1];
        if (lastAnswer.answeredAt) return new Date(lastAnswer.answeredAt);
    }
    return new Date(t.lastAnswerAt || t.lastInteractionAt || t.updatedAt || t.createdAt);
}

function formatElapsedTime(diffMins, diffHrs, diffDays) {
    if (diffDays > 0) {
        return diffDays === 1 ? '1 dia sem resposta' : `${diffDays} dias sem resposta`;
    }
    if (diffHrs > 0) {
        return diffHrs === 1 ? '1 hora sem resposta' : `${diffHrs} horas sem resposta`;
    }
    return diffMins <= 1 ? 'Agora mesmo' : `${diffMins} min sem resposta`;
}

// Helper to calculate time elapsed without reply and SLA color.
function getElapsedInfo(t) {
    const lastDate = getLastTicketInteractionDate(t);
    const diffMs = new Date() - lastDate;
    const diffMins = Math.max(0, Math.floor(diffMs / (1000 * 60)));
    const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const waiting = getWaitingInfo(t);

    let statusClass = 'active-green';
    if (waiting.value === 'franchisor') {
        if (diffHrs >= 12) statusClass = 'active-danger';
        else if (diffHrs >= 2) statusClass = 'active-orange';
        else if (diffHrs >= 1) statusClass = 'active-warning';
    } else if (diffDays > 7) {
        statusClass = 'active-danger';
    } else if (diffDays > 3) {
        statusClass = 'active-warning';
    }

    return {
        minutes: diffMins,
        hours: diffHrs,
        days: diffDays,
        text: formatElapsedTime(diffMins, diffHrs, diffDays),
        statusClass,
        dateStr: lastDate.toLocaleString('pt-BR')
    };
}

// Apply filters, sorts, pagination, and updates list
function applyFilters() {
    const query = searchInput.value.toLowerCase().trim();
    const stuckHoursVal = filterStuckDays.value ? parseInt(filterStuckDays.value) : null;
    const createdFromVal = filterCreatedFrom.value ? new Date(`${filterCreatedFrom.value}T00:00:00`) : null;
    const createdToVal = filterCreatedTo.value ? new Date(`${filterCreatedTo.value}T23:59:59`) : null;
    const sortVal = selectSort.querySelector('.select-trigger').dataset.value;

    // 1. Filtering
    filteredTickets = allTickets.filter(t => {
        // Query text search
        const code = String(t.code || '').toLowerCase();
        const subject = (t.subject || '').toLowerCase();
        const requester = (t.requester?.name || '').toLowerCase();
        const franchisee = (t.franchisee?.name || '').toLowerCase();
        const category = (t.category?.name || '').toLowerCase();

        const matchesQuery = !query ||
            code.includes(query) ||
            subject.includes(query) ||
            requester.includes(query) ||
            franchisee.includes(query) ||
            category.includes(query);

        // Status filter
        const matchesStatus = multiFilterState.status.size === 0 || multiFilterState.status.has(t.status || 'open');

        // Attendant filter
        const matchesAttendant = multiFilterState.attendant.size === 0 || multiFilterState.attendant.has(t.attendantName);

        // Category filter
        const matchesCategory = multiFilterState.category.size === 0 || multiFilterState.category.has(t.category?.name);

        const matchesFranchise = multiFilterState.franchise.size === 0 || multiFilterState.franchise.has(t.franchisee?.name);

        // Type filter
        let matchesType = true;
        if (multiFilterState.type.size > 0) {
            const typeKey = t.isInternal ? 'internal' : 'franchisee';
            matchesType = multiFilterState.type.has(typeKey);
        }

        // Waiting state filter
        const waitingInfo = getWaitingInfo(t);
        const matchesWaiting = multiFilterState.waiting.size === 0 || multiFilterState.waiting.has(waitingInfo.value);

        // Inactivity days filter
        const elapsed = getElapsedInfo(t);
        const matchesInactivity = stuckHoursVal === null || elapsed.hours >= stuckHoursVal;

        const createdAt = new Date(t.createdAt);
        const matchesCreatedFrom = !createdFromVal || createdAt >= createdFromVal;
        const matchesCreatedTo = !createdToVal || createdAt <= createdToVal;

        return matchesQuery && matchesStatus && matchesAttendant && matchesCategory && matchesFranchise && matchesType && matchesWaiting && matchesInactivity && matchesCreatedFrom && matchesCreatedTo;
    });

    // 2. Sorting
    filteredTickets.sort((a, b) => {
        const lastDateA = getLastTicketInteractionDate(a);
        const lastDateB = getLastTicketInteractionDate(b);

        if (sortVal === 'stuck-desc') {
            return lastDateA - lastDateB; // Oldest update first (longest stuck)
        } else if (sortVal === 'stuck-asc') {
            return lastDateB - lastDateA; // Newest update first (least stuck)
        } else if (sortVal === 'date-desc') {
            return new Date(b.createdAt) - new Date(a.createdAt); // Newest creation first
        } else if (sortVal === 'date-asc') {
            return new Date(a.createdAt) - new Date(b.createdAt); // Oldest creation first
        }
        return 0;
    });

    ticketsCountEl.textContent = filteredTickets.length;
    renderTicketsList();
    renderNotifications();
}

// Render dashboard components
function renderDashboard() {
    updateKPIs();
    applyFilters();
    renderNotifications();
}

// Calculate and render KPIs count
function updateKPIs() {
    // Only count active (non-finished) tickets for KPIs
    const activeTickets = allTickets.filter(t => t.status !== 'finished');
    valTotalEl.textContent = activeTickets.length;

    let waitingFranchisor = 0;
    let waitingFranchisee = 0;
    let critical = 0;

    activeTickets.forEach(t => {
        const waiting = getWaitingInfo(t);
        if (waiting.value === 'franchisor') waitingFranchisor++;
        if (waiting.value === 'franchisee') waitingFranchisee++;

        const prio = (t.priority || '').toLowerCase();
        if (prio === 'high' || prio === 'critical') critical++;

    });

    valWaitingFranchisorEl.textContent = waitingFranchisor;
    valWaitingFranchiseeEl.textContent = waitingFranchisee;
    valCriticalEl.textContent = critical;
    const feedbackCount = Number(feedbackStats.count || 0);
    const feedbackAverage = Number(feedbackStats.average);
    if (feedbackCount > 0 && Number.isFinite(feedbackAverage)) {
        valFeedbackEl.textContent = feedbackAverage.toFixed(1);
        valFeedbackDetailEl.textContent = `Rede global · ${feedbackCount} avaliação${feedbackCount === 1 ? '' : 'ões'} · ${feedbackStats.lookbackDays || 120} dias`;
        renderFeedbackBreakdown(feedbackStats.byAttendant || []);
    } else {
        valFeedbackEl.textContent = '-';
        valFeedbackDetailEl.textContent = 'sem avaliações';
        feedbackBreakdownEl.innerHTML = '';
    }
}

function renderFeedbackBreakdown(items) {
    if (!feedbackBreakdownEl) return;
    const ranked = items
        .filter(item => Number(item.count || 0) > 0)
        .sort((a, b) => Number(b.average || 0) - Number(a.average || 0) || (b.count || 0) - (a.count || 0))
        .slice(0, 5);

    feedbackBreakdownEl.innerHTML = '';
    ranked.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = 'feedback-row';
        row.innerHTML = `
            <span class="feedback-rank">${index + 1}º</span>
            <span class="feedback-name"></span>
            <span class="feedback-score">${Number(item.average || 0).toFixed(2)} média</span>
        `;
        row.querySelector('.feedback-name').textContent = item.attendant || 'Não atribuído';
        feedbackBreakdownEl.appendChild(row);
    });
}

// Render ticket cards with pagination
function renderTicketsList() {
    const totalCount = filteredTickets.length;
    const totalPages = Math.ceil(totalCount / pageSize) || 1;

    if (currentPage > totalPages) currentPage = totalPages;

    const startIdx = (currentPage - 1) * pageSize;
    const endIdx = Math.min(startIdx + pageSize, totalCount);

    // Update pagination tags
    pagStartEl.textContent = totalCount === 0 ? 0 : startIdx + 1;
    pagEndEl.textContent = endIdx;
    pagTotalEl.textContent = totalCount;
    pagCurrentNumEl.textContent = currentPage;
    pagTotalPagesEl.textContent = totalPages;

    pagPrevBtn.disabled = currentPage === 1;
    pagNextBtn.disabled = currentPage === totalPages;

    if (totalCount === 0) {
        ticketsList.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-clipboard-question"></i>
                <p>Nenhum chamado correspondente encontrado.</p>
            </div>
        `;
        return;
    }

    ticketsList.innerHTML = '';
    const pageSlice = filteredTickets.slice(startIdx, endIdx);

    pageSlice.forEach(t => {
        const elapsed = getElapsedInfo(t);
        const waiting = getWaitingInfo(t);

        let priorityLabel = 'Normal';
        const prioKey = (t.priority || 'normal').toLowerCase();
        if (prioKey === 'low') priorityLabel = 'Baixa';
        else if (prioKey === 'high') priorityLabel = 'Alta';
        else if (prioKey === 'critical') priorityLabel = 'Crítica';

        let statusLabel = 'Aberto';
        const stKey = (t.status || 'open').toLowerCase();
        if (t.status === 'inAttendance') statusLabel = 'Em Atendimento';
        else if (t.status === 'awaitingFeedback') statusLabel = 'Aguardando Feedback';
        else if (t.status === 'reopen') statusLabel = 'Reaberto';
        else if (t.status === 'finished') statusLabel = 'Concluído';

        const isInternalText = t.isInternal ? 'Interno' : 'Franqueado';
        const franchiseeName = escapeHtml(t.franchisee?.name || 'Chamado Interno');
        const requesterName = escapeHtml(t.requester?.name || 'Desconhecido');
        const categoryName = escapeHtml(t.category?.name || 'Sem Categoria');
        const attendantName = escapeHtml(t.attendantName || 'Não Atribuído');
        const subjectText = escapeHtml(t.subject || '');
        const codeText = escapeHtml(t.code || '');
        const ticketIdAttr = escapeHtml(t._id || '');

        // Build Questions Form HTML
        let formHTML = '';
        if (t.form && t.form.questions && Array.isArray(t.form.questions)) {
            t.form.questions.forEach(q => {
                if (q.title && q.answer) {
                    formHTML += `
                        <div class="question-block">
                            <div class="question-title">${escapeHtml(htmlToPlainText(q.title))}</div>
                            <div class="question-answer">${formatTextBlock(q.answer)}</div>
                        </div>
                    `;
                }
            });
        }

        // Build Answers interactions thread history HTML
        let answersHTML = '';
        if (t.answers && Array.isArray(t.answers) && t.answers.length > 0) {
            answersHTML += `<div class="interactions-thread"><h4>Histórico de Respostas:</h4>`;
            t.answers.forEach(ans => {
                const dateAns = new Date(ans.answeredAt).toLocaleString('pt-BR');
                const senderName = escapeHtml(ans.username || 'Suporte');
                const roleClass = ans.isUserResponse ? 'franchisee' : 'franchisor';
                const roleLabel = ans.isUserResponse ? 'Solicitante' : 'Suporte';

                answersHTML += `
                    <div class="interaction-item ${roleClass}">
                        <div class="interaction-meta">
                            <strong>${senderName}</strong> (${roleLabel}) · <span>${dateAns}</span>
                        </div>
                        <div class="interaction-body">
                            ${formatTextBlock(ans.answer)}
                        </div>
                    </div>
                `;
            });
            answersHTML += `</div>`;
        }

        const card = document.createElement('div');
        card.className = 'ticket-card';
        card.id = `ticket-card-${ticketIdAttr}`;

        card.innerHTML = `
            <!-- Clickable Header Accordion Trigger -->
            <div class="ticket-card-header" onclick="toggleTicketAccordion('${ticketIdAttr}')">
                <div class="ticket-meta-info">
                    <span class="ticket-code"><i class="fa-solid fa-ticket"></i> #${codeText}</span>
                    <span class="ticket-subject" title="${subjectText}">${subjectText}</span>
                </div>

                <div class="header-actions-right">
                    <!-- Stuck inactivity days indicator -->
                    ${t.status !== 'finished' ? `
                        <div class="waiting-badge ${waiting.badgeClass} ${elapsed.statusClass}">
                            ${waiting.label} - ${elapsed.text}
                        </div>
                    ` : ''}

                    <span class="prio-badge ${prioKey}">${priorityLabel}</span>

                    <div class="status-badge ${stKey}">
                        <span class="status-dot">●</span> ${statusLabel}
                    </div>

                    <i class="fa-solid fa-chevron-down chevron-icon"></i>
                </div>
            </div>

            <!-- Collapsible Body Details -->
            <div class="ticket-card-body">
                <div class="details-grid">
                    <div class="detail-item">
                        <span class="detail-label">Solicitante</span>
                        <span class="detail-value" title="${requesterName}">${requesterName}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Franquia / Origem</span>
                        <span class="detail-value" title="${franchiseeName}">${franchiseeName} (${isInternalText})</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Atendente</span>
                        <span class="detail-value" title="${attendantName}">${attendantName}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Categoria</span>
                        <span class="detail-value" title="${categoryName}">${categoryName}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label font-weight-bold">Aberto em</span>
                        <span class="detail-value">${new Date(t.createdAt).toLocaleString('pt-BR')}</span>
                    </div>
                    <div class="detail-item">
                        <span class="detail-label">Última atualização</span>
                        <span class="detail-value">${elapsed.dateStr}</span>
                    </div>
                </div>

                <!-- Ticket Description Question Form Content -->
                <div class="ticket-form-content">
                    ${formHTML || '<p class="settings-desc">Sem descrição detalhada.</p>'}
                </div>

                <!-- Ticket Replies Interactions Thread -->
                ${answersHTML}
            </div>
        `;

        ticketsList.appendChild(card);
    });
}

// Toggle expansion of ticket card
window.toggleTicketAccordion = function(ticketId) {
    const card = document.getElementById(`ticket-card-${ticketId}`);
    if (card) {
        card.classList.toggle('expanded');
    }
};

function notificationMatchesPrefs(n) {
    let allowType = false;
    if (n.tipo === 'novo_chamado' && notificationPrefs.ruleNew) allowType = true;
    if (n.tipo === 'alteracao_status' && notificationPrefs.ruleStatus) allowType = true;
    if (n.tipo === 'nova_resposta' && notificationPrefs.ruleReply) allowType = true;
    if (n.tipo === 'alteracao_categoria' && notificationPrefs.ruleCategory) allowType = true;
    if (n.tipo === 'alteracao_atendente' && notificationPrefs.ruleAttendant) allowType = true;
    if (!allowType) return false;

    const attendantFilters = notificationPrefs.attendantFilters || [];
    const categoryFilters = notificationPrefs.categoryFilters || [];
    const attendantName = n.atendente_atual || n.attendantName || '';
    const categoryName = n.categoria_atual || n.categoryName || '';
    const matchesAttendant = attendantFilters.length === 0 || attendantFilters.includes(attendantName);
    const matchesCategory = categoryFilters.length === 0 || categoryFilters.includes(categoryName);

    return matchesAttendant && matchesCategory;
}

function notificationMatchesCurrentFilters(notification) {
    if (!filteredTickets || filteredTickets.length === allTickets.length) return true;
    const visibleTicketIds = new Set(filteredTickets.map(t => t._id).filter(Boolean));
    return visibleTicketIds.has(notification.ticket_id);
}

// Render recent status/updates feed
function renderNotifications() {
    const visibleNotifications = allNotifications.filter(notificationMatchesCurrentFilters);
    notificationsCountEl.textContent = visibleNotifications.length;

    if (visibleNotifications.length === 0) {
        notificationsList.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-bell-slash"></i>
                <p>Nenhuma alteração detectada para os filtros atuais.</p>
            </div>
        `;
    } else {
        notificationsList.innerHTML = '';

        visibleNotifications.forEach(n => {
            const item = document.createElement('div');
            item.className = 'notification-item';

            let iconClass = 'fa-solid fa-circle-question';
            if (n.tipo === 'novo_chamado') iconClass = 'fa-solid fa-plus';
            else if (n.tipo === 'alteracao_status') iconClass = 'fa-solid fa-rotate';
            else if (n.tipo === 'nova_resposta') iconClass = 'fa-solid fa-reply';
            else if (n.tipo === 'alteracao_categoria') iconClass = 'fa-solid fa-folder-tree';
            else if (n.tipo === 'alteracao_atendente') iconClass = 'fa-solid fa-user-gear';

            const timestampDate = new Date(n.timestamp);
            const timeStr = timestampDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) +
                            ' - ' + timestampDate.toLocaleDateString('pt-BR');

            item.innerHTML = `
                <div class="notif-icon ${n.tipo}">
                    <i class="${iconClass}"></i>
                </div>
                <div class="notif-content">
                    <div class="notif-message">${escapeHtml(n.mensagem)}</div>
                    <div class="notif-time">${timeStr}</div>
                </div>
            `;

            notificationsList.appendChild(item);
        });
    }

    const pendingToasts = [];
    const pendingNativeAlerts = [];

    allNotifications.forEach(n => {
        // Toast and native OS alerts for unseen notifications
        if (!loadedNotificationIds.has(n.id)) {
            loadedNotificationIds.add(n.id);

            if (!isFirstLoad && notificationMatchesPrefs(n)) {
                pendingToasts.push(n.mensagem);

                // Native windows notification check
                if (notificationPrefs.enableNative && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                    if (notificationMatchesPrefs(n)) {
                        pendingNativeAlerts.push(n);
                    }
                }
            }
        }
    });

    // Display pop-up toasts
    if (pendingToasts.length > 0) {
        playNotificationSound();
        if (pendingToasts.length > 3) {
            showToast(`Alerta: ${pendingToasts.length} novas atualizações de chamados!`);
        } else {
            pendingToasts.forEach(msg => showToast(`Alerta: ${msg}`));
        }
    }

    // Fire Native Windows Notifications
    if (pendingNativeAlerts.length > 0) {
        pendingNativeAlerts.forEach(n => {
            try {
                let title = 'Atualização de Chamado';
                if (n.tipo === 'novo_chamado') title = 'Novo Chamado Criado';
                else if (n.tipo === 'alteracao_status') title = 'Status do Chamado Alterado';
                else if (n.tipo === 'nova_resposta') title = 'Nova Resposta Recebida';
                else if (n.tipo === 'alteracao_categoria') title = 'Categoria do Chamado Alterada';
                else if (n.tipo === 'alteracao_atendente') title = 'Atendente do Chamado Alterado';

                new Notification(title, {
                    body: n.mensagem,
                    icon: '/favicon.ico'
                });
            } catch (err) {
                console.error('Falha ao disparar notificação nativa:', err);
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

        [880, 1175].forEach((freq, index) => {
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

// Display toast message on bottom-right of screen
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

// Modal open/close actions
function openSettingsModal() {
    chkEnableNative.checked = notificationPrefs.enableNative;
    chkEnableSound.checked = notificationPrefs.enableSound;
    chkRuleNew.checked = notificationPrefs.ruleNew;
    chkRuleStatus.checked = notificationPrefs.ruleStatus;
    chkRuleReply.checked = notificationPrefs.ruleReply;
    chkRuleCategory.checked = notificationPrefs.ruleCategory;
    chkRuleAttendant.checked = notificationPrefs.ruleAttendant;
    populateNotificationFilterDropdowns(filterOptionsCache.attendants, filterOptionsCache.categories);

    settingsModal.classList.add('open');
}

function closeSettingsModal() {
    settingsModal.classList.remove('open');
}

// Load configurations from localStorage
function loadNotificationPrefs() {
    try {
        const saved = localStorage.getItem('tickets_monitor_notifications');
        if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed) {
                notificationPrefs = Object.assign(notificationPrefs, parsed);
            }
        }
    } catch (e) {
        console.error('Erro ao carregar preferências:', e);
    }
}

// Save preferences to localStorage
function saveNotificationPrefs() {
    notificationPrefs.enableNative = chkEnableNative.checked;
    notificationPrefs.enableSound = chkEnableSound.checked;
    notificationPrefs.ruleNew = chkRuleNew.checked;
    notificationPrefs.ruleStatus = chkRuleStatus.checked;
    notificationPrefs.ruleReply = chkRuleReply.checked;
    notificationPrefs.ruleCategory = chkRuleCategory.checked;
    notificationPrefs.ruleAttendant = chkRuleAttendant.checked;

    try {
        localStorage.setItem('tickets_monitor_notifications', JSON.stringify(notificationPrefs));
        showToast('OK: Configurações de notificação salvas!');
        closeSettingsModal();

        // Re-render to apply notifications preferences
        renderNotifications();
    } catch (e) {
        console.error(e);
        showToast('Erro: Falha ao salvar preferências.');
    }
}
