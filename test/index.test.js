// Verify incremental SCM hashing and metadata-only persistence using ordinary isolated workspace files.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WorkspaceDataIndex } = require('../dist/workspaceIndex.js');
const { parsePublicationEvent, parseWorkspaceState, stateDigest, WorkspaceStateStore } = require('../dist/state.js');
const { PublicationResultStream } = require('../dist/publicationStream.js');
// Match the content integrity digest used by CLI-owned baseline inventories.
const digest = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

// Generate exact baseline metadata without involving a real repository or network client.
function entry(name, bytes) {
    return { path: `tests/${name}`, sourcePath: `tests/github.com/acme/widget/${name}`,
        object: 'b'.repeat(40), digest: digest(bytes), size: Buffer.byteLength(bytes), mode: '100644' };
}

// Establish one complete acknowledged snapshot with an unavailable private visibility.
async function fixture(context, files = { 'a.txt': 'old\n' }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-data-index-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, '#/public/tests'), { recursive: true });
    const state = { version: 2, projectIdentity: 'github.com/acme/widget', repositories: {
        public: { availability: 'available', repository: 'acme/public-data', baselineRepository: 'acme/public-data',
            defaultBranch: 'main', baseRevision: 'a'.repeat(40), baseline: [], complete: true, pullRequest: null },
        private: { availability: 'missing', repository: 'alice/private-data', baselineRepository: null,
            baseline: [], complete: true, pullRequest: null }
    } };
    // Keep fixture ordering identical to the checkpoint's portable path ordering.
    for (const [name, bytes] of Object.entries(files).sort(([left], [right]) => left < right ? -1 : 1)) {
        await fs.writeFile(path.join(root, '#/public/tests', name), bytes);
        state.repositories.public.baseline.push(entry(name, bytes));
    }
    const store = new WorkspaceStateStore(root);
    await fs.writeFile(store.statePath, JSON.stringify(state));
    return { root, state, store, index: new WorkspaceDataIndex(root) };
}

// Reproduce authoritative publication metadata while preserving the original checkpoint fingerprint.
function published(state, baseline) {
    return {
        protocolVersion: 1, type: 'published', projectIdentity: state.projectIdentity,
        previousStateDigest: stateDigest(state), visibility: 'public',
        repositoryState: { ...state.repositories.public, baseRevision: 'c'.repeat(40), baseline,
            pullRequest: { number: 12, url: 'https://github.com/acme/public-data/pull/12',
                headRepository: 'acme/public-data', headBranch: 'alice-contrib/widget', baseBranch: 'main', status: 'open' } }
    };
}

// Repository size must not cause unchanged payloads to be reread after a single known-file save.
test('large local snapshots rehash only the invalidated file', async (context) => {
    const files = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`${String(index).padStart(4, '0')}.json`, 'x'.repeat(4096)]));
    const { root, index } = await fixture(context, files);
    assert.equal((await index.refresh()).changes.length, 0);
    assert.equal(index.hashedFiles, 1000);
    await fs.writeFile(path.join(root, '#/public/tests/0500.json'), 'edited');
    index.invalidate('#/public/tests/0500.json');
    const report = await index.refresh();
    assert.equal(index.hashedFiles, 1001);
    assert.deepEqual(report.changes.map((change) => [change.path, change.status]), [['tests/0500.json', 'modified']]);
    await index.refresh();
    assert.equal(index.hashedFiles, 1001);
});

// Handle additions, whole-directory deletions, and recreation without losing deletion semantics.
test('tracks added files and deleted/recreated subtrees', async (context) => {
    const { root, index } = await fixture(context);
    await index.refresh();
    await fs.writeFile(path.join(root, '#/public/tests/new.txt'), 'new\n');
    index.invalidate('#/public/tests/new.txt');
    assert.equal((await index.refresh()).changes[0].status, 'added');
    await fs.rm(path.join(root, '#/public/tests'), { recursive: true });
    index.invalidate('#/public/tests');
    assert.deepEqual((await index.refresh()).changes.map((change) => [change.path, change.status]), [['tests/a.txt', 'deleted']]);
    await fs.mkdir(path.join(root, '#/public/tests'));
    await fs.writeFile(path.join(root, '#/public/tests/a.txt'), 'old\n');
    index.invalidate('#/public/tests');
    assert.equal((await index.refresh()).changes.length, 0);
});

// Acknowledging publication never writes a data file or rehashes unchanged payloads after a merge.
test('persists published and merged metadata without loading or rereading files', async (context) => {
    const { root, state, store, index } = await fixture(context);
    await index.refresh();
    const dataPath = path.join(root, '#/public/tests/a.txt');
    const before = await fs.stat(dataPath);
    const event = parsePublicationEvent(JSON.stringify(published(state, state.repositories.public.baseline)));
    const next = await store.apply(event);
    index.acceptState(next);
    const merged = { ...event, type: 'merged', previousStateDigest: stateDigest(next), repositoryState: {
        ...next.repositories.public, baseRevision: 'd'.repeat(40), mergedRevision: 'd'.repeat(40), pullRequest: null
    } };
    index.acceptState(await store.apply(parsePublicationEvent(JSON.stringify(merged))));
    index.invalidate('#/.data-state.json');
    assert.equal((await index.refresh()).changes.length, 0);
    assert.equal(index.hashedFiles, 1);
    assert.equal((await fs.stat(dataPath)).mtimeMs, before.mtimeMs);
    assert.deepEqual((await fs.readdir(path.join(root, '#'))).sort(), ['.data-state.json', 'public']);
    assert.deepEqual(JSON.parse(await store.read()).repositories.private, state.repositories.private);
});

// Files edited after capture stay modified when the acknowledged snapshot advances.
test('preserves edits made during publication instead of blindly clearing SCM', async (context) => {
    const { root, state, store, index } = await fixture(context);
    await index.refresh();
    const event = published(state, [entry('a.txt', 'published\n')]);
    await fs.writeFile(path.join(root, '#/public/tests/a.txt'), 'newer editor save\n');
    index.invalidate('#/public/tests/a.txt');
    index.acceptState(await store.apply(parsePublicationEvent(JSON.stringify(event))));
    const report = await index.refresh();
    assert.equal(report.changes[0].status, 'modified');
    assert.equal(await fs.readFile(path.join(root, '#/public/tests/a.txt'), 'utf8'), 'newer editor save\n');
});

// External replacement invalidates the fingerprint before any write is permitted.
test('rejects stale and replayed acknowledgements without overwriting state', async (context) => {
    const { state, store } = await fixture(context);
    const event = published(state, state.repositories.public.baseline);
    await store.apply(event);
    const current = await store.read();
    await assert.rejects(store.apply(event), /state changed during publication/);
    assert.equal(await store.read(), current);
    assert.equal((await fs.readdir(store.namespaceRoot)).some((name) => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});

// Serialize with the CLI's explicit Load lock rather than racing a metadata replacement.
test('refuses metadata writes while explicit Load holds the shared lock', async (context) => {
    const { state, store } = await fixture(context);
    await fs.writeFile(path.join(store.namespaceRoot, '.data-state.lock'), '');
    const original = await store.read();
    await assert.rejects(store.apply(published(state, state.repositories.public.baseline)), /locked/);
    assert.equal(await store.read(), original);
});

// A valid-looking checkpoint from another project cannot become this repository's inspection baseline.
test('binds local state to the CLI-verified canonical identity', async (context) => {
    const { index } = await fixture(context);
    index.bindIdentity('github.com/other/project');
    await assert.rejects(index.refresh(), /does not match this canonical project/);
});

// An explicit reconciliation catches a modification even when no watcher event was received.
test('full refresh repairs missed watcher events', async (context) => {
    const { root, index } = await fixture(context);
    await index.refresh();
    await fs.writeFile(path.join(root, '#/public/tests/a.txt'), 'new\n');
    assert.equal((await index.refresh()).changes.length, 0);
    assert.equal((await index.refresh(true)).changes[0].status, 'modified');
});

// Infrastructure writes must not launch scans; unsafe baseline paths are rejected before resource access.
test('ignores staging events and validates checkpoint path safety', async (context) => {
    const { state, index } = await fixture(context);
    assert.equal(index.invalidate('#/.incoming-example/public/tests/file.txt'), false);
    assert.equal(index.invalidate('#/.data-state-example.tmp'), false);
    const unsafe = structuredClone(state);
    unsafe.repositories.public.baseline[0].path = 'tests/../../escape';
    assert.throws(() => parseWorkspaceState(JSON.stringify(unsafe)), /Unsafe/);
    unsafe.repositories.public.baseline[0].path = 'tests/.git/config';
    assert.throws(() => parseWorkspaceState(JSON.stringify(unsafe)), /Unsafe/);
});

// Arbitrary pipe boundaries, including Unicode, must preserve exact ordered checkpoint delivery.
test('drains ordered publication results before reporting a truncated final record', async (context) => {
    const { state } = await fixture(context);
    const event = published(state, [entry('é.txt', 'published\n')]);
    const received = [];
    const stream = new PublicationResultStream(async (value) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        received.push(value);
    });
    const bytes = Buffer.from(`${JSON.stringify(event)}\n{`);
    // Deliver one byte at a time to exercise split UTF-8 sequences and JSON records.
    for (const byte of bytes) {
        stream.push(Buffer.from([byte]));
    }
    await assert.rejects(stream.finish(), /Incomplete/);
    assert.equal(received.length, 1);
    assert.equal(received[0].repositoryState.baseline[0].path, 'tests/é.txt');
});

// Invalid protocol data can never be followed by dependent writes that assume it was acknowledged.
test('stops acknowledgement delivery after a malformed or rejected result', async (context) => {
    const { state } = await fixture(context);
    let writes = 0;
    const stream = new PublicationResultStream(async () => { writes += 1; });
    stream.push(Buffer.from(`{}\n${JSON.stringify(published(state, []))}\n`));
    await assert.rejects(stream.finish(), /Invalid/);
    assert.equal(writes, 0);
});
