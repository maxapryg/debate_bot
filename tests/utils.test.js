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
    });
});
