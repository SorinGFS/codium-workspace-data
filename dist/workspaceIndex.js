"use strict";
// Maintain a derived local SCM index; only invalidated files are rehashed between full reconciliations.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceDataIndex = void 0;
const crypto = __importStar(require("node:crypto"));
const node_fs_1 = require("node:fs");
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const state_1 = require("./state");
class WorkspaceDataIndex {
    store;
    state;
    projectIdentity;
    files = new Map();
    baselines = new Map();
    changes = new Map();
    invalidated = new Set();
    needsFullScan = true;
    stateInvalidated = true;
    stateSignature;
    publishedStates = new Set();
    hashedFiles = 0;
    // Derive all local paths from the current workspace, never from remote metadata.
    constructor(root) {
        this.store = new state_1.WorkspaceStateStore(root);
    }
    // Bind local state to the authoritative identity verified through the CLI, not guessed by the editor.
    bindIdentity(projectIdentity) {
        this.projectIdentity = projectIdentity;
    }
    // Retain data events during operations while ignoring infrastructure and metadata-write staging.
    invalidate(workspacePath) {
        const relative = workspacePath.split(path.sep).join('/');
        if (relative === '#/.data-state.json' || relative === '#/.data-state.lock' || relative === '#') {
            this.stateInvalidated = true;
            if (relative === '#') {
                this.needsFullScan = true;
            }
            return true;
        }
        if (/^#\/(public|private)(\/|$)/.test(relative)) {
            this.invalidated.add(relative.slice(2));
            return true;
        }
        return false;
    }
    // Recognize this editor's persisted publication epochs without treating pipe metadata as authority.
    observePublication(event) {
        if (this.projectIdentity && event.projectIdentity !== this.projectIdentity) {
            throw new Error('Publication notification belongs to another project.');
        }
        this.publishedStates.add(event.stateDigest);
        this.stateInvalidated = true;
    }
    // Advance derived baselines from the durable checkpoint without rereading unchanged payloads.
    acceptState(state) {
        this.state = state;
        this.stateInvalidated = false;
        this.baselines.clear();
        // Rebuild the inexpensive path index; content digests remain cached across revision-only changes.
        for (const visibility of ['public', 'private']) {
            for (const entry of state.repositories[visibility].baseline) {
                this.baselines.set(`${visibility}/${entry.path}`, entry);
            }
        }
        this.changes.clear();
        // Reclassify metadata changes from known file digests, including acknowledged additions/deletions.
        for (const key of new Set([...this.files.keys(), ...this.baselines.keys()])) {
            this.classify(key);
        }
    }
    // Reconcile startup/manual refreshes completely; ordinary events inspect only their affected subtrees.
    async refresh(full = false) {
        let signature;
        try {
            signature = await this.store.signature();
            // Never inspect a replacement or publish a mixed snapshot while a CLI operation holds the lock.
            if (await this.store.busy()) {
                throw new Error('Workspace Data synchronization is running; retry after it completes.');
            }
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                this.clearState();
                return this.emptyReport('notInitialized', this.projectIdentity || '');
            }
            // Invalid or busy metadata cannot leave an old cache eligible for later incremental use.
            this.clearState();
            throw error;
        }
        if (full || this.stateInvalidated || !this.state || signature !== this.stateSignature) {
            try {
                const raw = await this.store.read();
                const parsed = JSON.parse(raw);
                if (this.projectIdentity && parsed.projectIdentity !== this.projectIdentity) {
                    throw new Error('Workspace Data state does not match this canonical project.');
                }
                const version = parsed.version;
                if (version === 1) {
                    this.clearState();
                    return this.emptyReport('reloadRequired', parsed.projectIdentity);
                }
                const state = (0, state_1.parseWorkspaceState)(raw);
                const fingerprint = (0, state_1.stateDigest)(state);
                if ((!this.state || signature !== this.stateSignature || (0, state_1.stateDigest)(this.state) !== fingerprint)
                    && !this.publishedStates.has(fingerprint)) {
                    this.needsFullScan = true;
                }
                this.acceptState(state);
                this.stateSignature = signature;
                this.publishedStates.clear();
            }
            catch (error) {
                this.clearState();
                if (error.code === 'ENOENT') {
                    return this.emptyReport('notInitialized', this.projectIdentity || '');
                }
                throw error;
            }
        }
        const invalidated = [...this.invalidated];
        this.invalidated.clear();
        try {
            if (full || this.needsFullScan) {
                this.needsFullScan = false;
                this.files.clear();
                const names = await fs.readdir(this.store.namespaceRoot);
                if (names.some((name) => !['public', 'private', '.data-state.json', 'version-layers.js'].includes(name))) {
                    throw new Error('Unrecognized or busy generated workspace-data namespace content.');
                }
                if (names.includes('version-layers.js')) {
                    const support = await fs.lstat(path.join(this.store.namespaceRoot, 'version-layers.js'));
                    if (!support.isFile() || support.isSymbolicLink()) {
                        throw new Error('Workspace Data runtime support must be an ordinary file.');
                    }
                }
                // Full reconciliation catches missed events, deletions, and metadata-preserving edits.
                for (const visibility of ['public', 'private']) {
                    await this.scan(visibility);
                }
                this.changes.clear();
                for (const key of new Set([...this.files.keys(), ...this.baselines.keys()])) {
                    this.classify(key);
                }
            }
            else {
                // Remove old subtree entries first so directory deletion and rename stay explicit.
                for (const key of invalidated) {
                    (0, state_1.safeSegments)(key);
                    const affected = this.files.has(key) || this.baselines.has(key) ? new Set([key])
                        : new Set([...this.files.keys(), ...this.baselines.keys()].filter((candidate) => candidate === key || candidate.startsWith(`${key}/`)));
                    for (const candidate of affected) {
                        this.files.delete(candidate);
                    }
                    await this.scan(key);
                    for (const candidate of affected) {
                        this.classify(candidate);
                    }
                }
            }
        }
        catch (error) {
            this.needsFullScan = true;
            throw error;
        }
        // Reject scans straddling an external state replacement or newly started operation.
        if (await this.store.signature() !== signature
            || await this.store.busy()) {
            this.clearState();
            throw new Error('Workspace Data changed during reconciliation; retry after synchronization completes.');
        }
        return this.snapshot();
    }
    // Discard every derived baseline when durable initialization becomes unavailable or invalid.
    clearState() {
        this.state = undefined;
        this.stateSignature = undefined;
        this.stateInvalidated = true;
        this.needsFullScan = true;
        this.files.clear();
        this.baselines.clear();
        this.changes.clear();
        this.invalidated.clear();
        this.publishedStates.clear();
    }
    // Validate each existing ancestor so a watcher event cannot redirect reads through a directory link.
    async scan(key) {
        const segments = (0, state_1.safeSegments)(key);
        const namespace = await fs.lstat(this.store.namespaceRoot);
        if (!namespace.isDirectory() || namespace.isSymbolicLink()) {
            throw new Error('Workspace Data namespace must be an ordinary directory.');
        }
        let target = this.store.namespaceRoot;
        let stat;
        // Inspect only ordinary data components; absence represents a deletion rather than a read failure.
        for (const segment of segments) {
            target = path.join(target, segment);
            try {
                stat = await fs.lstat(target);
            }
            catch (error) {
                if (error.code === 'ENOENT') {
                    return;
                }
                throw error;
            }
            if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
                throw new Error(`Workspace data contains a link or unsupported object: ${key}`);
            }
        }
        if (!stat) {
            return;
        }
        if (stat.isDirectory()) {
            const names = await fs.readdir(target);
            // Expand only the invalidated directory, not the complete visibility on every file save.
            for (const name of names) {
                await this.scan(`${key}/${name}`);
            }
            return;
        }
        if (segments.length < 3) {
            throw new Error('Workspace data files must be beneath a concern directory.');
        }
        const before = stat;
        const digest = crypto.createHash('sha256');
        // Stream file hashing so large fixtures never require a complete in-memory payload.
        for await (const chunk of (0, node_fs_1.createReadStream)(target)) {
            digest.update(chunk);
        }
        const after = await fs.lstat(target);
        if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size
            || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) {
            throw new Error(`Workspace data changed while being inspected: ${key}`);
        }
        this.hashedFiles += 1;
        this.files.set(key, {
            digest: `sha256:${digest.digest('hex')}`,
            size: after.size,
            mode: process.platform === 'win32' ? this.baselines.get(key)?.mode || '100644'
                : (after.mode & 0o111) !== 0 ? '100755' : '100644'
        });
        this.classify(key);
    }
    // Compare cached content with the acknowledged snapshot; remote revision changes do not imply file changes.
    classify(key) {
        const separator = key.indexOf('/');
        if (separator < 0) {
            return;
        }
        const visibility = key.slice(0, separator);
        const dataPath = key.slice(separator + 1);
        const baseline = this.baselines.get(key);
        const local = this.files.get(key);
        const status = !local ? baseline ? 'deleted' : undefined : !baseline ? 'added'
            : local.digest !== baseline.digest || local.size !== baseline.size || local.mode !== baseline.mode ? 'modified' : undefined;
        if (!status) {
            this.changes.delete(key);
            return;
        }
        this.changes.set(key, {
            id: `${visibility}:${dataPath}`,
            visibility,
            status,
            path: dataPath,
            workspacePath: `#/${key}`,
            baseline: baseline ? { available: true, size: baseline.size } : { available: false }
        });
    }
    // Preserve the existing SCM status shape while reading no remote data.
    snapshot() {
        const state = this.state;
        return {
            protocolVersion: 1,
            projectIdentity: state.projectIdentity,
            state: 'ready',
            repositories: Object.fromEntries(['public', 'private'].map((visibility) => [visibility, {
                    availability: state.repositories[visibility].availability,
                    baselineRevision: state.repositories[visibility].baseRevision || null,
                    pullRequest: state.repositories[visibility].pullRequest
                }])),
            changes: [...this.changes.values()].sort((left, right) => {
                if (left.visibility !== right.visibility) {
                    return left.visibility === 'public' ? -1 : 1;
                }
                return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
            })
        };
    }
    // Report legacy/missing initialization without fabricating an inspection baseline.
    emptyReport(state, projectIdentity) {
        return { protocolVersion: 1, state, projectIdentity, repositories: {}, changes: [] };
    }
}
exports.WorkspaceDataIndex = WorkspaceDataIndex;
//# sourceMappingURL=workspaceIndex.js.map