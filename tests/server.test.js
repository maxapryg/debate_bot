const request = require('supertest');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

// Mock socket.io
jest.mock('socket.io', () => {
    return jest.fn().mockImplementation(() => {
        return {
            on: jest.fn(),
            emit: jest.fn(),
            to: jest.fn().mockReturnThis()
        };
    });
});

// Create test app
const app = express();
app.use(express.json());

// In-memory storage (same as server.js)
const debateSessions = new Map();
let currentSessionId = null;

// Helper functions
function generateVoterId() {
    return 'voter_' + Math.random().toString(36).substr(2, 9);
}

function getCurrentSession() {
    if (!currentSessionId) {
        return null;
    }
    return debateSessions.get(currentSessionId);
}

function calculateResults(session) {
    const total = session.votes.A + session.votes.B;
    return {
        A: total > 0 ? Math.round((session.votes.A / total) * 100) : 50,
        B: total > 0 ? Math.round((session.votes.B / total) * 100) : 50,
        totalVotes: total
    };
}

// API Routes
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
        voterVotes: new Map(),
        isActive: true
    };
    debateSessions.set(sessionId, session);
    currentSessionId = sessionId;
    
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

app.post('/api/vote', (req, res) => {
    const { speaker, voterId } = req.body;
    
    if (!speaker || !['A', 'B'].includes(speaker)) {
        return res.status(400).json({ error: 'Invalid speaker. Must be A or B' });
    }
    
    const session = getCurrentSession();
    if (!session || !session.isActive) {
        return res.status(400).json({ error: 'No active debate session' });
    }
    
    const id = voterId || generateVoterId();
    const previousVote = session.voterVotes.get(id);
    
    if (previousVote) {
        session.votes[previousVote]--;
    }
    
    session.votes[speaker]++;
    session.voterVotes.set(id, speaker);
    
    const results = calculateResults(session);
    
    res.json({
        success: true,
        voterId: id,
        results
    });
});

app.get('/api/results', (req, res) => {
    const session = getCurrentSession();
    
    if (!session) {
        return res.json({
            active: false,
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

// Test server
let testServer;
let serverInstance;

describe('Debate Rating API', () => {
    beforeEach((done) => {
        debateSessions.clear();
        currentSessionId = null;
        serverInstance = http.createServer(app);
        testServer = request(serverInstance);
        serverInstance.listen(0, done);
    });
    
    afterEach((done) => {
        if (serverInstance) {
            serverInstance.close(done);
        } else {
            done();
        }
    });
    
    describe('GET /api/results', () => {
        test('should return default results when no session exists', async () => {
            const response = await testServer
                .get('/api/results')
                .expect(200);
            
            expect(response.body).toEqual({
                active: false,
                results: { A: 50, B: 50, totalVotes: 0 }
            });
        });
        
        test('should return current session results', async () => {
            await testServer.post('/api/debate/start').expect(200);
            
            const response = await testServer
                .get('/api/results')
                .expect(200);
            
            expect(response.body.active).toBe(true);
            expect(response.body.sessionId).toBeDefined();
            expect(response.body.results).toEqual({
                A: 50,
                B: 50,
                totalVotes: 0
            });
        });
    });
    
    describe('POST /api/debate/start', () => {
        test('should create a new debate session', async () => {
            const response = await testServer
                .post('/api/debate/start')
                .expect(200);
            
            expect(response.body.success).toBe(true);
            expect(response.body.sessionId).toBeDefined();
            expect(response.body.sessionId).toMatch(/^debate_\d+$/);
            expect(response.body.votingUrl).toBeDefined();
        });
        
        test('should create session with active status', async () => {
            await testServer.post('/api/debate/start').expect(200);
            
            const results = await testServer
                .get('/api/results')
                .expect(200);
            
            expect(results.body.active).toBe(true);
        });
        
        test('should accept topic parameter', async () => {
            const response = await testServer
                .post('/api/debate/start')
                .send({ topic: 'Test Debate Topic' })
                .expect(200);
            
            expect(response.body.topic).toBe('Test Debate Topic');
        });
        
        test('should use default topic when not provided', async () => {
            const response = await testServer
                .post('/api/debate/start')
                .expect(200);
            
            expect(response.body.topic).toBe('Тема не указана');
        });
        
        test('should accept speakerAName parameter', async () => {
            const response = await testServer
                .post('/api/debate/start')
                .send({ speakerAName: 'John Doe' })
                .expect(200);
            
            expect(response.body.speakerAName).toBe('John Doe');
        });
        
        test('should accept speakerBName parameter', async () => {
            const response = await testServer
                .post('/api/debate/start')
                .send({ speakerBName: 'Jane Smith' })
                .expect(200);
            
            expect(response.body.speakerBName).toBe('Jane Smith');
        });
        
        test('should use default speaker names when not provided', async () => {
            const response = await testServer
                .post('/api/debate/start')
                .expect(200);
            
            expect(response.body.speakerAName).toBe('Спикер A');
            expect(response.body.speakerBName).toBe('Спикер B');
        });
        
        test('should accept all parameters together', async () => {
            const response = await testServer
                .post('/api/debate/start')
                .send({
                    topic: 'AI vs Human',
                    speakerAName: 'Alex',
                    speakerBName: 'Maria'
                })
                .expect(200);
            
            expect(response.body.topic).toBe('AI vs Human');
            expect(response.body.speakerAName).toBe('Alex');
            expect(response.body.speakerBName).toBe('Maria');
        });
    });
    
    describe('POST /api/debate/end', () => {
        test('should end active debate session', async () => {
            await testServer.post('/api/debate/start').expect(200);
            
            const response = await testServer
                .post('/api/debate/end')
                .expect(200);
            
            expect(response.body.success).toBe(true);
            expect(response.body.results).toBeDefined();
        });
        
        test('should return error when no active session', async () => {
            const response = await testServer
                .post('/api/debate/end')
                .expect(400);
            
            expect(response.body.error).toBe('No active session');
        });
        
        test('should set session as inactive', async () => {
            await testServer.post('/api/debate/start').expect(200);
            await testServer.post('/api/debate/end').expect(200);
            
            const results = await testServer
                .get('/api/results')
                .expect(200);
            
            expect(results.body.active).toBe(false);
        });
    });
    
    describe('POST /api/vote', () => {
        test('should reject vote when no active session', async () => {
            const response = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', voterId: 'voter_123' })
                .expect(400);
            
            expect(response.body.error).toBe('No active debate session');
        });
        
        test('should reject invalid speaker', async () => {
            await testServer.post('/api/debate/start').expect(200);
            
            const response = await testServer
                .post('/api/vote')
                .send({ speaker: 'C', voterId: 'voter_123' })
                .expect(400);
            
            expect(response.body.error).toBe('Invalid speaker. Must be A or B');
        });
        
        test('should accept vote for speaker A', async () => {
            await testServer.post('/api/debate/start').expect(200);
            
            const response = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', voterId: 'voter_123' })
                .expect(200);
            
            expect(response.body.success).toBe(true);
            expect(response.body.voterId).toBe('voter_123');
            expect(response.body.results.A).toBe(100);
            expect(response.body.results.B).toBe(0);
            expect(response.body.results.totalVotes).toBe(1);
        });
        
        test('should accept vote for speaker B', async () => {
            await testServer.post('/api/debate/start').expect(200);
            
            const response = await testServer
                .post('/api/vote')
                .send({ speaker: 'B', voterId: 'voter_123' })
                .expect(200);
            
            expect(response.body.results.A).toBe(0);
            expect(response.body.results.B).toBe(100);
        });
        
        test('should allow voter to change vote', async () => {
            await testServer.post('/api/debate/start').expect(200);
            
            await testServer
                .post('/api/vote')
                .send({ speaker: 'A', voterId: 'voter_123' })
                .expect(200);
            
            const response = await testServer
                .post('/api/vote')
                .send({ speaker: 'B', voterId: 'voter_123' })
                .expect(200);
            
            expect(response.body.results.A).toBe(0);
            expect(response.body.results.B).toBe(100);
            expect(response.body.results.totalVotes).toBe(1);
        });
        
        test('should calculate correct percentages with multiple voters', async () => {
            await testServer.post('/api/debate/start').expect(200);
            
            await testServer.post('/api/vote').send({ speaker: 'A', voterId: 'v1' });
            await testServer.post('/api/vote').send({ speaker: 'A', voterId: 'v2' });
            await testServer.post('/api/vote').send({ speaker: 'A', voterId: 'v3' });
            await testServer.post('/api/vote').send({ speaker: 'B', voterId: 'v4' });
            await testServer.post('/api/vote').send({ speaker: 'B', voterId: 'v5' });
            
            const response = await testServer
                .get('/api/results')
                .expect(200);
            
            expect(response.body.results.A).toBe(60);
            expect(response.body.results.B).toBe(40);
            expect(response.body.results.totalVotes).toBe(5);
        });
        
        test('should generate voterId if not provided', async () => {
            await testServer.post('/api/debate/start').expect(200);
            
            const response = await testServer
                .post('/api/vote')
                .send({ speaker: 'A' })
                .expect(200);
            
            expect(response.body.voterId).toBeDefined();
            expect(response.body.voterId).toMatch(/^voter_\w+$/);
        });
        
        test('should reject vote for inactive session', async () => {
            await testServer.post('/api/debate/start').expect(200);
            await testServer.post('/api/debate/end').expect(200);
            
            const response = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', voterId: 'voter_123' })
                .expect(400);
            
            expect(response.body.error).toBe('No active debate session');
        });
        
        test('should handle empty speaker parameter', async () => {
            await testServer.post('/api/debate/start').expect(200);
            
            const response = await testServer
                .post('/api/vote')
                .send({ speaker: '', voterId: 'voter_123' })
                .expect(400);
            
            expect(response.body.error).toBe('Invalid speaker. Must be A or B');
        });
        
        test('should handle missing speaker parameter', async () => {
            await testServer.post('/api/debate/start').expect(200);
            
            const response = await testServer
                .post('/api/vote')
                .send({ voterId: 'voter_123' })
                .expect(400);
            
            expect(response.body.error).toBe('Invalid speaker. Must be A or B');
        });
    });
    
    describe('Calculate Results', () => {
        test('should calculate 50/50 for zero votes', () => {
            const session = {
                votes: { A: 0, B: 0 }
            };
            
            const results = calculateResults(session);
            
            expect(results).toEqual({
                A: 50,
                B: 50,
                totalVotes: 0
            });
        });
        
        test('should calculate correct percentages', () => {
            const session = {
                votes: { A: 30, B: 70 }
            };
            
            const results = calculateResults(session);
            
            expect(results.A).toBe(30);
            expect(results.B).toBe(70);
            expect(results.totalVotes).toBe(100);
        });
        
        test('should round percentages correctly', () => {
            const session = {
                votes: { A: 1, B: 2 }
            };
            
            const results = calculateResults(session);
            
            expect(results.A).toBe(33);
            expect(results.B).toBe(67);
            expect(results.totalVotes).toBe(3);
        });
    });
});
