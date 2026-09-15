// Verify protocol parsing independently of the editor host.
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    loadNeedsConfirmation,
    loadOverwritePrompt,
    parseStatusReport
} = require('../dist/model.js');

// Accept a complete protocol-version-one report.
test('parses a ready status report', () => {
    const report = parseStatusReport(JSON.stringify({
        protocolVersion: 1,
        projectIdentity: 'github.com/acme/widget',
        state: 'ready',
        repositories: {
            public: { availability: 'available', baselineRevision: 'a'.repeat(40), pullRequest: null },
            private: { availability: 'missing', baselineRevision: null, pullRequest: null }
        },
        changes: [{
            id: 'public:tests/a.txt',
            visibility: 'public',
            status: 'modified',
            path: 'tests/a.txt',
            workspacePath: '#/public/tests/a.txt',
            baseline: { available: true, size: 4 }
        }]
    }));

    assert.equal(report.state, 'ready');
    assert.equal(report.changes[0].path, 'tests/a.txt');
});

// Confirm destructive loading for saved status changes or unsaved editor changes only.
test('classifies load confirmation requirements', () => {
    assert.equal(loadNeedsConfirmation({ state: 'ready', changes: [{}] }, false), true);
    assert.equal(loadNeedsConfirmation({ state: 'ready', changes: [] }, true), true);
    assert.equal(loadNeedsConfirmation({ state: 'ready', changes: [] }, false), false);
    assert.equal(loadOverwritePrompt,
        'You have unpublished changes, are you sure you want to overwrite the existing workspace data?');
});

// Reject protocol versions the extension does not implement.
test('rejects an unsupported protocol version', () => {
    assert.throws(() => parseStatusReport(JSON.stringify({ protocolVersion: 2 })), /protocol version/);
});

// Reject contradictory added-file baseline metadata.
test('rejects an added change with a baseline', () => {
    assert.throws(() => parseStatusReport(JSON.stringify({
        protocolVersion: 1,
        projectIdentity: 'github.com/acme/widget',
        state: 'ready',
        repositories: {
            public: { availability: 'available', baselineRevision: 'a'.repeat(40), pullRequest: null },
            private: { availability: 'missing', baselineRevision: null, pullRequest: null }
        },
        changes: [{
            id: 'public:tests/a.txt',
            visibility: 'public',
            status: 'added',
            path: 'tests/a.txt',
            workspacePath: '#/public/tests/a.txt',
            baseline: { available: true, size: 4 }
        }]
    })), /change entry/);
});
