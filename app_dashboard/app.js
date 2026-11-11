// Dashboard State
let franchises = [];
let dashboardData = {};
let evolucaoChart = null;
let horariosChart = null;

// DOM Elements
const dataInicioInput = document.getElementById('dataInicio');
const dataFimInput = document.getElementById('dataFim');
const storeChipsContainer = document.getElementById('storeChipsContainer');
const btnSelectAll = document.getElementById('btnSelectAll');
const btnDeselectAll = document.getElementById('btnDeselectAll');
const loadingOverlay = document.getElementById('loadingOverlay');
const dashboardContent = document.getElementById('dashboardContent');
const themeToggle = document.getElementById('themeToggle');

const kpiFaturamento = document.getElementById('kpiFaturamento');
const kpiVendasCount = document.getElementById('kpiVendasCount');
const kpiTicketMedio = document.getElementById('kpiTicketMedio');
const kpiLojasCount = document.getElementById('kpiLojasCount');
const kpiCapitalTravado = document.getElementById('kpiCapitalTravado');
const kpiConcentracao = document.getElementById('kpiConcentracao');
const kpiStatusApi = document.getElementById('kpiStatusApi');
const qualityScore = document.getElementById('qualityScore');
const lastSyncTime = document.getElementById('lastSyncTime');

const rankingFilialSelect = document.getElementById('rankingFilialSelect');
const tbodyRankingFilial = document.getElementById('tbodyRankingFilial');
const tbodyRankingGlobal = document.getElementById('tbodyRankingGlobal');
const tbodyRankingSemGiro = document.getElementById('tbodyRankingSemGiro');

// 1. Initialize Dates (Default 30 days)
const initDates = () => {
    const today = new Date();
    const past = new Date();
    past.setDate(today.getDate() - 30);
    
    const formatDateISO = (d) => d.toISOString().split('T')[0];
    
    dataInicioInput.value = formatDateISO(past);
    dataFimInput.value = formatDateISO(today);
};

// 2. Fetch Franchises List
const loadFranchises = async () => {
    try {
        const res = await fetch('/api/franchises');
        franchises = await res.json();
        renderStoreChips();
        populateFilialRankingDropdown(franchises.map(f => f.cnpj));
        // Load initial dashboard data after getting franchises
        loadDashboardData();
    } catch (err) {
        console.error("Erro ao carregar franquias:", err);
    }
};

// 3. Render Store Chips/Checkboxes
const renderStoreChips = () => {
    storeChipsContainer.innerHTML = '';
    franchises.forEach(f => {
        const label = document.createElement('label');
        label.className = 'store-chip active'; // Default to active
        label.innerHTML = `
            <input type="checkbox" value="${f.cnpj}" class="store-checkbox" checked>
            <span>${f.name}</span>
        `;
        
        const checkbox = label.querySelector('.store-checkbox');
        checkbox.addEventListener('change', (e) => {
            if (e.target.checked) {
                label.classList.add('active');
            } else {
                label.classList.remove('active');
            }
            loadDashboardData();
        });
        
        storeChipsContainer.appendChild(label);
    });
};

// 4. Fill Filial Dropdown for Local Ranking
const populateFilialRankingDropdown = (selectedCnpjs = []) => {
    const currentVal = rankingFilialSelect.value;
    rankingFilialSelect.innerHTML = '';
    
    const activeFranchises = franchises.filter(f => selectedCnpjs.includes(f.cnpj));
    
    if (activeFranchises.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Nenhuma filial selecionada';
        opt.disabled = true;
        rankingFilialSelect.appendChild(opt);
        return;
    }
    
    activeFranchises.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.cnpj;
        opt.textContent = f.name;
        rankingFilialSelect.appendChild(opt);
    });
    
    // Restore previous selection if still active, otherwise default to first
    if (selectedCnpjs.includes(currentVal)) {
        rankingFilialSelect.value = currentVal;
    } else {
        rankingFilialSelect.value = activeFranchises[0].cnpj;
    }
};

// 5. Load Dashboard Data from API Proxy
const loadDashboardData = async () => {
    const dataInicio = dataInicioInput.value;
    const dataFim = dataFimInput.value;
    
    // Get checked CNPJs
    const checkedCheckboxes = document.querySelectorAll('.store-checkbox:checked');
    const selectedCnpjs = Array.from(checkedCheckboxes).map(cb => cb.value);
    
    populateFilialRankingDropdown(selectedCnpjs);
    
    if (selectedCnpjs.length === 0) {
        // Clear Dashboard
        clearDashboard();
        return;
    }
    
    // Show loading overlay
    loadingOverlay.classList.remove('hidden');
    dashboardContent.classList.add('loading');
    
    const params = new URLSearchParams({
        dataInicio,
        dataFim,
        cnpjs: selectedCnpjs.join(',')
    });
    
    try {
        const res = await fetch(`/api/dashboard?${params.toString()}`);
        dashboardData = await res.json();
        
        renderKpis(selectedCnpjs.length);
        renderCharts();
        renderGlobalRankingTable();
        renderLocalRankingTable();
        renderSlowMovingTable();
        
    } catch (err) {
        console.error("Erro ao carregar dados do dashboard:", err);
    } finally {
        loadingOverlay.classList.add('hidden');
        dashboardContent.classList.remove('loading');
    }
};

// Clear all cards
const clearDashboard = () => {
    kpiFaturamento.textContent = "R$ 0,00";
    kpiVendasCount.textContent = "0 vendas concluídas";
    kpiTicketMedio.textContent = "R$ 0,00";
    kpiLojasCount.textContent = "0";
    kpiCapitalTravado.textContent = "R$ 0,00";
    kpiConcentracao.textContent = "Aguardando...";
    kpiStatusApi.textContent = "OFFLINE";
    kpiStatusApi.style.color = "var(--brand-danger)";
    
    tbodyRankingFilial.innerHTML = '<tr><td colspan="3" class="table-empty">Selecione lojas para ver os dados.</td></tr>';
    tbodyRankingGlobal.innerHTML = '<tr><td colspan="3" class="table-empty">Selecione lojas para ver os dados.</td></tr>';
    tbodyRankingSemGiro.innerHTML = '<tr><td colspan="3" class="table-empty">Selecione lojas para ver os dados.</td></tr>';
    
    if (evolucaoChart) evolucaoChart.destroy();
    if (horariosChart) horariosChart.destroy();
};

// Render KPIs
const renderKpis = (storeCount) => {
    kpiFaturamento.textContent = parseFloat(dashboardData.faturamento || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    kpiVendasCount.textContent = `${dashboardData.salesCount || 0} vendas concluídas`;
    kpiTicketMedio.textContent = parseFloat(dashboardData.ticketMedio || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    kpiLojasCount.textContent = storeCount;
    kpiCapitalTravado.textContent = parseFloat(dashboardData.capitalTravado || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    
    if (dashboardData.concentracaoPercentual > 0) {
        kpiConcentracao.textContent = `${dashboardData.concentracaoNome} (${parseFloat(dashboardData.concentracaoPercentual).toFixed(1)}%)`;
    } else {
        kpiConcentracao.textContent = "Sem faturamento";
    }
    
    kpiStatusApi.textContent = "ONLINE";
    kpiStatusApi.style.color = "var(--brand-success)";
    
    if (qualityScore) qualityScore.textContent = `${dashboardData.dataQualityScore || 100}%`;
    if (lastSyncTime) lastSyncTime.textContent = dashboardData.lastSync || "Sincronizado";
};

// Render Chart.js
const renderCharts = () => {
    const isDark = document.body.classList.contains('dark-theme');
    const gridColor = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.06)';
    const textColor = isDark ? '#f7e8dc' : '#4b5563';
    
    // 1. Evolução Chart (Line)
    const diaLabels = (dashboardData.vendasDia || []).map(d => d.label);
    const diaValues = (dashboardData.vendasDia || []).map(d => d.value);
    
    if (evolucaoChart) evolucaoChart.destroy();
    
    const ctxEvolucao = document.getElementById('chartEvolucao').getContext('2d');
    evolucaoChart = new Chart(ctxEvolucao, {
        type: 'line',
        data: {
            labels: diaLabels,
            datasets: [{
                label: 'Faturamento',
                data: diaValues,
                borderColor: '#168b78',
                backgroundColor: 'rgba(22, 139, 120, 0.08)',
                borderWidth: 2,
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { color: gridColor }, ticks: { color: textColor } },
                y: { grid: { color: gridColor }, ticks: { color: textColor } }
            }
        }
    });
    
    // 2. Horarios Chart (Bar)
    const horaLabels = (dashboardData.vendasHora || []).map(h => h.label);
    const horaValues = (dashboardData.vendasHora || []).map(h => h.value);
    
    if (horariosChart) horariosChart.destroy();
    
    const ctxHorarios = document.getElementById('chartHorarios').getContext('2d');
    horariosChart = new Chart(ctxHorarios, {
        type: 'bar',
        data: {
            labels: horaLabels,
            datasets: [{
                label: 'Faturamento por Hora',
                data: horaValues,
                backgroundColor: '#f2ae30',
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { color: gridColor }, ticks: { color: textColor } },
                y: { grid: { color: gridColor }, ticks: { color: textColor } }
            }
        }
    });
};

// Render Global Ranking Table
const renderGlobalRankingTable = () => {
    tbodyRankingGlobal.innerHTML = '';
    const list = dashboardData.rankingGlobal || [];
    
    if (list.length === 0) {
        tbodyRankingGlobal.innerHTML = '<tr><td colspan="3" class="table-empty">Sem vendas no período.</td></tr>';
        return;
    }
    
    list.forEach(item => {
        const price = item.qty > 0 ? (item.total / item.qty) : 0;
        const priceFormatted = price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <div style="font-weight: 600;">${item.ref}</div>
                <div style="font-size: 0.8rem; color: var(--text-muted);">${item.desc}</div>
                <div style="font-size: 0.75rem; color: var(--brand-primary); font-weight: 500; margin-top: 2px;">Preço unitário médio: ${priceFormatted}</div>
            </td>
            <td>${item.qty}</td>
            <td>${parseFloat(item.total).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
        `;
        tbodyRankingGlobal.appendChild(tr);
    });
};

// Render Local Ranking Table
const renderLocalRankingTable = () => {
    tbodyRankingFilial.innerHTML = '';
    const cnpj = rankingFilialSelect.value;
    const list = (dashboardData.rankingLocal && dashboardData.rankingLocal[cnpj]) || [];
    
    if (list.length === 0) {
        tbodyRankingFilial.innerHTML = '<tr><td colspan="3" class="table-empty">Sem vendas registradas nesta loja.</td></tr>';
        return;
    }
    
    list.forEach(item => {
        const price = item.qty > 0 ? (item.total / item.qty) : 0;
        const priceFormatted = price.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <div style="font-weight: 600;">${item.ref}</div>
                <div style="font-size: 0.8rem; color: var(--text-muted);">${item.desc}</div>
                <div style="font-size: 0.75rem; color: var(--brand-primary); font-weight: 500; margin-top: 2px;">Preço unitário médio: ${priceFormatted}</div>
            </td>
            <td>${item.qty}</td>
            <td>${parseFloat(item.total).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
        `;
        tbodyRankingFilial.appendChild(tr);
    });
};

// Render Slow-Moving Inventory Table
const renderSlowMovingTable = () => {
    tbodyRankingSemGiro.innerHTML = '';
    const list = dashboardData.rankingSemGiro || [];
    
    if (list.length === 0) {
        tbodyRankingSemGiro.innerHTML = '<tr><td colspan="3" class="table-empty">Sem dados catalogados.</td></tr>';
        return;
    }
    
    list.forEach(item => {
        const tr = document.createElement('tr');
        
        let badgeClass = 'badge-success';
        if (item.score > 80) {
            badgeClass = 'badge-danger';
        } else if (item.score > 30) {
            badgeClass = 'badge-warning';
        }
        const badgeText = `Score: ${item.score}`;
        
        const priceFormatted = parseFloat(item.preco || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        const tooltipText = item.estoque_detalhe && item.estoque_detalhe.length > 0 
            ? "Estoque por Unidade:\n" + item.estoque_detalhe.map(d => ` • ${d.store}: ${d.qty} un.`).join("\n")
            : "Sem estoque ativo nas unidades selecionadas";
            
        tr.innerHTML = `

            <td>
                <div style="font-weight: 600;">${item.ref}</div>
                <div style="font-size: 0.8rem; color: var(--text-muted);">${item.desc}</div>
                <div style="font-size: 0.75rem; color: var(--brand-primary); font-weight: 500; margin-top: 2px;">Preço: ${priceFormatted}</div>
                <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">Estoque: <strong title="${tooltipText}" style="cursor: help; border-bottom: 1.5px dotted var(--brand-primary); padding-bottom: 1px;">${item.estoque} un.</strong> | Sem vendas há <strong>${item.dias_sem_venda} dias</strong></div>
            </td>
            <td>${item.qty} vendas</td>
            <td><span class="badge ${badgeClass}" title="Score de Encalhe">${badgeText}</span></td>
        `;

        tbodyRankingSemGiro.appendChild(tr);
    });

};

// 6. Set Up Theme Toggle
themeToggle.addEventListener('click', () => {
    document.body.classList.toggle('dark-theme');
    const isDark = document.body.classList.contains('dark-theme');
    themeToggle.querySelector('i').className = isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    // Re-render charts with new theme colors
    renderCharts();
});

// 7. Store Filters Checkbox Quick Actions
btnSelectAll.addEventListener('click', () => {
    const checkboxes = document.querySelectorAll('.store-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = true;
        cb.closest('.store-chip').classList.add('active');
    });
    loadDashboardData();
});

btnDeselectAll.addEventListener('click', () => {
    const checkboxes = document.querySelectorAll('.store-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = false;
        cb.closest('.store-chip').classList.remove('active');
    });
    clearDashboard();
});

// 8. Set Up Date Listeners
dataInicioInput.addEventListener('change', () => loadDashboardData());
dataFimInput.addEventListener('change', () => loadDashboardData());

// 9. Startup App
initDates();
loadFranchises();

// Setup select change listener
rankingFilialSelect.addEventListener('change', () => {
    renderLocalRankingTable();
});
