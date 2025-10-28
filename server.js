// --- Imports ---
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const cors = require('cors');

// --- App + Server Setup ---
const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve the frontend files

// --- Socket.io Setup ---
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// --- MySQL Database Connection ---
const dbPool = mysql.createPool({
  host: 'localhost',
  user: 'root',           // 🔸 Change this
  password: 'Kashish@1471', // 🔸 Change this
  database: 'whatsapp_clone', // 🔸 Create this DB
  waitForConnections: true,
  connectionLimit: 10,
});

// --- API: Get Chat Messages ---
app.get('/api/chats/:chatId/messages', async (req, res) => {
  const { chatId } = req.params;
  try {
    const [messages] = await dbPool.execute(
      `SELECT T.data, T.time, T.user_id, U.name 
       FROM texts T
       JOIN user U ON T.user_id = U.user_id
       WHERE T.chat_id = ?
       ORDER BY T.time ASC`,
      [chatId]
    );
    res.json(messages);
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: 'Failed to retrieve messages.' });
  }
});

// --- SOCKET.IO LOGIC ---
io.on('connection', (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  socket.on('joinRoom', (chatId) => {
    socket.join(chatId);
    console.log(`➡️ ${socket.id} joined room ${chatId}`);
  });

  socket.on('leaveRoom', (chatId) => {
    socket.leave(chatId);
    console.log(`⬅️ ${socket.id} left room ${chatId}`);
  });

  socket.on('sendMessage', async (message) => {
    try {
      const { data, chatId, userId, time } = message;
      // Save to DB
      await dbPool.execute(
        `INSERT INTO texts (data, chat_id, user_id, time) VALUES (?, ?, ?, ?)`,
        [data, chatId, userId, new Date(time)]
      );

      const [userRows] = await dbPool.execute(
        'SELECT name FROM user WHERE user_id = ?',
        [userId]
      );
      const senderName = userRows[0]?.name || 'Unknown';

      const fullMessage = { ...message, name: senderName };

      // Send to everyone in the same room
      io.to(chatId).emit('newMessage', fullMessage);
    } catch (err) {
      console.error('❌ Error saving/broadcasting message:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log(`❌ User disconnected: ${socket.id}`);
  });
});

// --- Start Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🚀 Server running at http://localhost:${PORT}`)
);
