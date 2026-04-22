const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage for debate sessions
const debateSessions = new Map();
let currentSessionId = null;

// Generate unique voter ID
function generateVoterId() {
    return 'voter_' + Math.random().toString(36).substr(2, 9);
}

// Get or create current debate session
function getCurrentSession() {
    if (!currentSessionId) {
        return null;
    }
    return debateSessions.get(currentSessionId);
}

// Calculate percentages
function calculateResults(session) {
    const total = session.votes.A + session.votes.B;
    return {
        A: total > 0 ? Math.round((session.votes.A / total) * 100) : 50,
        B: total > 0 ? Math.round((session.votes.B / total) * 100) : 50,
        totalVotes: total
    };
}

// API Routes

// Start new debate session
app.post('/api/debate/start', (req, res) => {
    const sessionId = 'debate_' + Date.now();
    const { topic, speakerAName, speakerBName } = req.body || {};
    const session = {
        id: sessionId,
        topic: topic || 'Тема не указана',
        speakerAName: speakerAName || 'Спикер A',
        speakerBName: speakerBName || 'Спикер B',
        startTime: new Date(),
        votes: { A: 0, B: 0 },
        voterVotes: new Map(), // voterId -> 'A' or 'B'
        isActive: true
    };
    debateSessions.set(sessionId, session);
    currentSessionId = sessionId;
    
    // Generate voting URL
    const votingUrl = `${req.protocol}://${req.get('host')}/`;
    
    res.json({
        success: true,
        sessionId,
        topic: session.topic,
        speakerAName: session.speakerAName,
        speakerBName: session.speakerBName,
        votingUrl
    });
});

// End current debate session
app.post('/api/debate/end', (req, res) => {
    if (!currentSessionId) {
        return res.status(400).json({ error: 'No active session' });
    }
    
    const session = debateSessions.get(currentSessionId);
    if (session) {
        session.isActive = false;
        session.endTime = new Date();
    }
    
    const results = calculateResults(session);
    
    res.json({
        success: true,
        results
    });
});

// Submit vote
app.post('/api/vote', (req, res) => {
    const { speaker, voterId } = req.body;
    
    if (!speaker || !['A', 'B'].includes(speaker)) {
        return res.status(400).json({ error: 'Invalid speaker. Must be A or B' });
    }
    
    const session = getCurrentSession();
    if (!session || !session.isActive) {
        return res.status(400).json({ error: 'No active debate session' });
    }
    
    // Generate voter ID if not provided
    const id = voterId || generateVoterId();
    
    // Check if voter already voted
    const previousVote = session.voterVotes.get(id);
    
    if (previousVote) {
        // Remove previous vote
        session.votes[previousVote]--;
    }
    
    // Add new vote
    session.votes[speaker]++;
    session.voterVotes.set(id, speaker);
    
    const results = calculateResults(session);
    
    // Broadcast to all connected clients
    io.emit('voteUpdate', results);
    
    res.json({
        success: true,
        voterId: id,
        results
    });
});

// Get current results
app.get('/api/results', (req, res) => {
    const session = getCurrentSession();
    
    if (!session) {
        return res.json({
            active: false,
            topic: null,
            speakerAName: null,
            speakerBName: null,
            results: { A: 50, B: 50, totalVotes: 0 }
        });
    }
    
    const results = calculateResults(session);
    
    res.json({
        active: session.isActive,
        sessionId: session.id,
        topic: session.topic,
        speakerAName: session.speakerAName,
        speakerBName: session.speakerBName,
        results
    });
});

// Generate QR code image
app.get('/api/qr', async (req, res) => {
    const votingUrl = req.query.url || `${req.protocol}://${req.get('host')}/`;
    
    try {
        const qrCodeDataUrl = await QRCode.toDataURL(votingUrl);
        res.json({
            success: true,
            qrCode: qrCodeDataUrl
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate QR code' });
    }
});

// Serve HTML pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/display', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    // Send current results on connection
    const session = getCurrentSession();
    if (session) {
        const results = calculateResults(session);
        socket.emit('voteUpdate', results);
    }
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`🎤 Debate Rating Service running on http://localhost:${PORT}`);
    console.log(`📊 Display page: http://localhost:${PORT}/display`);
    console.log(`⚙️  Admin panel: http://localhost:${PORT}/admin`);
});
