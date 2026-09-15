// Maintain one workspace folder's SCM groups, quick diff mapping, and baseline protocol access.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { BaselineFileSystemProvider, BaselineReader } from './baselineFileSystemProvider';
import { WorkspaceDataCli } from './cli';
import { StatusReport, Visibility, WorkspaceDataChange } from './model';
import { createBaselineUri, WorkspaceDataResourceState } from './resource';

export class WorkspaceDataRepository implements vscode.Disposable, vscode.QuickDiffProvider, BaselineReader {
    public readonly sourceControl: vscode.SourceControl;
    private readonly publicGroup: vscode.SourceControlResourceGroup;
    private readonly privateGroup: vscode.SourceControlResourceGroup;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly cli: WorkspaceDataCli;
    private report: StatusReport | undefined;
    private refreshSequence = 0;
    private refreshTimer: NodeJS.Timeout | undefined;
    private disposed = false;

    // Create native SCM groups, immutable baseline routing, and one debounced namespace watcher.
    public constructor(
        public readonly folder: vscode.WorkspaceFolder,
        baselineProvider: BaselineFileSystemProvider,
        private readonly output: vscode.OutputChannel
    ) {
        this.cli = new WorkspaceDataCli(folder, output);
        this.sourceControl = vscode.scm.createSourceControl('workspaceData', 'Workspace Data', folder.uri);
        this.sourceControl.inputBox.visible = false;
        this.sourceControl.quickDiffProvider = this;
        this.publicGroup = this.sourceControl.createResourceGroup('public', 'Public Changes');
        this.privateGroup = this.sourceControl.createResourceGroup('private', 'Private Changes');
        this.publicGroup.hideWhenEmpty = true;
        this.privateGroup.hideWhenEmpty = true;
        this.disposables.push(
            this.publicGroup,
            this.privateGroup,
            this.sourceControl,
            baselineProvider.register(folder.uri.toString(), this)
        );

        // Debounce all generated-namespace events into local protocol refreshes.
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '#/**'));
        const schedule = (): void => this.scheduleRefresh();
        this.disposables.push(
            watcher,
            watcher.onDidCreate(schedule),
            watcher.onDidChange(schedule),
            watcher.onDidDelete(schedule)
        );
    }

    // Replace both resource groups only with the newest completed protocol response.
    public async refresh(): Promise<StatusReport> {
        const sequence = ++this.refreshSequence;
        const report = await this.cli.status();
        if (this.disposed || sequence !== this.refreshSequence) {
            return report;
        }
        this.report = report;
        const resources = report.state === 'ready'
            ? report.changes.map((change) => this.createResource(change))
            : [];
        this.publicGroup.resourceStates = resources.filter((resource) => resource.change.visibility === 'public');
        this.privateGroup.resourceStates = resources.filter((resource) => resource.change.visibility === 'private');
        this.sourceControl.count = resources.length;
        return report;
    }

    // Resolve quick diff only for files known to have a loaded baseline in the current report.
    public provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
        const change = this.changeForUri(uri);
        if (!change?.baseline.available) {
            return undefined;
        }
        return this.createBaseline(change);
    }

    // Fetch a baseline only while its requested revision remains the current loaded revision.
    public async readBaseline(visibility: Visibility, dataPath: string, revision: string): Promise<Uint8Array> {
        const currentRevision = this.report?.repositories[visibility]?.baselineRevision;
        if (!currentRevision || currentRevision !== revision) {
            throw new Error('The requested loaded baseline is no longer current. Reopen the diff to use the new baseline.');
        }
        return this.cli.show(visibility, dataPath, revision);
    }

    // Open the resource's ordinary two-way diff with a stable baseline title.
    public openChange(resource: WorkspaceDataResourceState): Thenable<unknown> {
        const title = `${path.posix.basename(resource.change.path)} (${resource.change.status}: loaded baseline)`;
        return vscode.commands.executeCommand('vscode.diff', resource.baselineUri, resource.comparisonUri, title);
    }

    // Schedule one refresh after related filesystem writes settle.
    private scheduleRefresh(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.refresh().catch((error: unknown) => {
                this.output.appendLine(`Workspace Data refresh failed for ${this.folder.name}: ${error instanceof Error ? error.message : String(error)}`);
            });
        }, 250);
    }

    // Create one immutable baseline URI and its corresponding native SCM resource.
    private createResource(change: WorkspaceDataChange): WorkspaceDataResourceState {
        const emptyUri = createBaselineUri({
            root: this.folder.uri.toString(),
            visibility: change.visibility,
            path: change.path,
            revision: 'empty',
            kind: 'empty'
        });
        const baselineUri = change.baseline.available ? this.createBaseline(change) : emptyUri;
        const workspaceUri = vscode.Uri.joinPath(this.folder.uri, ...change.workspacePath.split('/'));
        const comparisonUri = change.status === 'deleted' ? emptyUri : workspaceUri;
        return new WorkspaceDataResourceState(this.folder, change, baselineUri, comparisonUri);
    }

    // Bind baseline identity to the exact visibility revision returned beside the change.
    private createBaseline(change: WorkspaceDataChange): vscode.Uri {
        const revision = this.report?.repositories[change.visibility]?.baselineRevision;
        if (!revision) {
            throw new Error(`No loaded ${change.visibility} baseline revision is available.`);
        }
        return createBaselineUri({
            root: this.folder.uri.toString(),
            visibility: change.visibility,
            path: change.path,
            revision,
            kind: 'baseline'
        });
    }

    // Convert a local workspace URI back into a protocol change identity without path-prefix ambiguity.
    private changeForUri(uri: vscode.Uri): WorkspaceDataChange | undefined {
        if (uri.scheme !== 'file' || this.folder.uri.scheme !== 'file') {
            return undefined;
        }
        const relative = path.relative(this.folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
        if (relative.startsWith('../') || path.isAbsolute(relative)) {
            return undefined;
        }
        return this.report?.changes.find((change) => change.workspacePath === relative);
    }

    // Release watchers, SCM resources, timers, and baseline routing for this folder.
    public dispose(): void {
        this.disposed = true;
        this.refreshSequence += 1;
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        for (const disposable of this.disposables.reverse()) {
            disposable.dispose();
        }
    }
}
