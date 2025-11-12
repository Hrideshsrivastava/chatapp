const storedUser = JSON.parse(localStorage.getItem('user'));
if (!storedUser) {
  window.location.href = '/login.html';
}

const API_URL = 'http://localhost:3000';
const socket = io(API_URL);
const CURRENT_USER_ID = storedUser.user_id;

document.getElementById('userName').textContent = storedUser.name;
document.getElementById('userIdDisplay').textContent = `ID: ${CURRENT_USER_ID}`;
document.getElementById('logoutBtn').onclick = () => {
  localStorage.removeItem('user');
  window.location.href = '/login.html';
};




// --- New Chat Button ---
document.getElementById('newChatBtn').onclick = async () => {
  const otherUserId = prompt('Enter the User ID of the person you want to chat with:');
  if (!otherUserId || otherUserId.trim() === '') return;

  try {
    const res = await fetch(`${API_URL}/api/createChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userA: CURRENT_USER_ID, userB: otherUserId.trim() })
    });

    const data = await res.json();

    if (data.success) {
      alert(`Chat created with user ${otherUserId}!`);
      await loadUserChats(); // Reload the chat list
    } else {
      alert('Could not create chat. Check User ID.');
    }
  } catch (err) {
    console.error('❌ Error creating chat:', err);
    alert('Failed to create chat. Check console for details.');
  }
};


// --- Add People Button ---

document.getElementById('addPeopleBtn').onclick = async () => {
  if (!currentChatId) {
    alert('Open a chat first to add people.');
    return;
  }

  const namesRaw = prompt('Enter the NAMES of users to add (comma separated). Use exact display names:');
  if (!namesRaw) return;

  const nameList = namesRaw.split(',')
    .map(n => n.trim())
    .filter(Boolean);

  if (nameList.length === 0) return;

  let groupName = null;
  if (nameList.length > 1) {
    groupName = prompt('You are adding multiple people. Enter a group name (leave blank to use default):');
    if (groupName !== null) groupName = groupName.trim();
  }

  try {
    const res = await fetch(`${API_URL}/api/addMembersToChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: currentChatId,
        memberNames: nameList,
        groupName: groupName || null
      })
    });

    const data = await res.json();
    if (!data.success) {
      alert(data.error || 'Could not add members. Check console for details.');
      console.error('addMembersToChat failed:', data);
      return;
    }

    // Success: refresh chat list and optionally open the chat again
    await loadUserChats();
    alert('Members added successfully.');
    // Optionally re-open the current chat to reload messages/participants
    openChat(currentChatId);
  } catch (err) {
    console.error('❌ Error adding people:', err);
    alert('Network or server error while adding people. See console.');
  }
};


// DOM references
const chatList = document.getElementById('chatList');
const messageArea = document.querySelector('.message-area');
const messageInput = document.querySelector('.chat-input-footer input');
const chatNameHeader = document.getElementById('active-chat-name');
const chatAvatarHeader = document.getElementById('active-chat-avatar');

let currentChatId = null;
let userChats = [];

// --- Load Chats (Always Fresh from DB) ---
async function loadUserChats() {
  try {
    const res = await fetch(`${API_URL}/api/user/${CURRENT_USER_ID}/chats?nocache=${Date.now()}`);
    userChats = await res.json();

    if (userChats.length === 0) {
      chatList.innerHTML = `<p style="text-align:center;color:#777;">No chats yet</p>`;
      return;
    }

    renderChatList();
  } catch (err) {
    console.error('❌ Error fetching chats:', err);
  }
}

// --- Render Sidebar ---
function renderChatList() {
  chatList.innerHTML = '';
  userChats.forEach((chat) => {
    const div = document.createElement('div');
    div.classList.add('chat-item');
    div.dataset.chatId = chat.chat_id;
    div.innerHTML = `
      <img src="https://via.placeholder.com/50/33FF57/FFFFFF?text=${chat.chat_name[0]}" class="avatar" />
      <div class="chat-info">
        <div class="chat-name">${chat.chat_name}</div>
        <div class="chat-message">${chat.messages.at(-1)?.data || 'No messages yet'}</div>
      </div>
    `;
    div.onclick = () => openChat(chat.chat_id);
    chatList.appendChild(div);
  });
}

// --- Open Chat ---
function openChat(chatId) {
  currentChatId = chatId;
  const chat = userChats.find((c) => c.chat_id == chatId);
  chatNameHeader.textContent = chat.chat_name;
  messageArea.innerHTML = '';
  socket.emit('joinRoom', chatId);

  chat.messages.forEach((msg) => {
  const type = msg.user_id === CURRENT_USER_ID ? 'sent' : 'received';
  addMessageToUI(type, msg.data, msg.name, msg.id, msg.user_id);
});

}

// --- Send Message ---
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
    


    messageInput.value = '';
  }
});



socket.on('messageAck', (msg) => {
  addMessageToUI('sent', msg.data, msg.name, msg.id, msg.userId);

  const chat = userChats.find((c) => c.chat_id == msg.chatId);
  if (chat) chat.messages.push(msg);
});



// --- Listen for New Messages ---
socket.on('newMessage', (msg) => {
  if (msg.chatId == currentChatId) addMessageToUI('received', msg.data, msg.name);

  // Update chat memory
  const chat = userChats.find((c) => c.chat_id == msg.chatId);
  if (chat) chat.messages.push(msg);
});


socket.on('messageDeleted', (msgId) => {
  const msgDiv = document.querySelector(`[data-message-id="${msgId}"]`);
  if (msgDiv) msgDiv.remove();
});

socket.on('messageEdited', ({ msgId, newText }) => {
  const msgDiv = document.querySelector(`[data-message-id="${msgId}"]`);
  if (msgDiv) msgDiv.textContent = newText + ' (edited)';
});

// --- Helper ---
function addMessageToUI(type, text, name, messageId = null, senderId = null) {
  const div = document.createElement('div');
  div.classList.add('message', type);
  div.textContent = text;

  // Store metadata for edit/delete
  div.dataset.messageId = messageId;
  div.dataset.senderId = senderId;

  // If this is my own message, make it clickable
  if (senderId === CURRENT_USER_ID && messageId) {
    div.style.cursor = 'pointer';
    div.onclick = () => showMessageOptions(div);
  }

  messageArea.appendChild(div);
  messageArea.scrollTop = messageArea.scrollHeight;
}


async function showMessageOptions(div) {
  const msgId = div.dataset.messageId;
  const currentText = div.textContent;
  const choice = prompt('Choose: type "edit" to edit, "delete" to delete this message:', '');

  if (!choice) return;
  if (choice.toLowerCase() === 'delete') {
    const confirmDel = confirm('Delete this message?');
    if (!confirmDel) return;

    try {
      const res = await fetch(`${API_URL}/api/messages/${msgId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: CURRENT_USER_ID })
      });
      const data = await res.json();
      if (data.success) {
        div.remove();
        socket.emit('deleteMessage', { chatId: currentChatId, msgId });
      } else {
        alert('Could not delete message.');
      }
    } catch (err) {
      console.error('❌ Delete error:', err);
    }
  }

  if (choice.toLowerCase() === 'edit') {
    const newText = prompt('Edit your message:', currentText);
    if (!newText || newText === currentText) return;

    try {
      const res = await fetch(`${API_URL}/api/messages/${msgId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: CURRENT_USER_ID, newText })
      });
      const data = await res.json();
      if (data.success) {
        div.textContent = newText + ' (edited)';
        socket.emit('editMessage', { chatId: currentChatId, msgId, newText });
      } else {
        alert('Could not edit message.');
      }
    } catch (err) {
      console.error('❌ Edit error:', err);
    }
  }
}


// --- INIT ---
loadUserChats();
