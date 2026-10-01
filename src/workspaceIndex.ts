// Maintain a derived local SCM index; only invalidated files are rehashed between full reconciliations.

import * as crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StatusReport, Visibility, WorkspaceDataChange } from './model';
import { BaselineEntry, parseWorkspaceState, PublicationEvent, safeSegments, stateDigest, WorkspaceState, WorkspaceStateStore } from './state';

interface LocalFile {
    digest: string;
    size: number;
    mode: string;
}

export class WorkspaceDataIndex {
    public readonly store: WorkspaceStateStore;
    private state: WorkspaceState | undefined;
    private projectIdentity: string | undefined;
    private readonly files = new Map<string, LocalFile>();
    private readonly baselines = new Map<string, BaselineEntry>();
    private readonly changes = new Map<string, WorkspaceDataChange>();
    private readonly invalidated = new Set<string>();
    private needsFullScan = true;
    private stateInvalidated = true;
    private stateSignature: string | undefined;
    private readonly publishedStates = new Set<string>();
    public hashedFiles = 0;

    // Derive all local paths from the current workspace, never from remote metadata.
    public constructor(root: string) {
        this.store = new WorkspaceStateStore(root);
    }

    // Bind local state to the authoritative identity verified through the CLI, not guessed by the editor.
    public bindIdentity(projectIdentity: string): void {
        this.projectIdentity = projectIdentity;
    }

    // Retain data events during operations while ignoring infrastructure and metadata-write staging.
    public invalidate(workspacePath: string): boolean {
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
    public observePublication(event: PublicationEvent): void {
        if (this.projectIdentity && event.projectIdentity !== this.projectIdentity) {
            throw new Error('Publication notification belongs to another project.');
        }
        this.publishedStates.add(event.stateDigest);
        this.stateInvalidated = true;
    }

    // Advance derived baselines from the durable checkpoint without rereading unchanged payloads.
    private acceptState(state: WorkspaceState): void {
        this.state = state;
        this.stateInvalidated = false;
        this.baselines.clear();
        // Rebuild the inexpensive path index; content digests remain cached across revision-only changes.
        for (const visibility of ['public', 'private'] as const) {
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
    public async refresh(full = false): Promise<StatusReport> {
        let signature: string;
        try {
            signature = await this.store.signature();
            // Never inspect a replacement or publish a mixed snapshot while a CLI operation holds the lock.
            if (await this.store.busy()) {
                throw new Error('Workspace Data synchronization is running; retry after it completes.');
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
                const state = parseWorkspaceState(raw);
                const fingerprint = stateDigest(state);
                if ((!this.state || signature !== this.stateSignature || stateDigest(this.state) !== fingerprint)
                    && !this.publishedStates.has(fingerprint)) {
                    this.needsFullScan = true;
                }
                this.acceptState(state);
                this.stateSignature = signature;
                this.publishedStates.clear();
            } catch (error) {
                this.clearState();
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
                for (const visibility of ['public', 'private'] as const) {
                    await this.scan(visibility);
                }
                this.changes.clear();
                for (const key of new Set([...this.files.keys(), ...this.baselines.keys()])) {
                    this.classify(key);
                }
            } else {
                // Remove old subtree entries first so directory deletion and rename stay explicit.
                for (const key of invalidated) {
                    safeSegments(key);
                    const affected = this.files.has(key) || this.baselines.has(key) ? new Set([key])
                        : new Set([...this.files.keys(), ...this.baselines.keys()].filter(
                            (candidate) => candidate === key || candidate.startsWith(`${key}/`)
                        ));
                    for (const candidate of affected) {
                        this.files.delete(candidate);
                    }
                    await this.scan(key);
                    for (const candidate of affected) {
                        this.classify(candidate);
                    }
                }
            }
        } catch (error) {
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
    private clearState(): void {
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
    private async scan(key: string): Promise<void> {
        const segments = safeSegments(key);
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
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
        for await (const chunk of createReadStream(target)) {
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
    private classify(key: string): void {
        const separator = key.indexOf('/');
        if (separator < 0) {
            return;
        }
        const visibility = key.slice(0, separator) as Visibility;
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
    public snapshot(): StatusReport {
        const state = this.state!;
        return {
            protocolVersion: 1,
            projectIdentity: state.projectIdentity,
            state: 'ready',
            repositories: Object.fromEntries((['public', 'private'] as const).map((visibility) => [visibility, {
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
    private emptyReport(state: 'notInitialized' | 'reloadRequired', projectIdentity: string): StatusReport {
        return { protocolVersion: 1, state, projectIdentity, repositories: {}, changes: [] };
    }
}
