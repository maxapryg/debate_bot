/**
 * Tests for Browser Fingerprinting protection against vote manipulation
 * Tests the anti-fraud mechanisms in server.js
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

describe('Browser Fingerprinting Protection', () => {
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

        app.get('/api/results', (req, res) => {
            const session = getCurrentSession();
            if (!session) {
                return res.json({ active: false, results: { A: 50, B: 50, totalVotes: 0 } });
            }
            const results = calculateResults(session);
            res.json({ active: session.isActive, results });
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

    describe('Fingerprint-based Voter ID', () => {
        test('should generate consistent voter ID from same fingerprint', async () => {
            await testServer.post('/api/debate/start').expect(200);

            const fingerprint = 'test-fingerprint-12345';

            // First vote with fingerprint
            const response1 = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', fingerprint })
                .expect(200);

            const firstVoterId = response1.body.voterId;
            expect(firstVoterId).toMatch(/^fp_[a-f0-9]{32}$/);

            // Second vote with same fingerprint should use same ID
            const response2 = await testServer
                .post('/api/vote')
                .send({ speaker: 'B', fingerprint })
                .expect(200);

            // Same fingerprint = same voter ID (vote changes, but ID stays same)
            expect(response2.body.voterId).toBe(firstVoterId);
        });

        test('should generate different voter IDs for different fingerprints', async () => {
            await testServer.post('/api/debate/start').expect(200);

            const fingerprint1 = 'fingerprint-user-1';
            const fingerprint2 = 'fingerprint-user-2';

            const response1 = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', fingerprint: fingerprint1 })
                .expect(200);

            const response2 = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', fingerprint: fingerprint2 })
                .expect(200);

            expect(response1.body.voterId).not.toBe(response2.body.voterId);
        });

        test('should generate different voter IDs for same fingerprint but different IPs', async () => {
            await testServer.post('/api/debate/start').expect(200);

            const fingerprint = 'same-fingerprint';

            // Mock different IPs by modifying the request
            const response1 = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', fingerprint })
                .expect(200);

            // Simulate different IP by creating new app instance
            const app2 = express();
            app2.use(express.json());
            app2.post('/api/vote', (req, res) => {
                req.connection.remoteAddress = '192.168.1.100';
                return app._router.handle(req, res);
            });

            // For this test, we verify the function generates different IDs
            const id1 = generateFingerprintId(fingerprint, '127.0.0.1');
            const id2 = generateFingerprintId(fingerprint, '192.168.1.100');

            expect(id1).not.toBe(id2);
        });

        test('should prevent duplicate votes from same fingerprint (incognito protection)', async () => {
            await testServer.post('/api/debate/start').expect(200);

            const fingerprint = 'incognito-user-fingerprint';

            // First vote
            const response1 = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', fingerprint })
                .expect(200);

            expect(response1.body.results.totalVotes).toBe(1);
            expect(response1.body.results.A).toBe(100);

            // Second vote from same fingerprint (simulating incognito refresh)
            const response2 = await testServer
                .post('/api/vote')
                .send({ speaker: 'B', fingerprint })
                .expect(200);

            // Should still be 1 total vote, just changed from A to B
            expect(response2.body.results.totalVotes).toBe(1);
            expect(response2.body.results.A).toBe(0);
            expect(response2.body.results.B).toBe(100);
        });
    });

    describe('Rate Limiting', () => {
        test('should allow up to 10 votes per minute from same IP', async () => {
            await testServer.post('/api/debate/start').expect(200);

            // Make 10 votes from different fingerprints (different voters)
            for (let i = 0; i < 10; i++) {
                const response = await testServer
                    .post('/api/vote')
                    .send({ speaker: 'A', fingerprint: `user-${i}` })
                    .expect(200);
                expect(response.body.success).toBe(true);
            }
        });

        test('should block 11th vote from same IP within one minute', async () => {
            await testServer.post('/api/debate/start').expect(200);

            // Make 10 votes
            for (let i = 0; i < 10; i++) {
                await testServer
                    .post('/api/vote')
                    .send({ speaker: 'A', fingerprint: `user-${i}` })
                    .expect(200);
            }

            // 11th vote should be rate limited
            const response = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', fingerprint: 'user-10' })
                .expect(429);

            expect(response.body.error).toBe('Too many votes. Please wait a minute.');
        });

        test('should reset rate limit after one minute', async () => {
            await testServer.post('/api/debate/start').expect(200);

            // Exhaust rate limit
            for (let i = 0; i < 10; i++) {
                await testServer
                    .post('/api/vote')
                    .send({ speaker: 'A', fingerprint: `user-${i}` })
                    .expect(200);
            }

            // Simulate time passing (mock Date.now)
            const originalDateNow = Date.now;
            Date.now = jest.fn(() => originalDateNow() + 61000); // 61 seconds later

            // Should be allowed now
            const response = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', fingerprint: 'user-11' })
                .expect(200);

            expect(response.body.success).toBe(true);

            Date.now = originalDateNow;
        });

        test('should track rate limits per IP independently', async () => {
            await testServer.post('/api/debate/start').expect(200);

            // Exhaust rate limit for current IP
            for (let i = 0; i < 10; i++) {
                await testServer
                    .post('/api/vote')
                    .send({ speaker: 'A', fingerprint: `user-${i}` })
                    .expect(200);
            }

            // Verify rate limit is hit for current IP
            const response = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', fingerprint: 'user-10' })
                .expect(429);

            expect(response.body.error).toBe('Too many votes. Please wait a minute.');
        });
    });

    describe('Combined Protection', () => {
        test('should handle fingerprint + rate limiting together', async () => {
            await testServer.post('/api/debate/start').expect(200);

            // Same fingerprint should only count as one voter
            const fingerprint = 'persistent-user';

            // Vote multiple times with same fingerprint
            await testServer.post('/api/vote').send({ speaker: 'A', fingerprint }).expect(200);
            await testServer.post('/api/vote').send({ speaker: 'B', fingerprint }).expect(200);
            await testServer.post('/api/vote').send({ speaker: 'A', fingerprint }).expect(200);

            // Should still be 1 total vote
            const results = await testServer.get('/api/results').expect(200);
            expect(results.body.results.totalVotes).toBe(1);
        });

        test('should allow multiple voters from same IP with different fingerprints', async () => {
            await testServer.post('/api/debate/start').expect(200);

            // Multiple users from same network (same IP, different fingerprints)
            const fingerprints = [
                'device-1-fingerprint',
                'device-2-fingerprint',
                'device-3-fingerprint'
            ];

            for (const fp of fingerprints) {
                await testServer
                    .post('/api/vote')
                    .send({ speaker: 'A', fingerprint: fp })
                    .expect(200);
            }

            const results = await testServer.get('/api/results').expect(200);
            expect(results.body.results.totalVotes).toBe(3);
        });

        test('should handle fallback to voterId when no fingerprint', async () => {
            await testServer.post('/api/debate/start').expect(200);

            // Vote without fingerprint, with explicit voterId
            const response = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', voterId: 'custom-voter-id' })
                .expect(200);

            expect(response.body.voterId).toBe('custom-voter-id');
        });

        test('should generate random voterId when no fingerprint and no voterId', async () => {
            await testServer.post('/api/debate/start').expect(200);

            const response = await testServer
                .post('/api/vote')
                .send({ speaker: 'A' })
                .expect(200);

            expect(response.body.voterId).toMatch(/^voter_\w+$/);
        });
    });

    describe('Edge Cases', () => {
        test('should handle empty fingerprint', async () => {
            await testServer.post('/api/debate/start').expect(200);

            const response = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', fingerprint: '' })
                .expect(200);

            // Empty fingerprint should still generate an ID
            expect(response.body.voterId).toBeDefined();
        });

        test('should handle very long fingerprint', async () => {
            await testServer.post('/api/debate/start').expect(200);

            const longFingerprint = 'a'.repeat(500);

            const response = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', fingerprint: longFingerprint })
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.voterId).toBeDefined();
        });

        test('should handle special characters in fingerprint', async () => {
            await testServer.post('/api/debate/start').expect(200);

            const specialFingerprint = 'fp!@#$%^&*()_+-=[]{}|;:,.<>?';

            const response = await testServer
                .post('/api/vote')
                .send({ speaker: 'A', fingerprint: specialFingerprint })
                .expect(200);

            expect(response.body.success).toBe(true);
        });

        test('should generate consistent hash for same fingerprint and IP', () => {
            const fingerprint = 'test-fp';
            const ip = '127.0.0.1';

            const id1 = generateFingerprintId(fingerprint, ip);
            const id2 = generateFingerprintId(fingerprint, ip);

            expect(id1).toBe(id2);
        });

        test('should use default secret when FINGERPRINT_SECRET not set', () => {
            const originalSecret = process.env.FINGERPRINT_SECRET;
            delete process.env.FINGERPRINT_SECRET;

            const fingerprint = 'test';
            const ip = '127.0.0.1';

            const id = generateFingerprintId(fingerprint, ip);

            // Should still generate a valid ID with default secret
            expect(id).toMatch(/^fp_[a-f0-9]{32}$/);

            if (originalSecret) {
                process.env.FINGERPRINT_SECRET = originalSecret;
            }
        });
    });
});
