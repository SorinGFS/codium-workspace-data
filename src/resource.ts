// Translate protocol changes into native SCM resources and immutable virtual baseline identifiers.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { Visibility, WorkspaceDataChange } from './model';

export const baselineScheme = 'workspace-data-baseline';

export interface BaselineDescriptor {
    root: string;
    visibility: Visibility;
    path: string;
    revision: string;
    kind: 'baseline' | 'empty';
}

// Encode every identity component required to prevent an open baseline from silently changing.
export function createBaselineUri(descriptor: BaselineDescriptor): vscode.Uri {
    const query = new URLSearchParams({
        root: descriptor.root,
        revision: descriptor.revision,
        kind: descriptor.kind
    });
    return vscode.Uri.from({
        scheme: baselineScheme,
        authority: 'loaded',
        path: `/${descriptor.visibility}/${descriptor.path}`,
        query: query.toString()
    });
}

// Decode and validate an extension-owned baseline URI before dispatching a read.
export function parseBaselineUri(uri: vscode.Uri): BaselineDescriptor {
    if (uri.scheme !== baselineScheme || uri.authority !== 'loaded') {
        throw vscode.FileSystemError.FileNotFound(uri);
    }
    const segments = uri.path.slice(1).split('/');
    const visibility = segments.shift();
    const dataPath = segments.join('/');
    const query = new URLSearchParams(uri.query);
    const root = query.get('root');
    const revision = query.get('revision');
    const kind = query.get('kind');
    if (!['public', 'private'].includes(visibility || '') || segments.length < 2 || !root || !revision
        || !['baseline', 'empty'].includes(kind || '')) {
        throw vscode.FileSystemError.FileNotFound(uri);
    }
    return {
        root,
        visibility: visibility as Visibility,
        path: dataPath,
        revision,
        kind: kind as BaselineDescriptor['kind']
    };
}

// Represent one workspace-data change using the editor's standard SCM resource contract.
export class WorkspaceDataResourceState implements vscode.SourceControlResourceState {
    public readonly resourceUri: vscode.Uri;
    public readonly command: vscode.Command;
    public readonly contextValue: string;
    public readonly decorations: vscode.SourceControlResourceDecorations;

    // Bind protocol metadata to local, baseline, and comparison resources used by SCM and diff views.
    public constructor(
        folder: vscode.WorkspaceFolder,
        public readonly change: WorkspaceDataChange,
        public readonly baselineUri: vscode.Uri,
        public readonly comparisonUri: vscode.Uri
    ) {
        this.resourceUri = vscode.Uri.joinPath(folder.uri, ...change.workspacePath.split('/'));
        this.command = {
            command: 'workspaceData.openChange',
            title: 'Open Workspace Data Change',
            arguments: [this]
        };
        this.contextValue = change.status;
        const labels = {
            added: ['A', 'Added', 'diff-added'],
            modified: ['M', 'Modified', 'diff-modified'],
            deleted: ['D', 'Deleted', 'diff-removed']
        } as const;
        const [letter, label, icon] = labels[change.status];
        this.decorations = {
            strikeThrough: change.status === 'deleted',
            tooltip: `${label}: ${change.workspacePath}`,
            iconPath: new vscode.ThemeIcon(icon)
        };
        this.command.title = `${letter} ${path.posix.basename(change.path)}`;
    }
}
