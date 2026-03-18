// chatbot.js
document.addEventListener("DOMContentLoaded", () => {
    // Inject Chatbot HTML
    const widgetHTML = `
      <div id="grace-chatbot-widget">
        <div id="chat-window">
          <div class="chat-header">
            <div class="chat-title-group">
              <div class="chat-title">GRACE-X AI</div>
              <div class="chat-subtitle">Sales & Deployment Expert</div>
            </div>
            <button class="chat-close-btn" id="chat-close-btn">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                <path d="M14 1.41L12.59 0L7 5.59L1.41 0L0 1.41L5.59 7L0 12.59L1.41 14L7 8.41L12.59 14L14 12.59L8.41 7L14 1.41Z"/>
              </svg>
            </button>
          </div>
          <div class="chat-messages" id="chat-messages">
            <div class="msg ai">
              Welcome. I am GRACE-X, a modular AI operating system. How can I assist you with enterprise and defence-grade deployments today?
            </div>
          </div>
          <div class="chat-prompts-dropdown">
            <button id="chat-prompts-toggle">
              Suggested Queries ▾
            </button>
            <div class="chat-prompts-menu" id="chat-prompts-menu">
              <div class="prompt-item">what is the grace x ecosystem and what are her capabilities?</div>
              <div class="prompt-item">what makes GRACE-X different?</div>
              <div class="prompt-item">how secure is she compared to other systems and why?</div>
              <div class="prompt-item">what are the modules and how do they help?</div>
              <div class="prompt-item">what is grace and what is a sovereign ai and how many other systems are like you?</div>
              <div class="prompt-item">what are the commercial and defence applications for TITAN?</div>
              <div class="prompt-item">how do the core orchestration layers work together?</div>
              <div class="prompt-item">who built you?</div>
            </div>
          </div>
          <div class="chat-input-area">
            <input type="text" id="chat-input" placeholder="Initiate inquiry..." autocomplete="off"/>
            <button id="chat-send-btn">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12L2.01 3L2 10L17 12L2 14L2.01 21Z"/>
              </svg>
            </button>
          </div>
        </div>
        <button id="chat-toggle-btn">
          <svg viewBox="0 0 24 24">
            <path d="M20 2H4C2.9 2 2 2.9 2 4V22L6 18H20C21.1 18 22 17.1 22 16V4C22 2.9 21.1 2 20 2ZM20 16H5.17L4 17.17V4H20V16Z"/>
          </svg>
        </button>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', widgetHTML);

    const toggleBtn = document.getElementById("chat-toggle-btn");
    const hudHelpBtn = document.getElementById("hudHelpBtn");
    const closeBtn = document.getElementById("chat-close-btn");
    const chatWindow = document.getElementById("chat-window");
    const chatInput = document.getElementById("chat-input");
    const sendBtn = document.getElementById("chat-send-btn");
    const messagesContainer = document.getElementById("chat-messages");

    const togglePromptsBtn = document.getElementById("chat-prompts-toggle");
    const promptsMenu = document.getElementById("chat-prompts-menu");
    const promptItems = document.querySelectorAll(".prompt-item");

    togglePromptsBtn.addEventListener("click", () => {
        promptsMenu.classList.toggle("active");
    });

    promptItems.forEach(item => {
        item.addEventListener("click", () => {
            chatInput.value = item.textContent;
            promptsMenu.classList.remove("active");
            sendMessage();
        });
    });

    let isChatOpen = false;
    let messageHistory = [];

    function toggleChat() {
        isChatOpen = !isChatOpen;
        if (isChatOpen) {
            chatWindow.classList.add("active");
            chatInput.focus();
        } else {
            chatWindow.classList.remove("active");
        }
    }

    toggleBtn.addEventListener("click", toggleChat);
    closeBtn.addEventListener("click", toggleChat);
    
    if (hudHelpBtn) {
        hudHelpBtn.addEventListener("click", () => {
            if (!isChatOpen) toggleChat();
        });
    }

    function addMessage(text, sender) {
        const msgDiv = document.createElement("div");
        msgDiv.className = `msg ${sender}`;
        msgDiv.textContent = text;
        messagesContainer.appendChild(msgDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    function showTyping() {
        const typingDiv = document.createElement("div");
        typingDiv.className = "typing-indicator";
        typingDiv.id = "typing-indicator";
        typingDiv.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
        messagesContainer.appendChild(typingDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    function removeTyping() {
        const typingDiv = document.getElementById("typing-indicator");
        if (typingDiv) {
            typingDiv.remove();
        }
    }

    async function sendMessage() {
        const text = chatInput.value.trim();
        if (!text) return;

        addMessage(text, "user");
        messageHistory.push({ role: "user", content: text });
        chatInput.value = "";
        sendBtn.disabled = true;

        showTyping();

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: messageHistory })
            });

            const data = await response.json();
            removeTyping();

            if (data.reply) {
                addMessage(data.reply.content, "ai");
                messageHistory.push({ role: data.reply.role, content: data.reply.content });
                playGraceVoice(data.reply.content);
            } else {
                addMessage("Terminal Error: Connection interrupted.", "ai");
            }
        } catch (error) {
            console.error("Chat Error:", error);
            removeTyping();
            addMessage("System Alert: Unable to reach core servers.", "ai");
        } finally {
            sendBtn.disabled = false;
            chatInput.focus();
        }
    }

    sendBtn.addEventListener("click", sendMessage);
    chatInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            sendMessage();
        }
    });

    let graceAudio = null;

    async function playGraceVoice(text) {
        if (!text) return;
        try {
            const initResp = await fetch('/api/voice/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });

            if (!initResp.ok) {
                if (initResp.status === 500) {
                    addMessage("System Alert: Voice unavailable. Please set OPENAI_API_KEY in the environment.", "ai");
                }
                return;
            }

            const { id } = await initResp.json();
            const audioUrl = `/api/voice/stream?id=${id}`;
            
            if (graceAudio) {
                graceAudio.pause();
                graceAudio.src = '';
            }
            
            graceAudio = new Audio(audioUrl);
            await graceAudio.play();
        } catch (e) {
            console.error('Voice playback error:', e);
        }
    }
});
