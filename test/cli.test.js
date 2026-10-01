// Verify publication pipe settlement and partial acknowledgement without executing GitHub CLI.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const test = require('node:test');
let scenario;
let spawns = 0;
const originalLoad = Module._load;
class CancellationError extends Error {}

// Supply asynchronous pipe events through the same process boundary used by the extension.
Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') {
        return { CancellationError };
    }
    if (request === 'node:child_process') {
        return { spawn: (_executable, _args, options) => {
            spawns += 1;
            assert.equal(options.shell, false);
            assert.equal(options.env.GH_PROMPT_DISABLED, '1');
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => true;
            queueMicrotask(() => scenario(child));
            return child;
        } };
    }
    return originalLoad.call(this, request, parent, isMain);
};
let WorkspaceDataCli;
try {
    WorkspaceDataCli = require('../dist/cli.js').WorkspaceDataCli;
} finally {
    Module._load = originalLoad;
}
const cli = new WorkspaceDataCli({ uri: { scheme: 'file', fsPath: '/fixture' } }, { append() {} });
const digest = `sha256:${crypto.createHash('sha256').update('checkpoint').digest('hex')}`;
const event = {
    protocolVersion: 1, type: 'published', projectIdentity: 'github.com/acme/widget',
    previousStateDigest: digest, visibility: 'public', repositoryState: {
        availability: 'available', repository: 'acme/public-data', baselineRepository: 'acme/public-data',
        defaultBranch: 'main', baseRevision: 'a'.repeat(40), baseline: [], complete: true,
        pullRequest: { number: 12, url: 'https://github.com/acme/public-data/pull/12',
            headRepository: 'acme/public-data', headBranch: 'alice-contrib/widget', baseBranch: 'main', status: 'open' }
    }
};

// Earlier publication outcomes must be persisted before a deferred merge rejects the command.
test('drains successful metadata writes on nonzero subprocess exit', async () => {
    let acknowledged = false;
    scenario = (child) => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`));
        child.stderr.emit('data', Buffer.from('merge deferred'));
        child.emit('close', 1);
    };
    await assert.rejects(cli.publish(true, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        acknowledged = true;
    }), /merge deferred/);
    assert.equal(acknowledged, true);
});

// Metadata failures settle publication progress rather than leaving an unhandled promise pending.
test('rejects publication when checkpoint persistence fails', async () => {
    scenario = (child) => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`));
        child.emit('close', 0);
    };
    await assert.rejects(cli.publish(false, async () => { throw new Error('state changed'); }), /state changed/);
});

// Cancellation before invocation must not create a new mutating subprocess.
test('does not spawn an already-cancelled operation', async () => {
    const before = spawns;
    await assert.rejects(cli.publish(false, async () => {}, { isCancellationRequested: true }), CancellationError);
    assert.equal(spawns, before);
});

// Clean no-op publication can close successfully without inventing a checkpoint.
test('settles clean publication without result records', async () => {
    scenario = (child) => child.emit('close', 0);
    await cli.publish(false, async () => assert.fail('no-op cannot acknowledge new metadata'));
});
