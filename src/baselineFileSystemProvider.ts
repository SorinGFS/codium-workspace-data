// Expose exact loaded baselines as immutable files while caching revision-bearing URI results.

import * as vscode from 'vscode';
import { parseBaselineUri } from './resource';

export interface BaselineReader {
    readBaseline(visibility: 'public' | 'private', dataPath: string, revision: string): Promise<Uint8Array>;
}

export class BaselineFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
    private readonly readers = new Map<string, BaselineReader>();
    private readonly cache = new Map<string, Promise<Uint8Array>>();
    private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    public readonly onDidChangeFile = this.changeEmitter.event;

    // Associate virtual URI roots with the workspace repository that owns baseline access.
    public register(root: string, reader: BaselineReader): vscode.Disposable {
        this.readers.set(root, reader);
        return new vscode.Disposable(() => {
            if (this.readers.get(root) === reader) {
                this.readers.delete(root);
            }
        });
    }

    // Resolve file metadata from the same immutable byte cache used for reads.
    public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const bytes = await this.readFile(uri);
        return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: bytes.byteLength };
    }

    // Read and cache one exact baseline, rejecting stale uncached descriptors instead of changing content.
    public readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const key = uri.toString();
        const existing = this.cache.get(key);
        if (existing) {
            return existing;
        }
        const descriptor = parseBaselineUri(uri);
        const read = descriptor.kind === 'empty'
            ? Promise.resolve(new Uint8Array())
            : this.readers.get(descriptor.root)?.readBaseline(
                descriptor.visibility,
                descriptor.path,
                descriptor.revision
            ) ?? Promise.reject(vscode.FileSystemError.Unavailable('The workspace-data source is no longer open.'));
        const retained = read.catch((error: unknown) => {
            this.cache.delete(key);
            throw error instanceof vscode.FileSystemError
                ? error
                : vscode.FileSystemError.Unavailable(error instanceof Error ? error.message : String(error));
        });
        this.cache.set(key, retained);
        return retained;
    }

    // Baselines are individual immutable files rather than browsable virtual directories.
    public readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
        throw vscode.FileSystemError.FileNotADirectory(uri);
    }

    // Reject every mutation through the read-only provider contract.
    public writeFile(uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    // Reject directory creation because baseline namespace structure comes only from protocol state.
    public createDirectory(uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    // Reject deletion because virtual baseline lifetimes are cache-managed.
    public delete(uri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions(uri);
    }

    // Reject renames because revision-bearing identifiers are immutable.
    public rename(oldUri: vscode.Uri): void {
        throw vscode.FileSystemError.NoPermissions(oldUri);
    }

    // Baseline identifiers never emit changes; refreshed baselines receive new URIs.
    public watch(): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    // Release extension-host event resources when the provider deactivates.
    public dispose(): void {
        this.changeEmitter.dispose();
        this.readers.clear();
        this.cache.clear();
    }
}
