"use strict";
// Maintain one workspace folder's SCM groups, quick diff mapping, and baseline protocol access.
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
exports.WorkspaceDataRepository = void 0;
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const cli_1 = require("./cli");
const resource_1 = require("./resource");
const workspaceIndex_1 = require("./workspaceIndex");
class WorkspaceDataRepository {
    folder;
    output;
    sourceControl;
    onDidChangeFileDecorations;
    publicGroup;
    privateGroup;
    decorationEmitter = new vscode.EventEmitter();
    disposables = [];
    cli;
    report;
    index;
    changesByPath = new Map();
    refreshWork;
    refreshPending = false;
    fullRefreshPending = false;
    suspended = false;
    identityVerified = false;
    refreshTimer;
    disposed = false;
    // Create native SCM groups, immutable baseline routing, and one debounced namespace watcher.
    constructor(folder, baselineProvider, output) {
        this.folder = folder;
        this.output = output;
        this.cli = new cli_1.WorkspaceDataCli(folder, output);
        this.index = new workspaceIndex_1.WorkspaceDataIndex(folder.uri.fsPath);
        this.onDidChangeFileDecorations = this.decorationEmitter.event;
        this.sourceControl = vscode.scm.createSourceControl('workspaceData', 'Workspace Data', folder.uri);
        this.sourceControl.inputBox.visible = false;
        this.sourceControl.quickDiffProvider = this;
        this.publicGroup = this.sourceControl.createResourceGroup('public', 'Public Changes');
        this.privateGroup = this.sourceControl.createResourceGroup('private', 'Private Changes');
        this.publicGroup.hideWhenEmpty = true;
        this.privateGroup.hideWhenEmpty = true;
        this.disposables.push(this.publicGroup, this.privateGroup, this.sourceControl, this.decorationEmitter, vscode.window.registerFileDecorationProvider(this), baselineProvider.register(folder.uri.toString(), this));
        // Track only data/state invalidations; publication staging never schedules a complete scan.
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '#/**'));
        const schedule = (uri) => {
            if (this.index.invalidate(path.relative(folder.uri.fsPath, uri.fsPath))) {
                this.scheduleRefresh();
            }
        };
        this.disposables.push(watcher, watcher.onDidCreate(schedule), watcher.onDidChange(schedule), watcher.onDidDelete(schedule), vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) {
                void this.refresh(true).catch((error) => this.logRefreshError(error));
            }
        }));
    }
    // Coalesce refresh requests into one worker; filesystem bursts never create overlapping scans.
    refresh(full = true) {
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
    async drainRefreshes() {
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
    async suspendRefresh() {
        if (!this.report) {
            await this.refresh(true);
        }
        this.suspended = true;
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        await this.refreshWork?.catch((error) => this.logRefreshError(error));
    }
    // Finish every mutation, including partial failures, with one coalesced local reconciliation.
    async resumeRefresh(full = false) {
        this.suspended = false;
        await this.refresh(full);
    }
    // Record persisted publication epochs; reconciliation reads authoritative metadata from disk.
    observePublication(event) {
        this.index.observePublication(event);
    }
    // Replace resource/decorations snapshots; native SCM computes the renderer-side resource splices.
    render(report) {
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
    provideFileDecoration(uri) {
        const change = this.changeForUri(uri);
        if (change?.status === 'modified') {
            return new vscode.FileDecoration('M', 'Modified workspace data', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
        }
        if (change?.status === 'added') {
            return new vscode.FileDecoration('U', 'Untracked workspace data', new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'));
        }
        return undefined;
    }
    // Resolve quick diff only for files known to have a loaded baseline in the current report.
    provideOriginalResource(uri) {
        const change = this.changeForUri(uri);
        if (!change?.baseline.available) {
            return undefined;
        }
        return this.createBaseline(change);
    }
    // Fetch a baseline only while its requested revision remains the current loaded revision.
    async readBaseline(visibility, dataPath, revision) {
        const currentRevision = this.report?.repositories[visibility]?.baselineRevision;
        if (!currentRevision || currentRevision !== revision) {
            throw new Error('The requested loaded baseline is no longer current. Reopen the diff to use the new baseline.');
        }
        return this.cli.show(visibility, dataPath, revision);
    }
    // Open the resource's ordinary two-way diff with a stable baseline title.
    openChange(resource) {
        const title = `${path.posix.basename(resource.change.path)} (${resource.change.status}: loaded baseline)`;
        return vscode.commands.executeCommand('vscode.diff', resource.baselineUri, resource.comparisonUri, title);
    }
    // Schedule one refresh after related filesystem writes settle.
    scheduleRefresh() {
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
            void this.refresh(false).catch((error) => this.logRefreshError(error));
        }, 250);
    }
    // Keep background refresh diagnostics out of repeated modal notifications.
    logRefreshError(error) {
        this.output.appendLine(`Workspace Data refresh failed for ${this.folder.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Create one immutable baseline URI and its corresponding native SCM resource.
    createResource(change) {
        const emptyUri = (0, resource_1.createBaselineUri)({
            root: this.folder.uri.toString(),
            visibility: change.visibility,
            path: change.path,
            revision: 'empty',
            kind: 'empty'
        });
        const baselineUri = change.baseline.available ? this.createBaseline(change) : emptyUri;
        const workspaceUri = vscode.Uri.joinPath(this.folder.uri, ...change.workspacePath.split('/'));
        const comparisonUri = change.status === 'deleted' ? emptyUri : workspaceUri;
        return new resource_1.WorkspaceDataResourceState(this.folder, change, baselineUri, comparisonUri);
    }
    // Bind baseline identity to the exact visibility revision returned beside the change.
    createBaseline(change) {
        const revision = this.report?.repositories[change.visibility]?.baselineRevision;
        if (!revision) {
            throw new Error(`No loaded ${change.visibility} baseline revision is available.`);
        }
        return (0, resource_1.createBaselineUri)({
            root: this.folder.uri.toString(),
            visibility: change.visibility,
            path: change.path,
            revision,
            kind: 'baseline'
        });
    }
    // Collect only existing-file statuses that can be rendered at Explorer resource URIs.
    decoratedUris(report) {
        return report?.changes
            .filter((change) => change.status === 'modified' || change.status === 'added')
            .map((change) => vscode.Uri.joinPath(this.folder.uri, ...change.workspacePath.split('/'))) || [];
    }
    // Convert a local workspace URI back into a protocol change identity without path-prefix ambiguity.
    changeForUri(uri) {
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
    dispose() {
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
exports.WorkspaceDataRepository = WorkspaceDataRepository;
//# sourceMappingURL=repository.js.map