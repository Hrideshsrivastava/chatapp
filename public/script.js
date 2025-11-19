// script.js
const storedUser = JSON.parse(localStorage.getItem('user'));
if (!storedUser) window.location.href = '/login.html';

const CURRENT_USER_ID = String(storedUser.user_id); // string secret code
const API_URL = window.location.origin;
if (!window.socket) {
  window.socket = io(API_URL, { autoConnect: true });
}
const socket = window.socket;


// DOM
const chatList = document.getElementById('chatList');
const messageArea = document.querySelector('.message-area');
const messageInput = document.getElementById('messageInput');
const chatNameHeader = document.getElementById('active-chat-name');
const chatAvatarHeader = document.getElementById('active-chat-avatar');

document.getElementById('userName').textContent = storedUser.name;
document.getElementById('userIdDisplay').textContent = `ID: ${CURRENT_USER_ID}`;
document.getElementById('userAvatar').src = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(storedUser.name)}&backgroundColor=00f3ff`;

document.getElementById('logoutBtn').onclick = () => {
  localStorage.removeItem('user'); window.location.href = '/login.html';
};

let currentChatId = null;
let userChats = [];

// New chat
document.getElementById('newChatBtn').onclick = async () => {
  const other = prompt('Enter the 5-char secret ID of the person to chat with:');
  if (!other) return;
  try {
    const res = await fetch(`${API_URL}/api/createChat`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ userA: CURRENT_USER_ID, userB: other.trim() })
    });
    const data = await res.json();
    if (data.success) {
      await loadUserChats();
      openChat(data.chat.chat_id);
    } else alert('Could not create chat: ' + (data.error || 'unknown'));
  } catch (err) { console.error(err); alert('Network error'); }
};

// Add people
document.getElementById('addPeopleBtn').onclick = async () => {
  if (!currentChatId) {
    alert('Open a chat first to add people.');
    return;
  }

  // Ask for list of members to add
  const namesRaw = prompt('Enter the NAMES of users to add (comma separated). Use exact display names:');
  if (!namesRaw) return;

  const nameList = namesRaw
    .split(',')
    .map(n => n.trim())
    .filter(Boolean);

  if (nameList.length === 0) return;

  // 🔥 ALWAYS ask for group name
  let groupName = prompt("Enter a GROUP NAME for this chat:");

  if (!groupName || groupName.trim() === "") {
    alert("Group name is required.");
    return;
  }

  groupName = groupName.trim();

  try {
    const res = await fetch(`${API_URL}/api/addMembersToChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: currentChatId,
        memberNames: nameList,
        groupName: groupName
      })
    });

    const data = await res.json();
    if (!data.success) {
      alert(data.error || 'Could not add members.');
      return;
    }

    await loadUserChats();
    alert('Members added successfully.');
    openChat(currentChatId);

  } catch (err) {
    console.error('❌ Error adding people:', err);
    alert('Server error while adding people.');
  }
};

// Load chats
async function loadUserChats() {
  try {
    const res = await fetch(`${API_URL}/api/user/${CURRENT_USER_ID}/chats?nocache=${Date.now()}`);
    userChats = await res.json();
    // Normalize user_id as string in messages
    userChats.forEach(c => {
      c.messages = (c.messages || []).map(m => ({ ...m, user_id: String(m.user_id) }));
    });
    if (!userChats.length) { chatList.innerHTML = `<p style="text-align:center;color:#777">No chats yet</p>`; return; }
    renderChatList();
  } catch (err) { console.error('Error loading chats', err); }
}

// Render sidebar
function renderChatList() {
  chatList.innerHTML = '';
  userChats.forEach(chat => {
    const last = chat.messages?.[chat.messages.length - 1]?.data || 'No messages yet';
    const div = document.createElement('div');
    div.className = 'chat-item';
    div.dataset.chatId = chat.chat_id;
    const initial = (chat.chat_name || 'C')[0] || 'C';
    div.innerHTML = `
      <img class="avatar" src="https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(chat.chat_name||'User')}&backgroundColor=00f3ff"/>
      <div class="chat-info"><div class="chat-name">${chat.chat_name}</div><div class="chat-message">${last}</div></div>
    `;
    div.onclick = () => openChat(chat.chat_id);
    chatList.appendChild(div);
  });
}

// Open chat
function openChat(chatId) {
  currentChatId = chatId;
  document.querySelectorAll('.chat-item').forEach(el=>el.classList.remove('active'));
  const active = document.querySelector(`.chat-item[data-chat-id="${chatId}"]`); if (active) active.classList.add('active');
  const chat = userChats.find(c => String(c.chat_id) === String(chatId));
  if (!chat) return;
  chatNameHeader.textContent = chat.chat_name;
  chatAvatarHeader.src = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(chat.chat_name)}&backgroundColor=00f3ff`;
  chatAvatarHeader.style.opacity = '1';
  messageArea.innerHTML = '';
  socket.emit('joinRoom', chatId);

  chat.messages.forEach(m => {
    const type = String(m.user_id) === CURRENT_USER_ID ? 'sent' : 'received';
    addMessageToUI(type, m.data, m.name, m.id, m.user_id);
  });
}

// send on Enter or click send icon
messageInput.addEventListener('keypress', e => {
  if (e.key === 'Enter') sendMessage();
});
document.getElementById('sendBtn').onclick = sendMessage;

function sendMessage() {
  if (!currentChatId) { alert('Open chat first'); return; }
  const text = messageInput.value.trim();
  if (!text) return;
  const msg = { data: text, chatId: currentChatId, userId: CURRENT_USER_ID, time: new Date().toISOString() };
  socket.emit('sendMessage', msg);
  messageInput.value = '';
}

// socket handlers
socket.on('newMessage', msg => {
  msg.user_id = String(msg.user_id);
  // push into memory
  const chat = userChats.find(c => String(c.chat_id) === String(msg.chatId));
  if (chat) chat.messages.push(msg);
  // if currently open, display
  if (String(msg.chatId) === String(currentChatId)) {
    const t = String(msg.user_id) === CURRENT_USER_ID ? 'sent' : 'received';
    addMessageToUI(t, msg.data, msg.name, msg.id, msg.user_id);
  } else {
    // optionally indicate unread; for now reload list
    loadUserChats();
  }
});

socket.on('messageDeleted', msgId => {
  const el = document.querySelector(`[data-message-id="${msgId}"]`);
  if (el) el.remove();
});
socket.on('messageEdited', ({ msgId, newText }) => {
  const el = document.querySelector(`[data-message-id="${msgId}"]`);
  if (el) el.textContent = newText + ' (edited)';
});

// add message DOM
function addMessageToUI(type, text, name, messageId = null, senderId = null) {
  const div = document.createElement('div');
  div.classList.add('message', type);

  // Create message container
  const messageWrapper = document.createElement('div');
  messageWrapper.classList.add('msg-wrapper');

  // 🌟 Check if group chat (>2 participants)
  const chat = userChats.find(c => c.chat_id == currentChatId);
  const isGroup = chat && chat.participants && chat.participants.length > 2;

  // 🌟 Add sender name IF:
  // - It's a group
  // - The sender is NOT the current user
  if (isGroup && senderId !== CURRENT_USER_ID) {
    const nameTag = document.createElement('div');
    nameTag.classList.add('sender-name');
    nameTag.textContent = name;
    messageWrapper.appendChild(nameTag);
  }

  // Message text bubble
  const bubble = document.createElement('div');
  bubble.classList.add('bubble');
  bubble.textContent = text;

  messageWrapper.appendChild(bubble);
  div.appendChild(messageWrapper);

  // Metadata
  div.dataset.messageId = messageId;
  div.dataset.senderId = senderId;

  // Clickable messages (edit/delete) only for own messages
  if (senderId === CURRENT_USER_ID && messageId) {
    bubble.style.cursor = 'pointer';
    bubble.onclick = () => showMessageOptions(div);
  }

  messageArea.appendChild(div);
  messageArea.scrollTop = messageArea.scrollHeight;
}


// edit/delete popup
async function showMessageOptions(div) {
  const id = div.dataset.messageId;
  const choice = prompt('type "edit" or "delete"');
  if (!choice) return;
  if (choice.toLowerCase() === 'delete') {
    if (!confirm('Delete?')) return;
    const res = await fetch(`${API_URL}/api/messages/${id}`, {
      method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ userId: CURRENT_USER_ID })
    });
    const data = await res.json();
    if (data.success) { div.remove(); socket.emit('deleteMessage', { chatId: currentChatId, msgId: id }); }
    else alert(data.error || 'Could not delete');
  } else if (choice.toLowerCase() === 'edit') {
    const newText = prompt('New text', div.textContent);
    if (!newText) return;
    const res = await fetch(`${API_URL}/api/messages/${id}`, {
      method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ userId: CURRENT_USER_ID, newText })
    });
    const data = await res.json();
    if (data.success) { div.textContent = newText + ' (edited)'; socket.emit('editMessage', { chatId: currentChatId, msgId: id, newText }); }
    else alert(data.error || 'Could not edit');
  }
}

// init
loadUserChats();
