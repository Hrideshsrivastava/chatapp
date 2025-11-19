// --- Imports ---
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const cors = require('cors');
const crypto = require('crypto');

// --- App Setup ---
const app = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- Socket.io ---
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// --- MySQL ---
const dbPool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '2006',
  database: 'whatsapp_clone',
  waitForConnections: true,
  connectionLimit: 10,
});

// ======================================================
// USER ID GENERATOR (5-char alphanumeric)
// ======================================================
function generateId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function generateUniqueUserId() {
  while (true) {
    const id = generateId();
    const [rows] = await dbPool.execute('SELECT user_id FROM user WHERE user_id = ?', [id]);
    if (rows.length === 0) return id;
  }
}

// ======================================================
// LOGIN / REGISTER
// ======================================================
app.post('/api/login', async (req, res) => {
  const { userId, password, name } = req.body;

  try {
    // LOGIN EXISTING USER
    if (userId) {
      const [rows] = await dbPool.execute(
        'SELECT * FROM user WHERE user_id = ? AND password = ?',
        [userId, password]
      );
      if (rows.length > 0) return res.json({ success: true, user: rows[0] });
      return res.status(401).json({ success: false, message: 'Invalid ID or password.' });
    }

    // REGISTER NEW USER
    const newId = await generateUniqueUserId();
    await dbPool.execute(
      'INSERT INTO user (user_id, name, password) VALUES (?, ?, ?)',
      [newId, name || 'New User', password]
    );

    return res.json({
      success: true,
      user: { user_id: newId, name: name || 'New User' }
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// ======================================================
// FETCH CHATS FOR A USER
// ======================================================

app.get('/api/user/:userId/chats', async (req, res) => {
  const { userId } = req.params;

  try {
    const [chats] = await dbPool.execute(
      `
      SELECT 
        c.chat_id,
        CASE 
          WHEN c.group_name IS NOT NULL THEN c.group_name
          ELSE (
            SELECT u.name 
            FROM participants p2
            JOIN user u ON p2.user_id = u.user_id
            WHERE p2.chat_id = c.chat_id AND p2.user_id != ?
            LIMIT 1
          )
        END AS chat_name
      FROM chats c
      JOIN participants p ON c.chat_id = p.chat_id
      WHERE p.user_id = ?
      `,
      [userId, userId]
    );

    // Attach messages and participants (INSIDE loop)
    for (const chat of chats) {

      // messages
      const [messages] = await dbPool.execute(
        `
        SELECT t.id, t.data, t.time, t.user_id, u.name
        FROM texts t
        LEFT JOIN user u ON t.user_id = u.user_id
        WHERE t.chat_id = ?
        ORDER BY t.time ASC
        `,
        [chat.chat_id]
      );

      chat.messages = messages.map(m => ({
        ...m,
        user_id: String(m.user_id)
      }));

      // participants (INSIDE loop)
      const [participants] = await dbPool.execute(
        `
        SELECT u.user_id, u.name
        FROM participants p
        JOIN user u ON p.user_id = u.user_id
        WHERE p.chat_id = ?
        `,
        [chat.chat_id]
      );

      chat.participants = participants;
    }

    res.json(chats);

  } catch (err) {
    console.error('Fetch chats error:', err);
    res.status(500).json({ error: 'Failed to load chats' });
  }
});

// ======================================================
// CREATE PRIVATE CHAT USING YOUR PROCEDURE
// ======================================================
app.post('/api/createChat', async (req, res) => {
  const { userA, userB } = req.body;

  if (!userA || !userB)
    return res.status(400).json({ error: 'Both user IDs required' });

  try {
    const [result] = await dbPool.query(
      'CALL CreateOrGetChat(?, ?)',
      [userA, userB]
    );

    const chatId = result[0][0].chat_id;

    const [chatInfo] = await dbPool.execute(
      'SELECT * FROM chats WHERE chat_id = ?',
      [chatId]
    );

    res.json({ success: true, chat: chatInfo[0] });

  } catch (err) {
    console.error('CreateChat error:', err);
    res.status(500).json({ error: 'Failed to create/get chat' });
  }
});

// ======================================================
// ADD MEMBERS TO CHAT
// ======================================================
app.post('/api/addMembersToChat', async (req, res) => {
  const { chatId, memberNames, groupName } = req.body;

  if (!chatId || !Array.isArray(memberNames))
    return res.status(400).json({ success: false, error: 'Invalid data' });

  try {
    for (const entry of memberNames) {
      const trimmed = entry.trim();

      // Try ID first
      let userId = null;

      if (/^[A-Za-z0-9]{5}$/.test(trimmed)) {
        const [rows] = await dbPool.execute('SELECT user_id FROM user WHERE user_id = ?', [trimmed]);
        if (rows.length) userId = rows[0].user_id;
      }

      // If ID not found → search by name
      if (!userId) {
        const [rows] = await dbPool.execute('SELECT user_id FROM user WHERE name = ?', [trimmed]);
        if (rows.length) userId = rows[0].user_id;
      }

      if (!userId) {
        return res.status(404).json({ success: false, error: `User not found: "${trimmed}"` });
      }

      // Insert participant (ignore duplicates)
      await dbPool.execute(
        'INSERT IGNORE INTO participants (chat_id, user_id) VALUES (?, ?)',
        [chatId, userId]
      );
    }

    // Update group name if provided
    if (groupName && groupName.trim() !== '') {
      await dbPool.execute(
        'UPDATE chats SET group_name = ?, chat_name = ? WHERE chat_id = ?',
        [groupName, groupName, chatId]
      );
    }

    res.json({ success: true });

  } catch (err) {
    console.error('AddMembers error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// ======================================================
// DELETE MESSAGE USING YOUR PROCEDURE
// ======================================================
app.delete('/api/messages/:id', async (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;

  try {
    await dbPool.query('CALL DeleteMessage(?, ?)', [id, userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('DeleteMessage error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete message' });
  }
});

// ======================================================
// EDIT MESSAGE USING YOUR PROCEDURE
// ======================================================
app.put('/api/messages/:id', async (req, res) => {
  const { id } = req.params;
  const { userId, newText } = req.body;

  try {
    await dbPool.query('CALL EditMessage(?, ?, ?)', [id, userId, newText]);
    res.json({ success: true });
  } catch (err) {
    console.error('EditMessage error:', err);
    res.status(500).json({ success: false, error: 'Failed to edit message' });
  }
});

// ======================================================
// SOCKET.IO
// ======================================================
io.on('connection', socket => {
  console.log(`Connected → ${socket.id}`);

  socket.on('joinRoom', chatId => {
    socket.join(chatId);
  });

  socket.on('deleteMessage', data => {
    io.to(data.chatId).emit('messageDeleted', data.msgId);
  });

  socket.on('editMessage', data => {
    io.to(data.chatId).emit('messageEdited', data);
  });

  socket.on('sendMessage', async msg => {
    try {
      const { data, chatId, userId, time } = msg;

      const [insert] = await dbPool.execute(
        'INSERT INTO texts (data, chat_id, user_id, time) VALUES (?, ?, ?, ?)',
        [data, chatId, userId, new Date(time)]
      );

      const messageId = insert.insertId;

      const [u] = await dbPool.execute(
        'SELECT name FROM user WHERE user_id = ?',
        [userId]
      );

      const fullMessage = {
        id: messageId,
        data,
        chatId,
        user_id: userId,
        name: u[0]?.name || 'Unknown',
        time
      };

      io.to(chatId).emit('newMessage', fullMessage);

    } catch (err) {
      console.error('Message save error:', err);
    }
  });
});

// ======================================================
const PORT = 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
