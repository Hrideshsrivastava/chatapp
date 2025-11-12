// --- Imports ---
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const cors = require('cors');
const crypto = require('crypto');

// --- App + Server Setup ---
const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- Socket.io Setup ---
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// --- MySQL Connection ---
const dbPool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '2006',
  database: 'whatsapp_clone',
  waitForConnections: true,
  connectionLimit: 10,
});

// --- Helper: Generate random 5-letter user_id ---
function generateUserId() {
  return crypto.randomBytes(3).toString('hex').substring(0, 5);
}

// --- LOGIN / REGISTER API ---
app.post('/api/login', async (req, res) => {
  const { userId, password, name } = req.body;

  try {
    if (userId) {
      const [rows] = await dbPool.execute(
        'SELECT * FROM user WHERE user_id = ? AND password = ?',
        [userId, password]
      );
      if (rows.length > 0) {
        res.json({ success: true, user: rows[0] });
      } else {
        res.status(401).json({ success: false, message: 'Invalid credentials.' });
      }
    } else {
      const newId = generateUserId();
      await dbPool.execute(
        'INSERT INTO user (user_id, name, password) VALUES (?, ?, ?)',
        [newId, name || 'New User', password]
      );
      res.json({ success: true, userId: newId, name: name || 'New User' });
    }
  } catch (err) {
    console.error('Error in login/register:', err);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// --- FETCH ALL CHATS FOR USER ---
// --- FETCH ALL CHATS FOR USER (fixed) ---
app.get('/api/user/:userId/chats', async (req, res) => {
  const { userId } = req.params;

  try {
    // Get all chats the user participates in
    const [chats] = await dbPool.execute(
      `SELECT c.chat_id,
              COALESCE(c.group_name, c.chat_name, CONCAT('Chat ', c.chat_id)) AS chat_name
         FROM chats c
         JOIN participants p ON c.chat_id = p.chat_id
        WHERE p.user_id = ?`,
      [userId]
    );

    // Get messages for each chat
    for (const chat of chats) {
      const [messages] = await dbPool.execute(
        `SELECT t.id, t.data, t.time, t.user_id, u.name
           FROM texts t
           JOIN \`user\` u ON t.user_id = u.user_id
          WHERE t.chat_id = ?
          ORDER BY t.time ASC`,
        [chat.chat_id]
      );
      chat.messages = messages;
    }

    res.json(chats); // ✅  Always return an array
  } catch (err) {
    console.error('❌ /api/user/:userId/chats error:', err);
    res.status(500).json({ error: 'Failed to load chats' });
  }
});

// --- API: Create or Get Chat Between Two Users ---
app.post('/api/createChat', async (req, res) => {
  const { userA, userB } = req.body;
  if (!userA || !userB) return res.status(400).json({ error: 'Both user IDs required' });

  try {
    const [result] = await dbPool.query('CALL CreateOrGetChat(?, ?)', [userA, userB]);
    const chatId = result[0][0].chat_id;

    // Return the full chat info (chat_id + name)
    const [chatInfo] = await dbPool.execute('SELECT * FROM chats WHERE chat_id = ?', [chatId]);

    res.json({ success: true, chat: chatInfo[0] });
  } catch (err) {
    console.error('❌ Error creating chat:', err);
    res.status(500).json({ error: 'Failed to create or get chat' });
  }
});

app.post('/api/createPrivateChat', async (req, res) => {
  const { userA, userBName } = req.body;
  if (!userA || !userBName) return res.status(400).json({ error: 'Missing parameters' });

  try {
    // Find the target user by name
    const [rows] = await dbPool.execute('SELECT user_id FROM user WHERE name = ?', [userBName]);
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const userB = rows[0].user_id;

    const [result] = await dbPool.query('CALL CreateOrGetChat(?, ?)', [userA, userB]);
    const chatId = result[0][0].chat_id;
    const [chatInfo] = await dbPool.execute('SELECT * FROM chats WHERE chat_id = ?', [chatId]);
    res.json({ success: true, chat: chatInfo[0] });
  } catch (err) {
    console.error('❌ createPrivateChat:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


app.post('/api/createGroupChat', async (req, res) => {
  const { creatorId, groupName, memberNames } = req.body;
  if (!creatorId || !groupName || !Array.isArray(memberNames)) {
    return res.status(400).json({ error: 'Invalid data' });
  }

  try {
    // Create a new chat with group_name
    const [insertChat] = await dbPool.execute(
      'INSERT INTO chats (chat_name, group_name) VALUES (?, ?)',
      [groupName, groupName]
    );
    const chatId = insertChat.insertId;

    // Add the creator
    await dbPool.execute('INSERT INTO participants (chat_id, user_id) VALUES (?, ?)', [chatId, creatorId]);

    // Add members by name
    for (const name of memberNames) {
      const [u] = await dbPool.execute('SELECT user_id FROM user WHERE name = ?', [name]);
      if (u.length > 0) {
        await dbPool.execute('INSERT INTO participants (chat_id, user_id) VALUES (?, ?)', [chatId, u[0].user_id]);
      }
    }

    const [chatInfo] = await dbPool.execute('SELECT * FROM chats WHERE chat_id = ?', [chatId]);
    res.json({ success: true, chat: chatInfo[0] });
  } catch (err) {
    console.error('❌ createGroupChat:', err);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// --- API: Add members to an existing chat (safe, transactional) ---
// --- API: Add members to an existing chat (robust lookup & transactional) ---
// --- API: Add members to an existing chat (robust lookup & transactional) ---
app.post('/api/addMembersToChat', async (req, res) => {
  const { chatId, memberNames, groupName } = req.body;
  if (!chatId || !Array.isArray(memberNames) || memberNames.length === 0) {
    return res.status(400).json({ success: false, error: 'chatId and memberNames required' });
  }

  const conn = await dbPool.getConnection();
  try {
    await conn.beginTransaction();

    // helper: try multiple lookup strategies and return user_id or null
    async function findUserIdByNameOrId(raw) {
      if (!raw) return null;
      const original = raw;
      const trimmed = raw.trim();

      // 1) Exact match on name (trimmed)
      let [rows] = await conn.execute('SELECT user_id, name FROM `user` WHERE name = ?', [trimmed]);
      if (rows.length > 0) return rows[0].user_id;

      // 2) Case-insensitive match using COLLATE (works if collation is case-sensitive)
      [rows] = await conn.execute('SELECT user_id, name FROM `user` WHERE name COLLATE utf8mb4_general_ci = ?', [trimmed]);
      if (rows.length > 0) return rows[0].user_id;

      // 3) LIKE match (partial; helpful if stored name has hidden chars)
      [rows] = await conn.execute('SELECT user_id, name FROM `user` WHERE name LIKE ?', [`%${trimmed}%`]);
      if (rows.length === 1) return rows[0].user_id;
      if (rows.length > 1) {
        // ambiguous match - return null so caller reports precise error
        console.warn(`Ambiguous LIKE match for "${original}" -> multiple users:`, rows.map(r=>r.name));
        return null;
      }

      // 4) If input looks like a 5-char user id (alnum), try matching user_id
      const maybeId = trimmed;
      if (/^[a-zA-Z0-9]{5}$/.test(maybeId)) {
        [rows] = await conn.execute('SELECT user_id, name FROM `user` WHERE user_id = ?', [maybeId]);
        if (rows.length > 0) return rows[0].user_id;
      }

      // not found
      return null;
    }

    // For each name, find user_id and insert if not participant
    for (const rawName of memberNames) {
      const name = (rawName || '').trim();
      if (!name) continue;

      const userId = await findUserIdByNameOrId(name);
      if (!userId) {
        // rollback and return exact reason plus some hints
        await conn.rollback();
        return res.status(404).json({
          success: false,
          error: `User not found or ambiguous for input: "${name}". Try exact display name or paste their user ID.`,
        });
      }

      // insert if not already participant
      const [pRows] = await conn.execute(
        'SELECT 1 FROM participants WHERE chat_id = ? AND user_id = ? LIMIT 1',
        [chatId, userId]
      );
      if (pRows.length === 0) {
        await conn.execute('INSERT INTO participants (chat_id, user_id) VALUES (?, ?)', [chatId, userId]);
      }
    }

    // Update group name if provided
    if (groupName && groupName.trim() !== '') {
      await conn.execute(
        'UPDATE chats SET group_name = ?, chat_name = ? WHERE chat_id = ?',
        [groupName.trim(), groupName.trim(), chatId]
      );
    } else {
      // optional: if more than 2 participants and no group_name, create default group name
      const [countRows] = await conn.execute('SELECT COUNT(*) as cnt FROM participants WHERE chat_id = ?', [chatId]);
      if (countRows[0].cnt > 2) {
        const [chatRows] = await conn.execute('SELECT group_name FROM chats WHERE chat_id = ?', [chatId]);
        if (!chatRows[0].group_name) {
          const defaultName = `Group ${chatId}`;
          await conn.execute('UPDATE chats SET chat_name = ?, group_name = ? WHERE chat_id = ?', [defaultName, defaultName, chatId]);
        }
      }
    }

    await conn.commit();

    // return updated chat info + participants
    const [chatInfo] = await dbPool.execute('SELECT * FROM chats WHERE chat_id = ?', [chatId]);
    const [participants] = await dbPool.execute(
      `SELECT u.user_id, u.name
       FROM participants p JOIN \`user\` u ON p.user_id = u.user_id
       WHERE p.chat_id = ?`,
      [chatId]
    );

    return res.json({ success: true, chat: chatInfo[0], participants });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('❌ addMembersToChat error (robust):', err);
    return res.status(500).json({ success: false, error: 'Server error while adding members' });
  } finally {
    conn.release();
  }
});

// --- API: Delete message via procedure ---
app.delete('/api/messages/:id', async (req, res) => {
  const { id } = req.params;
  const { userId } = req.body;
  try {
    await dbPool.query('CALL DeleteMessage(?, ?)', [id, userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ DeleteMessage error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete message' });
  }
});

// --- API: Edit message via procedure ---
app.put('/api/messages/:id', async (req, res) => {
  const { id } = req.params;
  const { userId, newText } = req.body;
  try {
    await dbPool.query('CALL EditMessage(?, ?, ?)', [id, userId, newText]);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ EditMessage error:', err);
    res.status(500).json({ success: false, error: 'Failed to edit message' });
  }
});



// --- SOCKET.IO CHAT HANDLING ---
io.on('connection', (socket) => {
  console.log(`✅ Connected: ${socket.id}`);

  socket.on('joinRoom', (chatId) => {
    socket.join(chatId);
    console.log(`➡️ Joined chat ${chatId}`);
  });


  socket.on('deleteMessage', (data) => {
  io.to(data.chatId).emit('messageDeleted', data.msgId);
});

socket.on('editMessage', (data) => {
  io.to(data.chatId).emit('messageEdited', { msgId: data.msgId, newText: data.newText });
});


  socket.on('sendMessage', async (msg) => {
  try {
    const { data, chatId, userId, time } = msg;

    // Save to DB
    const [insertResult] = await dbPool.execute(
      'INSERT INTO texts (data, chat_id, user_id, time) VALUES (?, ?, ?, ?)',
      [data, chatId, userId, new Date(time)]
    );
    const messageId = insertResult.insertId;

    // Fetch sender name
    const [u] = await dbPool.execute('SELECT name FROM user WHERE user_id = ?', [userId]);
    const senderName = u[0]?.name || 'Unknown';

    // Create message object
    const fullMessage = {
      id: messageId,
      data,
      chatId,
      userId,
      name: senderName,
      time,
    };

    // ✅ Send to all other participants
    socket.to(chatId).emit('newMessage', fullMessage);

    // ✅ Send acknowledgment back to the sender (for clickable message)
    socket.emit('messageAck', fullMessage);
  } catch (err) {
    console.error('❌ Error saving message:', err);
  }
});






});


// --- Start Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Running at http://localhost:${PORT}`));
