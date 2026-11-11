const urls = {
  dashboard: '',
  pedidos: '',
  chamados: ''
};

let activeTab = 'dashboard';
let serverPort = null;

async function checkServerReady(port, maxRetries = 60, intervalMs = 300) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/pedidos/status`, { cache: 'no-store' });
      if (res.ok) return true;
    } catch (_) {
      // not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function initIframes() {
  if (window.electronAPI && typeof window.electronAPI.getServerPort === 'function') {
    try {
      const port = await window.electronAPI.getServerPort();
      serverPort = port;
      urls.dashboard = `http://127.0.0.1:${port}/dashboard/`;
      urls.pedidos = `http://127.0.0.1:${port}`;
      urls.chamados = `http://127.0.0.1:${port}/chamados/`;
      
      const iframeDashboard = document.getElementById('iframe-dashboard');
      const iframePedidos = document.getElementById('iframe-pedidos');
      const iframeChamados = document.getElementById('iframe-chamados');
      
      // Wait for local HTTP server to respond before binding iframe sources
      await checkServerReady(port);

      if (iframeDashboard) iframeDashboard.src = urls.dashboard;
      if (iframePedidos) iframePedidos.src = urls.pedidos;
      if (iframeChamados) iframeChamados.src = urls.chamados;
    } catch (err) {
      console.error('Failed to get server port:', err);
    }
  }
}

// Call on startup
initIframes();

function setActiveTab(tabName) {
  activeTab = tabName;
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.target === tabName);
  });
  document.querySelectorAll('.frame-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `panel-${tabName}`);
  });
  
  // Show or hide the open browser button
  const openBrowserBtn = document.getElementById('open-browser');
  if (tabName === 'ferramentas') {
    openBrowserBtn.style.display = 'none';
  } else {
    openBrowserBtn.style.display = 'block';
  }
}

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => setActiveTab(button.dataset.target));
});

document.getElementById('open-browser').addEventListener('click', () => {
  if (urls[activeTab]) {
    window.open(urls[activeTab], '_blank', 'noopener,noreferrer');
  }
});

// ==============================================================================
// GLOBAL AI ASSISTANT CHAT DRAWER LOGIC
// ==============================================================================
let aiChatMessages = [];
let currentDashboardContext = null;

window.addEventListener('message', (event) => {
  if (event.data?.type === 'monitores-dashboard-context' && event.data.context) {
    currentDashboardContext = event.data.context;
  }
});

const aiChatTrigger = document.getElementById('ai-chat-trigger');
const aiChatDrawer = document.getElementById('ai-chat-drawer');
const aiDrawerClose = document.getElementById('ai-drawer-close');
const aiMessagesContainer = document.getElementById('ai-chat-messages');
const aiChatInput = document.getElementById('ai-chat-input');
const aiChatSend = document.getElementById('ai-chat-send');

function toggleAiDrawer(show) {
  if (!aiChatDrawer) return;
  const isVisible = show !== undefined ? show : !aiChatDrawer.classList.contains('open');
  aiChatDrawer.classList.toggle('open', isVisible);
  if (isVisible && aiChatInput) {
    aiChatInput.focus();
  }
}

if (aiChatTrigger) {
  aiChatTrigger.addEventListener('click', () => toggleAiDrawer());
}
if (aiDrawerClose) {
  aiDrawerClose.addEventListener('click', () => toggleAiDrawer(false));
}

// Quick suggestion chips
document.querySelectorAll('.quick-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const prompt = chip.dataset.prompt;
    if (prompt) {
      sendAiMessage(prompt);
    }
  });
});

function formatMarkdown(text) {
  if (!text) return '';
  let html = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  
  html = html.replace(/^\s*[\-\*]\s+(.*)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/g, '<ul>$1</ul>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

async function sendAiMessage(userText) {
  const text = (userText || (aiChatInput ? aiChatInput.value : '')).trim();
  if (!text) return;
  if (aiChatInput) aiChatInput.value = '';

  const welcomeCard = aiMessagesContainer.querySelector('.ai-welcome-card');
  if (welcomeCard) {
    welcomeCard.style.display = 'none';
  }

  aiChatMessages.push({ role: 'user', content: text });
  appendChatMessage('user', text);

  const typingEl = appendTypingIndicator();
  scrollToBottom();

  try {
    const port = serverPort || (window.electronAPI ? await window.electronAPI.getServerPort() : 8080);
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: aiChatMessages,
        context: { activeTab, dashboard: currentDashboardContext }
      })
    });

    const data = await response.json();
    typingEl.remove();

    if (data.response) {
      aiChatMessages.push({ role: 'assistant', content: data.response });
      appendChatMessage('assistant', data.response);
    } else if (data.error) {
      appendChatMessage('assistant', `⚠️ **Erro**: ${data.error}`);
    } else {
      appendChatMessage('assistant', '⚠️ Não foi possível obter uma resposta do assistente.');
    }
  } catch (err) {
    if (typingEl) typingEl.remove();
    appendChatMessage('assistant', `⚠️ **Erro de Rede**: Falha ao comunicar com o servidor de IA. (${err.message})`);
  }
  scrollToBottom();
}

function appendChatMessage(sender, content) {
  const div = document.createElement('div');
  div.className = `chat-bubble ${sender}`;
  
  const icon = sender === 'user' ? '<i class="fa-solid fa-user"></i>' : '<i class="fa-solid fa-brain"></i>';
  const formattedContent = formatMarkdown(content);
  
  div.innerHTML = `
    <div class="chat-bubble-avatar">${icon}</div>
    <div class="chat-bubble-content">${formattedContent}</div>
  `;
  
  aiMessagesContainer.appendChild(div);
  scrollToBottom();
}

function appendTypingIndicator() {
  const div = document.createElement('div');
  div.className = 'chat-bubble assistant typing';
  div.innerHTML = `
    <div class="chat-bubble-avatar"><i class="fa-solid fa-brain fa-spin"></i></div>
    <div class="chat-bubble-content">
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span style="font-size: 0.8rem; margin-left: 6px; opacity: 0.7;">Analisando dados do sistema...</span>
    </div>
  `;
  aiMessagesContainer.appendChild(div);
  return div;
}

function scrollToBottom() {
  if (aiMessagesContainer) {
    aiMessagesContainer.scrollTop = aiMessagesContainer.scrollHeight;
  }
}

if (aiChatSend) {
  aiChatSend.addEventListener('click', () => sendAiMessage());
}
if (aiChatInput) {
  aiChatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAiMessage();
    }
  });
}

// ==============================================================================
// FERRAMENTAS PANEL LOGIC
// ==============================================================================

let logCleanup = null;
let closeCleanup = null;

const consoleOutput = document.getElementById('console-output');

function appendToConsole(text) {
  if (!consoleOutput) return;
  consoleOutput.textContent += text;
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

function clearConsole() {
  if (consoleOutput) {
    consoleOutput.textContent = '';
  }
}

const btnClearConsole = document.getElementById('btn-clear-console');
if (btnClearConsole) {
  btnClearConsole.addEventListener('click', clearConsole);
}

async function runTool(btnId, toolName, args) {
  const btn = document.getElementById(btnId);
  if (!btn) return;

  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Executando...';
  btn.classList.add('running');

  clearConsole();
  appendToConsole(`>>> Iniciando script ${toolName} com parâmetros: ${args.join(' ')}\n\n`);

  if (!window.electronAPI?.runTool) {
    appendToConsole('\n[ERRO] Integração IPC do Electron não encontrada.\n');
    btn.disabled = false;
    btn.textContent = oldText;
    btn.classList.remove('running');
    return;
  }

  if (typeof logCleanup === 'function') logCleanup();
  if (typeof closeCleanup === 'function') closeCleanup();
  logCleanup = window.electronAPI.onToolOutput((data) => appendToConsole(data));
  closeCleanup = window.electronAPI.onToolClose(() => {});

  try {
    const result = await window.electronAPI.runTool(toolName, args);
    if (!result?.success) {
      appendToConsole(`\n[ERRO] ${result?.error || `Processo encerrado com código ${result?.code ?? 'desconhecido'}.`}\n`);
    }
    appendToConsole(`\n>>> Script finalizado com código de saída: ${result?.code ?? -1}\n`);
  } catch (error) {
    appendToConsole(`\n[ERRO] Falha ao executar script: ${error.message}\n`);
  } finally {
    if (typeof logCleanup === 'function') logCleanup();
    if (typeof closeCleanup === 'function') closeCleanup();
    logCleanup = null;
    closeCleanup = null;
    btn.disabled = false;
    btn.textContent = oldText;
    btn.classList.remove('running');
  }
}

function suggestOutputPath(inputPath, suffix, newExt) {
  if (!inputPath) return '';
  const lastDotIdx = inputPath.lastIndexOf('.');
  if (lastDotIdx === -1) {
    return `${inputPath}${suffix}.${newExt}`;
  }
  const basePath = inputPath.substring(0, lastDotIdx);
  return `${basePath}${suffix}.${newExt}`;
}

// ----------------------------------------------------
// Tool 1: Processar Planilha
// ----------------------------------------------------
const btnSelectProcInput = document.getElementById('btn-select-proc-input');
const procInputPath = document.getElementById('proc-input-path');
const btnRunProcessar = document.getElementById('btn-run-processar');

if (btnSelectProcInput && window.electronAPI) {
  btnSelectProcInput.addEventListener('click', async () => {
    const filePath = await window.electronAPI.selectFile({
      filters: [{ name: 'Excel Files', extensions: ['xlsx'] }]
    });
    if (filePath) {
      procInputPath.value = filePath;
    }
  });
}

if (btnRunProcessar && window.electronAPI) {
  btnRunProcessar.addEventListener('click', async () => {
    const input = procInputPath.value;
    if (!input) {
      alert('Selecione o arquivo de entrada (.xlsx)');
      return;
    }
    
    // Open Save As dialog immediately when clicking Execute
    const defaultPath = suggestOutputPath(input, '_processado', 'csv');
    const savePath = await window.electronAPI.saveFile({
      defaultPath: defaultPath,
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    });
    
    if (savePath) {
      runTool('btn-run-processar', 'processar_planilha.py', [input, savePath]);
    }
  });
}

// ----------------------------------------------------
// Tool 2: Corretor de CSV (Repair Tool)
// ----------------------------------------------------
const btnSelectRepairInput = document.getElementById('btn-select-repair-input');
const repairInputPath = document.getElementById('repair-input-path');
const btnRunRepair = document.getElementById('btn-run-repair');

if (btnSelectRepairInput && window.electronAPI) {
  btnSelectRepairInput.addEventListener('click', async () => {
    const filePath = await window.electronAPI.selectFile({
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    });
    if (filePath) {
      repairInputPath.value = filePath;
    }
  });
}

if (btnRunRepair && window.electronAPI) {
  btnRunRepair.addEventListener('click', async () => {
    const input = repairInputPath.value;
    if (!input) {
      alert('Selecione o arquivo CSV quebrado (.csv)');
      return;
    }
    
    // Open Save As dialog immediately when clicking Execute
    const defaultPath = suggestOutputPath(input, '_consertada', 'xlsx');
    const savePath = await window.electronAPI.saveFile({
      defaultPath: defaultPath,
      filters: [{ name: 'Excel Files', extensions: ['xlsx'] }]
    });
    
    if (savePath) {
      runTool('btn-run-repair', 'csv_repair_tool.py', [input, savePath]);
    }
  });
}

// ----------------------------------------------------
// Tool 3: Divisor de CSV
// ----------------------------------------------------
const btnSelectSplitInput = document.getElementById('btn-select-split-input');
const splitInputPath = document.getElementById('split-input-path');
const splitRows = document.getElementById('split-rows');
const btnRunSplit = document.getElementById('btn-run-split');

if (btnSelectSplitInput && window.electronAPI) {
  btnSelectSplitInput.addEventListener('click', async () => {
    const filePath = await window.electronAPI.selectFile({
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    });
    if (filePath) {
      splitInputPath.value = filePath;
    }
  });
}

if (btnRunSplit) {
  btnRunSplit.addEventListener('click', () => {
    const input = splitInputPath.value;
    const rows = splitRows.value || '100';
    if (!input) {
      alert('Selecione o arquivo CSV de entrada (.csv)');
      return;
    }
    runTool('btn-run-split', 'divisor.py', [input, rows]);
  });
}
