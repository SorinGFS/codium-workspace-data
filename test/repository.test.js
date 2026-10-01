// Verify refresh serialization and operation cleanup without launching an editor or any subprocess.
'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const originalLoad = Module._load;
const messages = [];
const vscode = {
    ProgressLocation: { Notification: 1, SourceControl: 2 },
    CancellationError: class CancellationError extends Error {},
    window: {
        withProgress: async (_options, operation) => operation({ report() {} }, {}),
        showInformationMessage: () => {},
        showErrorMessage: (message) => messages.push(message)
    }
};
// Bind the runtime modules to only the editor contracts used by these isolated tests.
Module._load = function load(request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
let WorkspaceDataRepository;
let OperationManager;
try {
    WorkspaceDataRepository = require('../dist/repository.js').WorkspaceDataRepository;
    OperationManager = require('../dist/operationManager.js').OperationManager;
} finally {
    Module._load = originalLoad;
}
const report = { protocolVersion: 1, projectIdentity: 'github.com/acme/widget', state: 'ready', repositories: {}, changes: [] };

// Construct a provider with controlled asynchronous status work and no watcher subscriptions.
function repository(refresh) {
    const value = Object.create(WorkspaceDataRepository.prototype);
    Object.assign(value, {
        folder: { name: 'fixture' }, report, index: { refresh, bindIdentity() {} }, refreshPending: false,
        cli: { identity: async () => 'github.com/acme/widget' }, identityVerified: true,
        fullRefreshPending: false, suspended: false, disposed: false, changesByPath: new Map(),
        publicGroup: {}, privateGroup: {}, sourceControl: {}, decorationEmitter: { fire() {} },
        output: { appendLine() {} }
    });
    return value;
}

// Burst refreshes must coalesce into at most one follow-up scan, never parallel workers.
test('coalesces concurrent refreshes into one single-flight worker', async () => {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    let active = 0;
    let maximum = 0;
    const flags = [];
    const value = repository(async (full) => {
        calls += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        flags.push(full);
        if (calls === 1) {
            await blocked;
        }
        active -= 1;
        return report;
    });
    const first = value.refresh(false);
    const second = value.refresh(false);
    const third = value.refresh(true);
    assert.equal(first, second);
    release();
    await Promise.all([first, second, third]);
    assert.equal(calls, 2);
    assert.equal(maximum, 1);
    assert.deepEqual(flags, [false, true]);
});

// Mutations retain pending invalidations without launching work until the operation is finished.
test('suspends automatic refreshes and reconciles once on completion', async () => {
    let calls = 0;
    const value = repository(async () => { calls += 1; return report; });
    await value.suspendRefresh();
    await value.refresh(false);
    await value.refresh(false);
    assert.equal(calls, 0);
    await value.resumeRefresh(false);
    assert.equal(calls, 1);
});

// A rejected scan must release its worker slot so manual recovery can succeed.
test('recovers after a failed refresh', async () => {
    let calls = 0;
    const value = repository(async () => {
        if (++calls === 1) {
            throw new Error('scan failed');
        }
        return report;
    });
    await assert.rejects(value.refresh(false), /scan failed/);
    assert.equal(value.refreshWork, undefined);
    assert.equal((await value.refresh(true)).state, 'ready');
});

// Native progress and the per-workspace lock must terminate after failed metadata persistence.
test('releases the operation lock and progress after publication failure', async () => {
    const output = { appendLine() {}, show() {} };
    const operations = new OperationManager(output);
    const folder = { name: 'fixture', uri: { toString: () => 'file:///fixture', fsPath: '/fixture' } };
    const failed = await operations.run(folder, 'Publish', ['publish'], vscode.ProgressLocation.SourceControl,
        async () => { throw new Error('metadata persistence failed'); });
    assert.equal(failed, false);
    assert.equal(operations.activeRoots.size, 0);
    assert.match(messages.at(-1), /metadata persistence failed/);
    assert.equal(await operations.run(folder, 'Publish', ['publish'], vscode.ProgressLocation.SourceControl, async () => {}), true);
});
