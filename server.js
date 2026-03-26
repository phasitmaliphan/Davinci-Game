const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const os = require('os');
const { startTunnel } = require('untun');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============ QUESTIONS ============
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');

function loadQuestions() {
  try {
    return JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf-8'));
  } catch (e) {
    return [];
  }
}

function saveQuestions(questions) {
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2), 'utf-8');
}

// ============ GET LOCAL IP ============
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

let publicUrl = null;

// ============ QR CODE ENDPOINT ============
app.get('/api/qrcode', async (req, res) => {
  try {
    const localIP = getLocalIP();
    const PORT = process.env.PORT || 3000;
    const url = publicUrl || `http://${localIP}:${PORT}`;
    const qrDataUrl = await QRCode.toDataURL(url, {
      width: 400,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
    res.json({ qr: qrDataUrl, url });
  } catch (err) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// ============ ADMIN API ============
// Get all questions
app.get('/api/questions', (req, res) => {
  res.json(loadQuestions());
});

// Update a single question
app.put('/api/questions/:id', (req, res) => {
  const questions = loadQuestions();
  const id = parseInt(req.params.id);
  const idx = questions.findIndex(q => q.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const { answers, display } = req.body;
  if (answers) questions[idx].answers = answers;
  if (display) questions[idx].display = display;
  saveQuestions(questions);
  res.json(questions[idx]);
});

// Update all questions (bulk)
app.put('/api/questions', (req, res) => {
  const questions = req.body;
  if (!Array.isArray(questions)) return res.status(400).json({ error: 'Expected array' });
  saveQuestions(questions);
  res.json({ success: true, count: questions.length });
});

// Upload image for a question
app.post('/api/upload/:id', express.raw({ type: 'image/*', limit: '10mb' }), (req, res) => {
  const id = req.params.id;
  const imgPath = path.join(__dirname, 'public', 'images', `q${id}.png`);
  fs.writeFileSync(imgPath, req.body);
  res.json({ success: true, path: `/images/q${id}.png` });
});

// ============ GAME STATE ============
const ROUND_TIME = 60; // seconds per round

let gameState = {
  status: 'waiting',    // waiting | playing | showing-winner | finished
  currentRound: 0,
  players: new Map(),   // socketId -> { name, score, joinedAt }
  guesses: [],          // { name, text, timestamp }
  winner: null,
  totalRounds: 0,
  timeLeft: ROUND_TIME
};

// Store disconnected players for reconnection (name -> { score, disconnectedAt })
let disconnectedPlayers = new Map();
const RECONNECT_GRACE_MS = 5 * 60 * 1000; // 5 minutes grace period

let roundTimerInterval = null;

function clearRoundTimer() {
  if (roundTimerInterval) {
    clearInterval(roundTimerInterval);
    roundTimerInterval = null;
  }
}

function startRoundTimer() {
  clearRoundTimer();
  gameState.timeLeft = ROUND_TIME;

  roundTimerInterval = setInterval(() => {
    gameState.timeLeft--;
    io.emit('timer-tick', { timeLeft: gameState.timeLeft });

    if (gameState.timeLeft <= 0) {
      clearRoundTimer();

      // Auto-reveal answer
      if (gameState.status === 'playing') {
        const questions = loadQuestions();
        gameState.status = 'showing-winner';
        gameState.winner = {
          name: null,
          answer: questions[gameState.currentRound].display,
          round: gameState.currentRound + 1
        };
        console.log('⏰ Time\'s up! Auto-revealing answer.');
        io.emit('round-winner', {
          winner: gameState.winner,
          players: getPlayerList(),
          isLastRound: gameState.currentRound >= questions.length - 1
        });
      }
    }
  }, 1000);
}

function resetGame() {
  gameState.status = 'waiting';
  gameState.currentRound = 0;
  gameState.guesses = [];
  gameState.winner = null;
  for (const [id, player] of gameState.players) {
    player.score = 0;
  }
}

function getPlayerList() {
  const list = [];
  for (const [id, player] of gameState.players) {
    list.push({ id, name: player.name, score: player.score });
  }
  return list.sort((a, b) => b.score - a.score);
}

function checkAnswer(guess, roundIndex) {
  const questions = loadQuestions();
  const q = questions[roundIndex];
  if (!q) return false;
  const normalizedGuess = guess.trim().toLowerCase();
  return q.answers.some(a => normalizedGuess === a.toLowerCase());
}

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
  console.log(`🔌 Connected: ${socket.id}`);
  const questions = loadQuestions();

  // Send current game state to new connection
  socket.emit('game-state', {
    status: gameState.status,
    currentRound: gameState.currentRound,
    totalRounds: questions.length,
    players: getPlayerList(),
    guesses: gameState.guesses,
    winner: gameState.winner,
    timeLeft: gameState.timeLeft,
    question: (gameState.status === 'playing' || gameState.status === 'showing-winner') ? {
      id: questions[gameState.currentRound]?.id,
      image: questions[gameState.currentRound]?.image,
      roundNumber: gameState.currentRound + 1
    } : null
  });

  // ---------- Player Join ----------
  socket.on('join', (name) => {
    if (!name || name.trim().length === 0) return;
    const trimmedName = name.trim().substring(0, 20);

    // Check if this player was previously connected (reconnect)
    let restoredScore = 0;
    if (disconnectedPlayers.has(trimmedName)) {
      restoredScore = disconnectedPlayers.get(trimmedName).score;
      disconnectedPlayers.delete(trimmedName);
      console.log(`🔄 ${trimmedName} rejoined with score ${restoredScore}`);
    }

    // Remove any existing entry with the same name (prevent duplicates)
    for (const [existingId, existingPlayer] of gameState.players) {
      if (existingPlayer.name === trimmedName && existingId !== socket.id) {
        gameState.players.delete(existingId);
        break;
      }
    }

    gameState.players.set(socket.id, {
      name: trimmedName,
      score: restoredScore,
      joinedAt: Date.now()
    });
    console.log(`👤 ${trimmedName} joined (${gameState.players.size} players)`);
    io.emit('player-joined', {
      name: trimmedName,
      playerCount: gameState.players.size,
      players: getPlayerList()
    });
  });

  // ---------- Submit Guess ----------
  socket.on('submit-guess', (guessText) => {
    if (gameState.status !== 'playing') return;
    const player = gameState.players.get(socket.id);
    if (!player) return;
    const text = guessText.trim().substring(0, 50);
    if (!text) return;

    const guess = {
      name: player.name,
      text,
      timestamp: Date.now(),
      socketId: socket.id
    };
    gameState.guesses.push(guess);

    // Broadcast guess to word cloud
    io.emit('new-guess', {
      name: player.name,
      text,
      guessCount: gameState.guesses.length
    });

    // Check if correct
    if (checkAnswer(text, gameState.currentRound)) {
      clearRoundTimer();
      player.score += 1;
      gameState.status = 'showing-winner';
      const questions = loadQuestions();
      gameState.winner = {
        name: player.name,
        answer: questions[gameState.currentRound].display,
        round: gameState.currentRound + 1
      };
      console.log(`🏆 ${player.name} got the correct answer!`);
      io.emit('round-winner', {
        winner: gameState.winner,
        players: getPlayerList(),
        isLastRound: gameState.currentRound >= questions.length - 1
      });
    }
  });

  // ---------- Host Controls ----------
  socket.on('start-game', () => {
    const questions = loadQuestions();
    console.log('🎮 Game started!');
    gameState.status = 'playing';
    gameState.currentRound = 0;
    gameState.guesses = [];
    gameState.winner = null;
    gameState.totalRounds = questions.length;

    for (const [id, player] of gameState.players) {
      player.score = 0;
    }

    const q = questions[0];
    io.emit('round-start', {
      roundNumber: 1,
      totalRounds: questions.length,
      question: { id: q.id, image: q.image },
      players: getPlayerList(),
      timeLeft: ROUND_TIME
    });
    startRoundTimer();
  });

  // Go to specific round (supports next/back)
  socket.on('go-to-round', (roundIndex) => {
    const questions = loadQuestions();
    if (roundIndex < 0 || roundIndex >= questions.length) return;

    gameState.currentRound = roundIndex;
    gameState.status = 'playing';
    gameState.guesses = [];
    gameState.winner = null;

    const q = questions[roundIndex];
    console.log(`➡️ Round ${roundIndex + 1}`);

    io.emit('round-start', {
      roundNumber: roundIndex + 1,
      totalRounds: questions.length,
      question: { id: q.id, image: q.image },
      players: getPlayerList(),
      timeLeft: ROUND_TIME
    });
    startRoundTimer();
  });

  // Reveal answer without anyone guessing
  socket.on('reveal-answer', () => {
    if (gameState.status !== 'playing') return;
    clearRoundTimer();
    const questions = loadQuestions();

    gameState.status = 'showing-winner';
    gameState.winner = {
      name: null,
      answer: questions[gameState.currentRound].display,
      round: gameState.currentRound + 1
    };

    console.log(`💡 Host revealed the answer!`);
    io.emit('round-winner', {
      winner: gameState.winner,
      players: getPlayerList(),
      isLastRound: gameState.currentRound >= questions.length - 1
    });
  });

  socket.on('next-round', () => {
    const questions = loadQuestions();
    gameState.currentRound++;

    if (gameState.currentRound >= questions.length) {
      gameState.status = 'finished';
      console.log('🏁 Game finished!');
      io.emit('game-over', { players: getPlayerList() });
      return;
    }

    gameState.status = 'playing';
    gameState.guesses = [];
    gameState.winner = null;

    const q = questions[gameState.currentRound];
    console.log(`➡️ Round ${gameState.currentRound + 1}`);

    io.emit('round-start', {
      roundNumber: gameState.currentRound + 1,
      totalRounds: questions.length,
      question: { id: q.id, image: q.image },
      players: getPlayerList(),
      timeLeft: ROUND_TIME
    });
    startRoundTimer();
  });

  socket.on('prev-round', () => {
    const questions = loadQuestions();
    if (gameState.currentRound <= 0) return;

    gameState.currentRound--;
    gameState.status = 'playing';
    gameState.guesses = [];
    gameState.winner = null;

    const q = questions[gameState.currentRound];
    console.log(`⬅️ Back to Round ${gameState.currentRound + 1}`);

    io.emit('round-start', {
      roundNumber: gameState.currentRound + 1,
      totalRounds: questions.length,
      question: { id: q.id, image: q.image },
      players: getPlayerList(),
      timeLeft: ROUND_TIME
    });
    startRoundTimer();
  });

  socket.on('end-game', () => {
    clearRoundTimer();
    gameState.status = 'finished';
    console.log('🏁 Game ended by host!');
    io.emit('game-over', { players: getPlayerList() });
  });

  socket.on('reset-game', () => {
    clearRoundTimer();
    console.log('🔄 Game reset');
    resetGame();
    io.emit('game-reset', { players: getPlayerList() });
  });

  // ---------- Disconnect ----------
  socket.on('disconnect', () => {
    const player = gameState.players.get(socket.id);
    if (player) {
      console.log(`👋 ${player.name} disconnected (saving for reconnect)`);
      // Save player data for potential reconnection
      disconnectedPlayers.set(player.name, {
        score: player.score,
        disconnectedAt: Date.now()
      });
      gameState.players.delete(socket.id);
      io.emit('player-left', {
        name: player.name,
        playerCount: gameState.players.size,
        players: getPlayerList()
      });

      // Clean up after grace period
      setTimeout(() => {
        const dc = disconnectedPlayers.get(player.name);
        if (dc && Date.now() - dc.disconnectedAt >= RECONNECT_GRACE_MS) {
          disconnectedPlayers.delete(player.name);
          console.log(`🗑️ ${player.name} removed from reconnect pool (timed out)`);
        }
      }, RECONNECT_GRACE_MS);
    }
  });
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  const localIP = getLocalIP();
  console.log(`\n🎨 Davinci Game Server running at:`);
  console.log(`   Local:    http://localhost:${PORT}`);
  console.log(`   Network:  http://${localIP}:${PORT}`);
  console.log(`   Host:     http://localhost:${PORT}/host.html`);
  console.log(`   Admin:    http://localhost:${PORT}/admin.html`);

  console.log(`\n   กำลังเปิดให้เข้าใช้ผ่านอินเทอร์เน็ต (Public URL)...`);

  try {
    const tunnel = await startTunnel({ port: PORT });
    publicUrl = await tunnel.getURL();
    console.log(`   🌍 Public: ${publicUrl}`);
    console.log(`   ✅ ผู้เล่นสามารถสแกน QR Code เข้ามาโดยตรง ไม่ต้องกรอกรหัสผ่าน (Cloudflare)`);
    console.log('\n');
  } catch (err) {
    console.log(`   ❌ ไม่สามารถสร้าง Public URL ได้: ${err.message}`);
    console.log(`   ⚠️ ให้ผู้เล่นเชื่อมต่อ WiFi เดียวกัน แล้วใช้ IP: ${localIP}:${PORT}\n`);
  }
});
