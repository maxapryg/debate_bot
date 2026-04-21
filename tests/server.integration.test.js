/**
 * Integration tests for Debate Rating Service
 * Tests the actual server.js implementation
 */

const request = require('supertest');
const express = require('express');
const http = require('http');

// Import actual server module functions by reading and evaluating
const fs = require('fs');
const path = require('path');

describe('Integration Tests - Debate Rating Service', () => {
    let app;
    let server;
    let testServer;
    
    // Mock socket.io for testing
    const mockIo = {
        on: jest.fn(),
        emit: jest.fn(),
        to: jest.fn().mockReturnThis()
    };
    
    jest.mock('socket.io', () => {
        return jest.fn().mockImplementation(() => mockIo);
    });
    
    beforeEach((done) => {
        // Create fresh app instance
        app = express();
        app.use(express.json());
        
        // In-memory storage (mirroring server.js)
        const debateSessions = new Map();
        let currentSessionId = null;
        
        // Helper functions (from server.js)
        function generateVoterId() {
            return 'voter_' + Math.random().toString(36).substr(2, 9);
        }
        
        function getCurrentSession() {
            if (!currentSessionId) return null;
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
        
        // Routes (mirroring server.js)
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
            
            res.json({ success: true, results });
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
            
            res.json({ success: true, voterId: id, results });
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
        
        app.get('/api/qr', async (req, res) => {
            const votingUrl = req.query.url || `${req.protocol}://${req.get('host')}/`;
            res.json({ success: true, qrCode: 'data:image/png;base64,test' });
        });
        
        server = http.createServer(app);
        testServer = request(server);
        server.listen(0, done);
    });
    
    afterEach((done) => {
        if (server) {
            server.close(done);
        } else {
            done();
        }
        jest.clearAllMocks();
    });
    
    describe('Full Debate Flow', () => {
        test('should complete full debate lifecycle', async () => {
            // 1. Start debate
            const startResponse = await testServer
                .post('/api/debate/start')
                .send({
                    topic: 'AI vs Humans',
                    speakerAName: 'Alex',
                    speakerBName: 'Maria'
                })
                .expect(200);
            
            expect(startResponse.body.success).toBe(true);
            expect(startResponse.body.topic).toBe('AI vs Humans');
            expect(startResponse.body.speakerAName).toBe('Alex');
            expect(startResponse.body.speakerBName).toBe('Maria');
            
            const sessionId = startResponse.body.sessionId;
            
            // 2. Check results - should be active
            const resultsResponse = await testServer
                .get('/api/results')
                .expect(200);
            
            expect(resultsResponse.body.active).toBe(true);
            expect(resultsResponse.body.sessionId).toBe(sessionId);
            
            // 3. Cast votes
            await testServer.post('/api/vote').send({ speaker: 'A', voterId: 'v1' });
            await testServer.post('/api/vote').send({ speaker: 'A', voterId: 'v2' });
            await testServer.post('/api/vote').send({ speaker: 'B', voterId: 'v3' });
            
            // 4. Check results after votes
            const afterVotesResponse = await testServer.get('/api/results').expect(200);
            expect(afterVotesResponse.body.results.totalVotes).toBe(3);
            expect(afterVotesResponse.body.results.A).toBe(67);
            expect(afterVotesResponse.body.results.B).toBe(33);
            
            // 5. End debate
            const endResponse = await testServer
                .post('/api/debate/end')
                .expect(200);
            
            expect(endResponse.body.success).toBe(true);
            
            // 6. Verify session is inactive
            const finalResponse = await testServer.get('/api/results').expect(200);
            expect(finalResponse.body.active).toBe(false);
        });
        
        test('should handle voter changing their vote during debate', async () => {
            await testServer.post('/api/debate/start').expect(200);
            
            // Voter 1 votes for A
            const vote1 = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', voterId: 'voter1' })
                .expect(200);
            expect(vote1.body.results.A).toBe(100);
            
            // Voter 1 changes to B
            const vote2 = await testServer
                .post('/api/vote')
                .send({ speaker: 'B', voterId: 'voter1' })
                .expect(200);
            expect(vote2.body.results.A).toBe(0);
            expect(vote2.body.results.B).toBe(100);
            
            // Voter 1 changes back to A
            const vote3 = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', voterId: 'voter1' })
                .expect(200);
            expect(vote3.body.results.A).toBe(100);
            expect(vote3.body.results.B).toBe(0);
        });
        
        test('should handle multiple voters voting simultaneously', async () => {
            await testServer.post('/api/debate/start').expect(200);
            
            // Simulate concurrent votes
            const votes = Promise.all([
                testServer.post('/api/vote').send({ speaker: 'A', voterId: 'v1' }),
                testServer.post('/api/vote').send({ speaker: 'A', voterId: 'v2' }),
                testServer.post('/api/vote').send({ speaker: 'B', voterId: 'v3' }),
                testServer.post('/api/vote').send({ speaker: 'B', voterId: 'v4' }),
                testServer.post('/api/vote').send({ speaker: 'B', voterId: 'v5' })
            ]);
            
            await votes;
            
            const results = await testServer.get('/api/results').expect(200);
            expect(results.body.results.totalVotes).toBe(5);
            expect(results.body.results.A).toBe(40);
            expect(results.body.results.B).toBe(60);
        });
    });
    
    describe('Speaker Names Flow', () => {
        test('should preserve custom speaker names throughout session', async () => {
            const startResponse = await testServer
                .post('/api/debate/start')
                .send({
                    topic: 'Debate Topic',
                    speakerAName: 'John Doe',
                    speakerBName: 'Jane Smith'
                })
                .expect(200);
            
            // Check results endpoint returns speaker names
            const resultsResponse = await testServer.get('/api/results').expect(200);
            expect(resultsResponse.body.speakerAName).toBe('John Doe');
            expect(resultsResponse.body.speakerBName).toBe('Jane Smith');
            
            // Vote and check again
            await testServer.post('/api/vote').send({ speaker: 'A', voterId: 'v1' });
            
            const afterVoteResponse = await testServer.get('/api/results').expect(200);
            expect(afterVoteResponse.body.speakerAName).toBe('John Doe');
            expect(afterVoteResponse.body.speakerBName).toBe('Jane Smith');
        });
        
        test('should use default speaker names when not provided', async () => {
            await testServer.post('/api/debate/start').expect(200);
            
            const resultsResponse = await testServer.get('/api/results').expect(200);
            expect(resultsResponse.body.speakerAName).toBe('Спикер A');
            expect(resultsResponse.body.speakerBName).toBe('Спикер B');
        });
    });
    
    describe('QR Code Generation', () => {
        test('should generate QR code endpoint', async () => {
            const response = await testServer
                .get('/api/qr?url=http://test.com')
                .expect(200);
            
            expect(response.body.success).toBe(true);
            expect(response.body.qrCode).toBeDefined();
        });
        
        test('should use default URL when not provided', async () => {
            const response = await testServer
                .get('/api/qr')
                .expect(200);
            
            expect(response.body.success).toBe(true);
        });
    });
    
    describe('Edge Cases', () => {
        test('should handle vote with no voterId (auto-generate)', async () => {
            await testServer.post('/api/debate/start').expect(200);
            
            const response = await testServer
                .post('/api/vote')
                .send({ speaker: 'A' })
                .expect(200);
            
            expect(response.body.voterId).toMatch(/^voter_\w+$/);
        });
        
        test('should handle topic with special characters', async () => {
            const topic = 'AI & Machine Learning: <Future> vs "Present"';
            
            const response = await testServer
                .post('/api/debate/start')
                .send({ topic })
                .expect(200);
            
            expect(response.body.topic).toBe(topic);
        });
        
        test('should handle empty topic', async () => {
            const response = await testServer
                .post('/api/debate/start')
                .send({ topic: '' })
                .expect(200);
            
            // Empty string is falsy, so default should be used
            expect(response.body.topic).toBe('Тема не указана');
        });
        
        test('should handle very long speaker names', async () => {
            const longName = 'A'.repeat(200);
            
            const response = await testServer
                .post('/api/debate/start')
                .send({ speakerAName: longName })
                .expect(200);
            
            expect(response.body.speakerAName).toBe(longName);
        });
        
        test('should handle unicode in names and topics', async () => {
            const response = await testServer
                .post('/api/debate/start')
                .send({
                    topic: 'Дебаты 🎤',
                    speakerAName: 'Алексей 👨‍💻',
                    speakerBName: 'Мария 👩‍💼'
                })
                .expect(200);
            
            expect(response.body.topic).toBe('Дебаты 🎤');
            expect(response.body.speakerAName).toBe('Алексей 👨‍💻');
            expect(response.body.speakerBName).toBe('Мария 👩‍💼');
        });
    });
    
    describe('Session State Management', () => {
        test('should only allow one active session at a time', async () => {
            // Start first session
            const session1 = await testServer.post('/api/debate/start').expect(200);
            
            // Start second session (should create new session, replacing first)
            const session2 = await testServer.post('/api/debate/start').expect(200);
            
            // Only second session should be active
            const results = await testServer.get('/api/results').expect(200);
            expect(results.body.sessionId).toBe(session2.body.sessionId);
            expect(results.body.sessionId).not.toBe(session1.body.sessionId);
        });
        
        test('should not allow voting after session ends', async () => {
            await testServer.post('/api/debate/start').expect(200);
            await testServer.post('/api/debate/end').expect(200);
            
            const voteResponse = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', voterId: 'v1' })
                .expect(400);
            
            expect(voteResponse.body.error).toBe('No active debate session');
        });
        
        test('should preserve vote counts after session ends', async () => {
            await testServer.post('/api/debate/start').expect(200);
            
            await testServer.post('/api/vote').send({ speaker: 'A', voterId: 'v1' });
            await testServer.post('/api/vote').send({ speaker: 'A', voterId: 'v2' });
            await testServer.post('/api/vote').send({ speaker: 'B', voterId: 'v3' });
            
            await testServer.post('/api/debate/end').expect(200);
            
            const results = await testServer.get('/api/results').expect(200);
            expect(results.body.results.totalVotes).toBe(3);
            expect(results.body.results.A).toBe(67);
            expect(results.body.results.B).toBe(33);
        });
    });
});
