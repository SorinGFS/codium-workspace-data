// Maintain one workspace folder's SCM groups, quick diff mapping, and baseline protocol access.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { BaselineFileSystemProvider, BaselineReader } from './baselineFileSystemProvider';
import { WorkspaceDataCli } from './cli';
import { StatusReport, Visibility, WorkspaceDataChange } from './model';
import { createBaselineUri, WorkspaceDataResourceState } from './resource';
import { PublicationEvent } from './state';
import { WorkspaceDataIndex } from './workspaceIndex';

export class WorkspaceDataRepository implements vscode.Disposable, vscode.QuickDiffProvider,
    vscode.FileDecorationProvider, BaselineReader {
    public readonly sourceControl: vscode.SourceControl;
    public readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined>;
    private readonly publicGroup: vscode.SourceControlResourceGroup;
    private readonly privateGroup: vscode.SourceControlResourceGroup;
    private readonly decorationEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    private readonly disposables: vscode.Disposable[] = [];
    private readonly cli: WorkspaceDataCli;
    private report: StatusReport | undefined;
    private readonly index: WorkspaceDataIndex;
    private readonly changesByPath = new Map<string, WorkspaceDataChange>();
    private refreshWork: Promise<StatusReport> | undefined;
    private refreshPending = false;
    private fullRefreshPending = false;
    private suspended = false;
    private identityVerified = false;
    private refreshTimer: NodeJS.Timeout | undefined;
    private disposed = false;

    // Create native SCM groups, immutable baseline routing, and one debounced namespace watcher.
    public constructor(
        public readonly folder: vscode.WorkspaceFolder,
        baselineProvider: BaselineFileSystemProvider,
        private readonly output: vscode.OutputChannel
    ) {
        this.cli = new WorkspaceDataCli(folder, output);
        this.index = new WorkspaceDataIndex(folder.uri.fsPath);
        this.onDidChangeFileDecorations = this.decorationEmitter.event;
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
            this.decorationEmitter,
            vscode.window.registerFileDecorationProvider(this),
            baselineProvider.register(folder.uri.toString(), this)
        );

        // Track only data/state invalidations; publication staging never schedules a complete scan.
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '#/**'));
        const schedule = (uri: vscode.Uri): void => {
            if (this.index.invalidate(path.relative(folder.uri.fsPath, uri.fsPath))) {
                this.scheduleRefresh();
            }
        };
        this.disposables.push(
            watcher,
            watcher.onDidCreate(schedule),
            watcher.onDidChange(schedule),
            watcher.onDidDelete(schedule),
            vscode.window.onDidChangeWindowState((state) => {
                if (state.focused) {
                    void this.refresh(true).catch((error: unknown) => this.logRefreshError(error));
                }
            })
        );
    }

    // Coalesce refresh requests into one worker; filesystem bursts never create overlapping scans.
    public refresh(full = true): Promise<StatusReport> {
        this.refreshPending = true;
        this.fullRefreshPending ||= full;
        if (this.suspended || this.disposed) {
            return this.report ? Promise.resolve(this.report) : Promise.reject(new Error('Workspace Data refresh is suspended.'));
        }
        if (!this.refreshWork) {
            this.refreshWork = this.drainRefreshes().finally(() => {
                this.refreshWork = undefined;
                if (this.refreshPending && !this.suspended && !this.disposed) {
                    this.scheduleRefresh();
                }
            });
        }
        return this.refreshWork;
    }

    // Drain requests received during asynchronous hashing while publishing only coherent snapshots.
    private async drainRefreshes(): Promise<StatusReport> {
        let report = this.report;
        while (this.refreshPending && !this.suspended && !this.disposed) {
            this.refreshPending = false;
            const full = this.fullRefreshPending;
            this.fullRefreshPending = false;
            if (full || !this.identityVerified) {
                this.index.bindIdentity(await this.cli.identity());
                this.identityVerified = true;
            }
            report = await this.index.refresh(full);
            this.render(report);
        }
        if (!report) {
            throw new Error('Workspace Data has no current inspection snapshot.');
        }
        return report;
    }

    // Retain watcher invalidations during a mutation and wait for the current local scan to finish.
    public async suspendRefresh(): Promise<void> {
        if (!this.report) {
            await this.refresh(true);
        }
        this.suspended = true;
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        await this.refreshWork?.catch((error: unknown) => this.logRefreshError(error));
    }

    // Finish every mutation, including partial failures, with one coalesced local reconciliation.
    public async resumeRefresh(full = false): Promise<void> {
        this.suspended = false;
        await this.refresh(full);
    }

    // Record persisted publication epochs; reconciliation reads authoritative metadata from disk.
    public observePublication(event: PublicationEvent): void {
        this.index.observePublication(event);
    }

    // Replace resource/decorations snapshots; native SCM computes the renderer-side resource splices.
    private render(report: StatusReport): void {
        if (this.disposed) {
            return;
        }
        const previousDecorations = this.decoratedUris(this.report);
        this.report = report;
        this.changesByPath.clear();
        // Serve Explorer decorations and quick-diff requests through constant-time path lookups.
        for (const change of report.changes) {
            this.changesByPath.set(change.workspacePath, change);
        }
        const resources = report.state === 'ready'
            ? report.changes.map((change) => this.createResource(change))
            : [];
        this.publicGroup.resourceStates = resources.filter((resource) => resource.change.visibility === 'public');
        this.privateGroup.resourceStates = resources.filter((resource) => resource.change.visibility === 'private');
        this.sourceControl.count = resources.length;

        // Invalidate both removed and current Explorer decorations after replacing status.
        const affectedDecorations = new Map(previousDecorations.map((uri) => [uri.toString(), uri]));
        for (const uri of this.decoratedUris(report)) {
            affectedDecorations.set(uri.toString(), uri);
        }
        if (affectedDecorations.size > 0) {
            this.decorationEmitter.fire([...affectedDecorations.values()]);
        }
    }

    // Decorate existing modified and added data files with familiar Explorer status badges.
    public provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        const change = this.changeForUri(uri);
        if (change?.status === 'modified') {
            return new vscode.FileDecoration(
                'M',
                'Modified workspace data',
                new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
            );
        }
        if (change?.status === 'added') {
            return new vscode.FileDecoration(
                'U',
                'Untracked workspace data',
                new vscode.ThemeColor('gitDecoration.untrackedResourceForeground')
            );
        }
        return undefined;
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
            this.refreshTimer = undefined;
        }
        if (this.suspended || this.disposed) {
            this.refreshPending = true;
            return;
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.refresh(false).catch((error: unknown) => this.logRefreshError(error));
        }, 250);
    }

    // Keep background refresh diagnostics out of repeated modal notifications.
    private logRefreshError(error: unknown): void {
        this.output.appendLine(`Workspace Data refresh failed for ${this.folder.name}: ${error instanceof Error ? error.message : String(error)}`);
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

    // Collect only existing-file statuses that can be rendered at Explorer resource URIs.
    private decoratedUris(report: StatusReport | undefined): vscode.Uri[] {
        return report?.changes
            .filter((change) => change.status === 'modified' || change.status === 'added')
            .map((change) => vscode.Uri.joinPath(this.folder.uri, ...change.workspacePath.split('/'))) || [];
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
        return this.changesByPath.get(relative);
    }

    // Release watchers, SCM resources, timers, and baseline routing for this folder.
    public dispose(): void {
        this.disposed = true;
        this.refreshPending = false;
        this.changesByPath.clear();
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        for (const disposable of this.disposables.reverse()) {
            disposable.dispose();
        }
    }
}
