// Validate CLI-owned checkpoints and atomically persist publication metadata without touching data files.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Visibility } from './model';

export interface BaselineEntry {
    path: string;
    sourcePath: string;
    object: string;
    digest: string;
    size: number;
    mode: '100644' | '100755';
}

export interface RepositoryState {
    availability: 'available' | 'missing';
    repository: string;
    baselineRepository: string | null;
    baseRevision?: string;
    defaultBranch?: string;
    mergedRevision?: string;
    publishedPullRequestNumber?: number;
    baseline: BaselineEntry[];
    complete: true;
    pullRequest: Record<string, unknown> | null;
}

export interface WorkspaceState {
    version: 2;
    projectIdentity: string;
    repositories: Record<Visibility, RepositoryState>;
}

export interface PublicationEvent {
    protocolVersion: 1;
    type: 'published' | 'merged';
    projectIdentity: string;
    previousStateDigest: string;
    visibility: Visibility;
    repositoryState: RepositoryState;
}

const protectedNames = new Set([
    '.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.terraform.d',
    '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.gitconfig',
    '.git-credentials', '.netrc', '.bash_history', '.zsh_history',
    'microsoft.powershell_profile.ps1', 'desktop.ini', 'thumbs.db', '.ds_store'
]);
const revisionPattern = /^[a-f0-9]{40,64}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Reject traversal, protected objects, platform path aliases, and invalid portable data names.
export function safeSegments(value: string): string[] {
    const segments = value.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..'
        || /[\\:\0]/.test(segment) || protectedNames.has(segment.toLowerCase()))) {
        throw new Error(`Unsafe workspace-data path: ${value}`);
    }
    return segments;
}

// Narrow external JSON before accessing checkpoint fields.
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Validate complete repository metadata without deriving Git or GitHub state in the editor.
function validateRepository(value: unknown, projectIdentity: string): asserts value is RepositoryState {
    if (!record(value) || !['available', 'missing'].includes(String(value.availability))
        || value.complete !== true || !repositoryPattern.test(String(value.repository))
        || !Array.isArray(value.baseline) || !(value.pullRequest === null || record(value.pullRequest))) {
        throw new Error('Invalid workspace-data repository checkpoint.');
    }
    if (value.availability === 'available') {
        if (!revisionPattern.test(String(value.baseRevision)) || !repositoryPattern.test(String(value.baselineRepository))
            || typeof value.defaultBranch !== 'string' || !value.defaultBranch
            || (value.mergedRevision !== undefined && !revisionPattern.test(String(value.mergedRevision)))
            || (value.publishedPullRequestNumber !== undefined
                && (!Number.isSafeInteger(value.publishedPullRequestNumber) || Number(value.publishedPullRequestNumber) <= 0))) {
            throw new Error('Invalid workspace-data baseline revision.');
        }
    } else if (value.baseRevision || value.baselineRepository !== null || value.baseline.length || value.pullRequest !== null) {
        throw new Error('Unavailable workspace-data repository has a baseline.');
    }
    let previous = '';
    // Require ordered, ordinary Git files whose source paths resolve to the stated project.
    for (const entry of value.baseline) {
        if (!record(entry) || typeof entry.path !== 'string' || typeof entry.sourcePath !== 'string'
            || !revisionPattern.test(String(entry.object)) || !/^sha256:[a-f0-9]{64}$/.test(String(entry.digest))
            || !Number.isSafeInteger(entry.size) || Number(entry.size) < 0 || !['100644', '100755'].includes(String(entry.mode))) {
            throw new Error('Invalid workspace-data baseline inventory.');
        }
        const [concern, ...relative] = safeSegments(entry.path);
        if (!relative.length || entry.path <= previous || entry.sourcePath !== `${concern}/${projectIdentity}/${relative.join('/')}`) {
            throw new Error('Invalid workspace-data baseline path or ordering.');
        }
        previous = entry.path;
    }
    if (value.pullRequest) {
        const pr = value.pullRequest;
        if (!Number.isSafeInteger(pr.number) || Number(pr.number) <= 0 || typeof pr.url !== 'string'
            || !/^https:\/\/github\.com\//.test(pr.url) || !repositoryPattern.test(String(pr.headRepository))
            || typeof pr.headBranch !== 'string' || !pr.headBranch || typeof pr.baseBranch !== 'string'
            || !pr.baseBranch || !['open', 'closed'].includes(String(pr.status))) {
            throw new Error('Invalid workspace-data pull request checkpoint.');
        }
    }
}

// Read a version-two state verbatim so protocol fingerprints include every existing field.
export function parseWorkspaceState(raw: string): WorkspaceState {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 2 || typeof value.projectIdentity !== 'string'
        || safeSegments(value.projectIdentity).length < 3 || !record(value.repositories)) {
        throw new Error('Workspace Data requires version-two state; run an explicit Load.');
    }
    validateRepository(value.repositories.public, value.projectIdentity);
    validateRepository(value.repositories.private, value.projectIdentity);
    return value as unknown as WorkspaceState;
}

// Validate one authoritative JSON Lines acknowledgement before any persistent effect.
export function parsePublicationEvent(raw: string): PublicationEvent {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.protocolVersion !== 1 || !['published', 'merged'].includes(String(value.type))
        || typeof value.projectIdentity !== 'string' || safeSegments(value.projectIdentity).length < 3
        || !['public', 'private'].includes(String(value.visibility))
        || !/^sha256:[a-f0-9]{64}$/.test(String(value.previousStateDigest))) {
        throw new Error('Invalid workspace-data publication result.');
    }
    validateRepository(value.repositoryState, value.projectIdentity);
    if (value.repositoryState.availability !== 'available'
        || (value.type === 'published' && !value.repositoryState.pullRequest)
        || (value.type === 'merged' && (value.repositoryState.pullRequest || !value.repositoryState.mergedRevision))) {
        throw new Error('Contradictory workspace-data publication result.');
    }
    return value as unknown as PublicationEvent;
}

// Fingerprint parsed state identically to the CLI's ordered acknowledgement chain.
export function stateDigest(state: WorkspaceState): string {
    return `sha256:${crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex')}`;
}

export class WorkspaceStateStore {
    public readonly namespaceRoot: string;
    public readonly statePath: string;

    // Bind metadata access to the selected workspace namespace.
    public constructor(root: string) {
        this.namespaceRoot = path.join(root, '#');
        this.statePath = path.join(this.namespaceRoot, '.data-state.json');
    }

    // Refuse namespace redirects and state links before reading or replacing local metadata.
    public async read(): Promise<string> {
        const namespace = await fs.lstat(this.namespaceRoot);
        if (!namespace.isDirectory() || namespace.isSymbolicLink()) {
            throw new Error('Workspace Data namespace must be an ordinary directory.');
        }
        const state = await fs.lstat(this.statePath);
        if (!state.isFile() || state.isSymbolicLink()) {
            throw new Error('Workspace Data state must be an ordinary file.');
        }
        return fs.readFile(this.statePath, 'utf8');
    }

    // Preserve other visibilities and reject checkpoints invalidated by an external Load or edit.
    public async apply(event: PublicationEvent): Promise<WorkspaceState> {
        const namespace = await fs.lstat(this.namespaceRoot);
        if (!namespace.isDirectory() || namespace.isSymbolicLink()) {
            throw new Error('Workspace Data namespace must be an ordinary directory.');
        }
        const lockPath = path.join(this.namespaceRoot, '.data-state.lock');
        let lock;
        try {
            lock = await fs.open(lockPath, 'wx');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                throw new Error('Workspace Data state is locked; remote changes may already exist.');
            }
            throw error;
        }
        try {
            return await this.commit(event);
        } finally {
            await lock.close();
            await fs.rm(lockPath);
        }
    }

    // Compare-and-replace under the shared lock; explicit CLI Load cannot race this commit.
    private async commit(event: PublicationEvent): Promise<WorkspaceState> {
        const original = await this.read();
        const state = parseWorkspaceState(original);
        if (state.projectIdentity !== event.projectIdentity || stateDigest(state) !== event.previousStateDigest
            || state.repositories[event.visibility].repository !== event.repositoryState.repository) {
            throw new Error('Workspace Data state changed during publication; metadata was not overwritten. Remote changes may already exist.');
        }
        state.repositories[event.visibility] = event.repositoryState;
        const temporary = path.join(this.namespaceRoot, `.data-state-${crypto.randomUUID()}.tmp`);
        try {
            await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
            if (await this.read() !== original) {
                throw new Error('Workspace Data state changed before metadata replacement; review the remote result.');
            }
            await fs.rename(temporary, this.statePath);
            return state;
        } finally {
            await fs.rm(temporary, { force: true });
        }
    }
}
