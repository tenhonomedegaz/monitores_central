document.addEventListener("DOMContentLoaded", function() {
    // Inject chat HTML widget structure into the body dynamically
    const chatContainer = document.createElement("div");
    chatContainer.id = "santoline-chat-widget";
    chatContainer.innerHTML = `
        <!-- Floating Chat Button -->
        <button id="chat-toggle-btn" class="chat-trigger-btn" title="Conversar com Santoline AI">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            <span class="pulse-indicator"></span>
        </button>

        <!-- Chat Panel -->
        <div id="chat-panel" class="chat-panel-container hidden">
            <div class="chat-header">
                <div class="chat-header-info">
                    <div class="avatar-container">
                        <span class="ai-avatar-icon">✦</span>
                    </div>
                    <div>
                        <h3>Santoline AI</h3>
                        <p class="status-online"><span class="status-dot"></span>Assistente Analítico Ativo</p>
                    </div>
                </div>
                <button id="chat-close-btn" class="chat-close-btn" title="Fechar Chat">×</button>
            </div>
            
            <div id="chat-messages" class="chat-messages-body">
                <!-- Welcome message -->
                <div class="message assistant">
                    <div class="message-content">
                        Olá! Sou o <strong>Santoline AI</strong>, seu assistente de inteligência artificial integrado. 
                        Posso ajudar você a analisar o faturamento das lojas, identificar produtos com baixo giro, encontrar duplas de produtos vendidos juntos e sugerir estratégias de venda em tempo real.
                        <br><br>
                        Como posso te ajudar hoje?
                    </div>
                </div>
            </div>


            <!-- Typing indicator (hidden by default) -->
            <div id="chat-typing-indicator" class="chat-typing-bubble hidden">
                <div class="typing-dots">
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
                <p>Santoline AI está analisando os dados...</p>
            </div>

            <!-- Input area -->
            <form id="chat-form" class="chat-input-area">
                <input type="text" id="chat-input" placeholder="Pergunte sobre vendas, duplas, giro..." autocomplete="off" required>
                <button type="submit" id="chat-send-btn" title="Enviar Mensagem">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="22" y1="2" x2="11" y2="13"></line>
                        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                    </svg>
                </button>
            </form>
        </div>
    `;
    document.body.appendChild(chatContainer);

    // DOM Elements Reference
    const toggleBtn = document.getElementById("chat-toggle-btn");
    const closeBtn = document.getElementById("chat-close-btn");
    const chatPanel = document.getElementById("chat-panel");
    const chatMessages = document.getElementById("chat-messages");
    const chatForm = document.getElementById("chat-form");
    const chatInput = document.getElementById("chat-input");
    const typingIndicator = document.getElementById("chat-typing-indicator");

    // Chat History State
    let chatHistory = [
        { role: "assistant", content: "Olá! Sou o Santoline AI, seu assistente de inteligência artificial integrado. Posso ajudar você a analisar o faturamento das lojas, identificar produtos com baixo giro, encontrar duplas de produtos vendidos juntos e sugerir estratégias de venda em tempo real." }
    ];

    // Toggle Chat visibility
    toggleBtn.addEventListener("click", () => {
        chatPanel.classList.toggle("hidden");
        chatPanel.classList.toggle("fade-in-up");
        chatInput.focus();
        scrollChatToBottom();
    });

    closeBtn.addEventListener("click", () => {
        chatPanel.classList.add("hidden");
        chatPanel.classList.remove("fade-in-up");
    });

    // Handle Form Submission
    chatForm.addEventListener("submit", function(e) {
        e.preventDefault();
        const queryText = chatInput.value.trim();
        if (!queryText) return;
        chatInput.value = "";
        sendChatMessage(queryText);
    });

    // Core Send Logic
    function sendChatMessage(text) {
        // Append user message to UI
        appendMessage("user", text);
        chatHistory.push({ role: "user", content: text });

        // Show typing indicator
        typingIndicator.classList.remove("hidden");
        scrollChatToBottom();

        // Send payload to backend
        fetch("/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ messages: chatHistory })
        })
        .then(response => response.json())
        .then(data => {
            // Hide typing indicator
            typingIndicator.classList.add("hidden");

            if (data.error) {
                appendMessage("assistant", "⚠️ Erro: " + data.error);
            } else if (data.response) {
                appendMessage("assistant", data.response);
                chatHistory.push({ role: "assistant", content: data.response });
            } else {
                appendMessage("assistant", "Desculpe, ocorreu um erro inesperado na resposta.");
            }
            scrollChatToBottom();
        })
        .catch(err => {
            typingIndicator.classList.add("hidden");
            appendMessage("assistant", "❌ Falha na conexão com o servidor de IA. Por favor, verifique se a chave de API está configurada.");
            scrollChatToBottom();
            console.error("Chat error:", err);
        });
    }

    // Append messages to DOM
    function appendMessage(role, text) {
        const msgDiv = document.createElement("div");
        msgDiv.className = `message ${role}`;
        
        const contentDiv = document.createElement("div");
        contentDiv.className = "message-content";
        contentDiv.innerHTML = formatMessage(text);
        
        msgDiv.appendChild(contentDiv);
        chatMessages.appendChild(msgDiv);
        scrollChatToBottom();
    }


    // Scroll to bottom
    function scrollChatToBottom() {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // Format Markdown bold, lists, and tables into HTML
    function formatMessage(text) {
        // Safe characters escaping
        let escaped = text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
            
        // Bold formatting **text**
        escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        
        // Split in lines to format lists and tables
        let lines = escaped.split('\n');
        let inList = false;
        let inTable = false;
        let tableHeaderRead = false;
        
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            
            // List formatting
            if (line.startsWith('- ') || line.startsWith('* ')) {
                if (inTable) {
                    lines[i-1] = lines[i-1] + '</table>';
                    inTable = false;
                }
                let cleanLine = line.substring(2);
                if (!inList) {
                    lines[i] = '<ul><li>' + cleanLine + '</li>';
                    inList = true;
                } else {
                    lines[i] = '<li>' + cleanLine + '</li>';
                }
            } 
            // Table formatting
            else if (line.startsWith('|') && line.endsWith('|')) {
                if (inList) {
                    lines[i-1] = lines[i-1] + '</ul>';
                    inList = false;
                }
                
                // Parse table cells
                let cells = line.split('|').map(c => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length - 1);
                
                // Check if divider line
                if (cells.every(c => /^:-*|-*:-*|-*:$/.test(c) || c === '')) {
                    lines[i] = ''; // skip divider row
                    continue;
                }
                
                let rowHtml = '<tr>' + cells.map(c => {
                    return tableHeaderRead ? `<td>${c}</td>` : `<th>${c}</th>`;
                }).join('') + '</tr>';
                
                if (!inTable) {
                    lines[i] = '<table class="chat-data-table">' + rowHtml;
                    inTable = true;
                    tableHeaderRead = true; // First row is header
                } else {
                    lines[i] = rowHtml;
                }
            }
            // Normal paragraph line
            else {
                if (inList) {
                    lines[i-1] = lines[i-1] + '</ul>';
                    inList = false;
                }
                if (inTable) {
                    lines[i-1] = lines[i-1] + '</table>';
                    inTable = false;
                    tableHeaderRead = false;
                }
            }
        }
        
        // Close dangling tags
        if (inList) {
            lines[lines.length-1] = lines[lines.length-1] + '</ul>';
        }
        if (inTable) {
            lines[lines.length-1] = lines[lines.length-1] + '</table>';
        }
        
        return lines.filter(l => l !== '').join('\n').replace(/\n/g, '<br>');
    }
});
