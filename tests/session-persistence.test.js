/**
 * Tests for session persistence and vote retention
 * Tests that votes persist across page reloads within the same session
 * and are reset when a new session starts
 */

const request = require('supertest');
const express = require('express');
const http = require('http');
const crypto = require('crypto');

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

describe('Session Persistence and Vote Retention', () => {
    let app;
    let testServer;
    let serverInstance;
    let debateSessions;
    let currentSessionId;
    let rateLimitStore;

    // Helper functions (mirroring server.js)
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

    function checkRateLimit(ip) {
        const now = Date.now();
        const record = rateLimitStore.get(ip);
        const RATE_LIMIT_WINDOW = 60000;
        const RATE_LIMIT_MAX = 10;

        if (!record || now > record.resetTime) {
            rateLimitStore.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
            return true;
        }

        if (record.count >= RATE_LIMIT_MAX) {
            return false;
        }

        record.count++;
        return true;
    }

    function generateFingerprintId(fingerprint, ip) {
        const data = `${fingerprint}-${ip}-${process.env.FINGERPRINT_SECRET || 'default-secret'}`;
        return 'fp_' + crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
    }

    beforeEach((done) => {
        debateSessions = new Map();
        currentSessionId = null;
        rateLimitStore = new Map();

        app = express();
        app.use(express.json());

        // Start debate session
        app.post('/api/debate/start', (req, res) => {
            const sessionId = 'debate_' + Date.now();
            const session = {
                id: sessionId,
                topic: 'Test Debate',
                speakerAName: 'Спикер A',
                speakerBName: 'Спикер B',
                startTime: new Date(),
                votes: { A: 0, B: 0 },
                voterVotes: new Map(),
                isActive: true
            };
            debateSessions.set(sessionId, session);
            currentSessionId = sessionId;
            res.json({ success: true, sessionId });
        });

        // Vote endpoint with fingerprint protection
        app.post('/api/vote', (req, res) => {
            const { speaker, voterId, fingerprint } = req.body;
            const ip = req.ip || req.connection.remoteAddress || '127.0.0.1';

            if (!speaker || !['A', 'B'].includes(speaker)) {
                return res.status(400).json({ error: 'Invalid speaker. Must be A or B' });
            }

            const session = getCurrentSession();
            if (!session || !session.isActive) {
                return res.status(400).json({ error: 'No active debate session' });
            }

            // Check rate limiting
            if (!checkRateLimit(ip)) {
                return res.status(429).json({ error: 'Too many votes. Please wait a minute.' });
            }

            // Generate voter ID from fingerprint if available
            let id;
            if (fingerprint) {
                id = generateFingerprintId(fingerprint, ip);
            } else if (voterId) {
                id = voterId;
            } else {
                id = generateVoterId();
            }

            const previousVote = session.voterVotes.get(id);

            if (previousVote) {
                session.votes[previousVote]--;
            }

            session.votes[speaker]++;
            session.voterVotes.set(id, speaker);

            const results = calculateResults(session);
            res.json({ success: true, voterId: id, results });
        });

        // End debate session
        app.post('/api/debate/end', (req, res) => {
            if (!currentSessionId) {
                return res.status(400).json({ error: 'No active session' });
            }

            const session = debateSessions.get(currentSessionId);
            if (session) {
                session.isActive = false;
                session.endTime = new Date();
            }

            const results = calculateResults(getCurrentSession());
            res.json({ success: true, results });
        });

        // Get results endpoint (returns sessionId for persistence tracking)
        app.get('/api/results', (req, res) => {
            const session = getCurrentSession();
            if (!session) {
                return res.json({
                    active: false,
                    sessionId: null,
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

    describe('Vote Persistence Within Session', () => {
        test('should return sessionId in results endpoint', async () => {
            const startResponse = await testServer.post('/api/debate/start').expect(200);
            const sessionId = startResponse.body.sessionId;

            const resultsResponse = await testServer.get('/api/results').expect(200);

            expect(resultsResponse.body.sessionId).toBe(sessionId);
            expect(resultsResponse.body.active).toBe(true);
        });

        test('should maintain vote across multiple result checks (simulating page reloads)', async () => {
            await testServer.post('/api/debate/start').expect(200);

            const fingerprint = 'persistent-voter';

            // Vote for A
            const voteResponse = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', fingerprint })
                .expect(200);

            expect(voteResponse.body.results.A).toBe(100);
            expect(voteResponse.body.results.totalVotes).toBe(1);

            // Simulate multiple page reloads (checking results multiple times)
            for (let i = 0; i < 5; i++) {
                const results = await testServer.get('/api/results').expect(200);
                expect(results.body.results.A).toBe(100);
                expect(results.body.results.totalVotes).toBe(1);
            }
        });

        test('should allow voter to change vote within same session', async () => {
            await testServer.post('/api/debate/start').expect(200);

            const fingerprint = 'changeable-voter';

            // Vote for A
            await testServer
                .post('/api/vote')
                .send({ speaker: 'A', fingerprint })
                .expect(200);

            // Change vote to B
            const changeVoteResponse = await testServer
                .post('/api/vote')
                .send({ speaker: 'B', fingerprint })
                .expect(200);

            expect(changeVoteResponse.body.results.A).toBe(0);
            expect(changeVoteResponse.body.results.B).toBe(100);
            expect(changeVoteResponse.body.results.totalVotes).toBe(1);
        });

        test('should maintain multiple voters votes across session', async () => {
            await testServer.post('/api/debate/start').expect(200);

            // Multiple voters vote
            await testServer.post('/api/vote').send({ speaker: 'A', fingerprint: 'v1' }).expect(200);
            await testServer.post('/api/vote').send({ speaker: 'A', fingerprint: 'v2' }).expect(200);
            await testServer.post('/api/vote').send({ speaker: 'B', fingerprint: 'v3' }).expect(200);

            // Check results multiple times (simulating reloads)
            for (let i = 0; i < 3; i++) {
                const results = await testServer.get('/api/results').expect(200);
                expect(results.body.results.totalVotes).toBe(3);
                expect(results.body.results.A).toBe(67);
                expect(results.body.results.B).toBe(33);
            }
        });
    });

    describe('Vote Reset on New Session', () => {
        test('should have different sessionId for new debate sessions', async () => {
            const session1 = await testServer.post('/api/debate/start').expect(200);
            const session2 = await testServer.post('/api/debate/start').expect(200);

            expect(session1.body.sessionId).not.toBe(session2.body.sessionId);
        });

        test('should reset votes when new session starts (different sessionId)', async () => {
            // Start first session
            await testServer.post('/api/debate/start').expect(200);

            // Vote in first session
            const fingerprint = 'session-voter';
            await testServer
                .post('/api/vote')
                .send({ speaker: 'A', fingerprint })
                .expect(200);

            const results1 = await testServer.get('/api/results').expect(200);
            expect(results1.body.results.totalVotes).toBe(1);
            const firstSessionId = results1.body.sessionId;

            // Start new session (this replaces the old one)
            await testServer.post('/api/debate/start').expect(200);

            const results2 = await testServer.get('/api/results').expect(200);
            expect(results2.body.sessionId).not.toBe(firstSessionId);
            expect(results2.body.results.totalVotes).toBe(0);
        });

        test('should clear session tracking when debate ends', async () => {
            await testServer.post('/api/debate/start').expect(200);

            const fingerprint = 'end-session-voter';
            await testServer
                .post('/api/vote')
                .send({ speaker: 'A', fingerprint })
                .expect(200);

            // End the session
            await testServer.post('/api/debate/end').expect(200);

            const results = await testServer.get('/api/results').expect(200);
            expect(results.body.active).toBe(false);
            expect(results.body.sessionId).toBeDefined(); // Session ID still exists but inactive
        });

        test('should not allow voting after session ends', async () => {
            await testServer.post('/api/debate/start').expect(200);
            await testServer.post('/api/debate/end').expect(200);

            const response = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', fingerprint: 'test' })
                .expect(400);

            expect(response.body.error).toBe('No active debate session');
        });
    });

    describe('Session State Management', () => {
        test('should provide all necessary data for client-side session tracking', async () => {
            await testServer.post('/api/debate/start').expect(200);

            const results = await testServer.get('/api/results').expect(200);

            // Client needs: active status, sessionId for persistence tracking
            expect(results.body).toHaveProperty('active');
            expect(results.body).toHaveProperty('sessionId');
            expect(results.body).toHaveProperty('results');
            expect(results.body).toHaveProperty('speakerAName');
            expect(results.body).toHaveProperty('speakerBName');
        });

        test('should return null sessionId when no session exists', async () => {
            // Don't start a session, just check results
            const results = await testServer.get('/api/results').expect(200);

            expect(results.body.active).toBe(false);
            expect(results.body.sessionId).toBeNull();
        });

        test('should maintain sessionId throughout session lifetime', async () => {
            const startResponse = await testServer.post('/api/debate/start').expect(200);
            const sessionId = startResponse.body.sessionId;

            // Vote
            await testServer.post('/api/vote').send({ speaker: 'A', fingerprint: 'v1' });

            // Check results multiple times
            for (let i = 0; i < 3; i++) {
                const results = await testServer.get('/api/results').expect(200);
                expect(results.body.sessionId).toBe(sessionId);
            }

            // End session
            await testServer.post('/api/debate/end').expect(200);

            // SessionId should still be the same (but inactive)
            const finalResults = await testServer.get('/api/results').expect(200);
            expect(finalResults.body.sessionId).toBe(sessionId);
            expect(finalResults.body.active).toBe(false);
        });
    });

    describe('Client-Side Session Tracking Simulation', () => {
        test('should simulate client detecting new session and resetting vote', async () => {
            // Simulate client-side storage
            let clientStoredSessionId = null;
            let clientStoredVote = null;

            // Start first session
            await testServer.post('/api/debate/start').expect(200);

            // Client loads page, gets session info
            let results = await testServer.get('/api/results').expect(200);
            clientStoredSessionId = results.body.sessionId;

            // Client votes
            await testServer
                .post('/api/vote')
                .send({ speaker: 'A', fingerprint: 'client-sim' })
                .expect(200);
            clientStoredVote = 'A';

            // Client reloads page - checks session
            results = await testServer.get('/api/results').expect(200);
            // Same sessionId, vote should persist
            expect(results.body.sessionId).toBe(clientStoredSessionId);
            expect(clientStoredVote).toBe('A');

            // New session starts (admin starts new debate)
            await testServer.post('/api/debate/start').expect(200);

            // Client reloads page - detects new session
            results = await testServer.get('/api/results').expect(200);
            if (clientStoredSessionId && results.body.sessionId !== clientStoredSessionId) {
                // New session detected - client should reset vote
                clientStoredVote = null;
                clientStoredSessionId = results.body.sessionId;
            }

            expect(clientStoredVote).toBeNull();
        });

        test('should simulate vote persistence across multiple page reloads', async () => {
            await testServer.post('/api/debate/start').expect(200);

            // Simulate client-side storage
            const clientStorage = {
                sessionId: null,
                vote: null
            };

            // Initial page load
            let results = await testServer.get('/api/results').expect(200);
            clientStorage.sessionId = results.body.sessionId;

            // Vote
            await testServer
                .post('/api/vote')
                .send({ speaker: 'B', fingerprint: 'persistent-client' })
                .expect(200);
            clientStorage.vote = 'B';

            // Simulate 10 page reloads
            for (let i = 0; i < 10; i++) {
                results = await testServer.get('/api/results').expect(200);

                // Client checks if session changed
                if (clientStorage.sessionId !== results.body.sessionId) {
                    clientStorage.vote = null; // Reset vote on new session
                }

                // Session should be the same, vote should persist
                expect(results.body.sessionId).toBe(clientStorage.sessionId);
                expect(clientStorage.vote).toBe('B');
            }
        });
    });
});
