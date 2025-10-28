const CURRENT_USER_ID = 1;
const API_URL = 'http://localhost:3000';

// Connect to backend Socket.io server
const socket = io(API_URL);

// DOM references
const messageArea = document.querySelector('.message-area');
const messageInput = document.querySelector('.chat-input-footer input');
const chatItems = document.querySelectorAll('.chat-item');
const chatNameHeader = document.getElementById('active-chat-name');
const chatAvatarHeader = document.getElementById('active-chat-avatar');

let currentChatId = null;

// --- SOCKET EVENTS ---

socket.on('connect', () => {
  console.log('✅ Connected to server as', socket.id);
});

socket.on('newMessage', (message) => {
  if (message.chatId === currentChatId) {
    if (message.userId !== CURRENT_USER_ID) {
      addMessageToUI('received', message.data, message.name);
    }
  }
});

// --- UI + FETCH LOGIC ---

async function loadChatHistory(chatId) {
  messageArea.innerHTML = '';
  try {
    const res = await fetch(`${API_URL}/api/chats/${chatId}/messages`);
    const messages = await res.json();
    messages.forEach((msg) => {
      const type = msg.user_id === CURRENT_USER_ID ? 'sent' : 'received';
      addMessageToUI(type, msg.data, msg.name);
    });
  } catch (err) {
    console.error('❌ Error loading messages:', err);
  }
}

// --- Event Listeners ---

chatItems.forEach((item) => {
  item.addEventListener('click', () => {
    const chatId = item.dataset.chatId;
    const name = item.dataset.name;
    const avatar = item.dataset.avatar;

    // Leave old room
    if (currentChatId) socket.emit('leaveRoom', currentChatId);

    // Join new chat
    currentChatId = chatId;
    socket.emit('joinRoom', chatId);

    // Update UI header
    chatNameHeader.textContent = name;
    chatAvatarHeader.src = avatar;

    // Load messages
    loadChatHistory(chatId);

    // Highlight active chat
    document.querySelectorAll('.chat-item').forEach(c => c.classList.remove('active'));
    item.classList.add('active');
  });
});

messageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && messageInput.value.trim() !== '' && currentChatId) {
    const text = messageInput.value.trim();
    const message = {
      data: text,
      chatId: currentChatId,
      userId: CURRENT_USER_ID,
      time: new Date().toISOString(),
    };
    socket.emit('sendMessage', message);
    addMessageToUI('sent', text);
    messageInput.value = '';
  }
});

// --- Helper ---
function addMessageToUI(type, text) {
  const div = document.createElement('div');
  div.classList.add('message', type);
  div.textContent = text;
  messageArea.appendChild(div);
  messageArea.scrollTop = messageArea.scrollHeight;
}
