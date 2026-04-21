/**
 * Unit tests for utility functions
 */

// Utility functions extracted from server.js
function generateVoterId() {
    return 'voter_' + Math.random().toString(36).substr(2, 9);
}

function calculateResults(session) {
    const total = session.votes.A + session.votes.B;
    return {
        A: total > 0 ? Math.round((session.votes.A / total) * 100) : 50,
        B: total > 0 ? Math.round((session.votes.B / total) * 100) : 50,
        totalVotes: total
    };
}

describe('Utility Functions', () => {
    describe('generateVoterId', () => {
        test('should generate a string starting with voter_', () => {
            const id = generateVoterId();
            expect(id).toMatch(/^voter_\w+$/);
        });

        test('should generate unique IDs', () => {
            const ids = new Set();
            for (let i = 0; i < 100; i++) {
                ids.add(generateVoterId());
            }
            expect(ids.size).toBe(100);
        });

        test('should generate ID with correct length', () => {
            const id = generateVoterId();
            // 'voter_' = 6 chars + 9 random chars = 15 chars
            expect(id.length).toBe(15);
        });
    });

    describe('calculateResults', () => {
        test('should return 50/50 when no votes', () => {
            const session = { votes: { A: 0, B: 0 } };
            const results = calculateResults(session);

            expect(results).toEqual({
                A: 50,
                B: 50,
                totalVotes: 0
            });
        });

        test('should calculate 100% for A when only A has votes', () => {
            const session = { votes: { A: 10, B: 0 } };
            const results = calculateResults(session);

            expect(results).toEqual({
                A: 100,
                B: 0,
                totalVotes: 10
            });
        });

        test('should calculate 100% for B when only B has votes', () => {
            const session = { votes: { A: 0, B: 5 } };
            const results = calculateResults(session);

            expect(results).toEqual({
                A: 0,
                B: 100,
                totalVotes: 5
            });
        });

        test('should calculate 50/50 for equal votes', () => {
            const session = { votes: { A: 25, B: 25 } };
            const results = calculateResults(session);

            expect(results).toEqual({
                A: 50,
                B: 50,
                totalVotes: 50
            });
        });

        test('should calculate correct percentages for uneven votes', () => {
            const session = { votes: { A: 30, B: 70 } };
            const results = calculateResults(session);

            expect(results).toEqual({
                A: 30,
                B: 70,
                totalVotes: 100
            });
        });

        test('should round percentages correctly', () => {
            const session = { votes: { A: 1, B: 2 } };
            const results = calculateResults(session);

            expect(results.A).toBe(33);
            expect(results.B).toBe(67);
            expect(results.totalVotes).toBe(3);
        });

        test('should handle large numbers', () => {
            const session = { votes: { A: 1000, B: 2000 } };
            const results = calculateResults(session);

            expect(results.A).toBe(33);
            expect(results.B).toBe(67);
            expect(results.totalVotes).toBe(3000);
        });

        test('should handle single vote', () => {
            const session = { votes: { A: 1, B: 0 } };
            const results = calculateResults(session);

            expect(results.A).toBe(100);
            expect(results.B).toBe(0);
            expect(results.totalVotes).toBe(1);
        });

        test('percentages should always sum to 100 (or close)', () => {
            const testCases = [
                { A: 1, B: 2 },
                { A: 5, B: 7 },
                { A: 13, B: 17 },
                { A: 100, B: 200 }
            ];

            testCases.forEach(({ A, B }) => {
                const session = { votes: { A, B } };
                const results = calculateResults(session);
                expect(results.A + results.B).toBe(100);
            });
        });
        
        test('should handle very small numbers', () => {
            const session = { votes: { A: 1, B: 1 } };
            const results = calculateResults(session);

            expect(results.A).toBe(50);
            expect(results.B).toBe(50);
            expect(results.totalVotes).toBe(2);
        });
        
        test('should handle extreme ratio', () => {
            const session = { votes: { A: 1, B: 999 } };
            const results = calculateResults(session);

            expect(results.A).toBe(0);
            expect(results.B).toBe(100);
            expect(results.totalVotes).toBe(1000);
        });
    });
    
    describe('Session Management', () => {
        let sessions;
        let currentSessionId;
        
        beforeEach(() => {
            sessions = new Map();
            currentSessionId = null;
        });
        
        function createSession(topic = 'Test', speakerAName = 'A', speakerBName = 'B') {
            const sessionId = 'debate_' + Date.now();
            const session = {
                id: sessionId,
                topic: topic,
                speakerAName: speakerAName,
                speakerBName: speakerBName,
                startTime: new Date(),
                votes: { A: 0, B: 0 },
                voterVotes: new Map(),
                isActive: true
            };
            sessions.set(sessionId, session);
            currentSessionId = sessionId;
            return session;
        }
        
        function getCurrentSession() {
            if (!currentSessionId) return null;
            return sessions.get(currentSessionId);
        }
        
        test('should create session with correct structure', () => {
            const session = createSession('My Topic', 'John', 'Jane');
            
            expect(session.id).toMatch(/^debate_\d+$/);
            expect(session.topic).toBe('My Topic');
            expect(session.speakerAName).toBe('John');
            expect(session.speakerBName).toBe('Jane');
            expect(session.isActive).toBe(true);
            expect(session.votes).toEqual({ A: 0, B: 0 });
            expect(session.voterVotes).toBeInstanceOf(Map);
        });
        
        test('should get current session', () => {
            const created = createSession();
            const current = getCurrentSession();
            
            expect(current).toEqual(created);
        });
        
        test('should return null when no current session', () => {
            currentSessionId = null;
            expect(getCurrentSession()).toBeNull();
        });
        
        test('should track voter votes', () => {
            const session = createSession();
            
            session.voterVotes.set('voter_1', 'A');
            session.voterVotes.set('voter_2', 'B');
            
            expect(session.voterVotes.size).toBe(2);
            expect(session.voterVotes.get('voter_1')).toBe('A');
            expect(session.voterVotes.get('voter_2')).toBe('B');
        });
        
        test('should update vote counts correctly', () => {
            const session = createSession();
            
            session.votes.A = 5;
            session.votes.B = 3;
            
            expect(session.votes.A).toBe(5);
            expect(session.votes.B).toBe(3);
        });
        
        test('should handle session end', () => {
            const session = createSession();
            session.isActive = false;
            session.endTime = new Date();
            
            expect(session.isActive).toBe(false);
            expect(session.endTime).toBeInstanceOf(Date);
        });
    });
});
