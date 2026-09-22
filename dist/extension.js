"use strict";
// Activate the native SCM presentation while delegating every workspace-data decision to the CLI protocol.
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
exports.activate = activate;
exports.deactivate = deactivate;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const baselineFileSystemProvider_1 = require("./baselineFileSystemProvider");
const cli_1 = require("./cli");
const model_1 = require("./model");
const operationManager_1 = require("./operationManager");
const repository_1 = require("./repository");
const resource_1 = require("./resource");
class WorkspaceDataController {
    baselineProvider;
    output;
    repositories = new Map();
    disposables = [];
    operations;
    prerequisitesReady = false;
    prerequisiteCheck;
    // Initialize workspace discovery and command routing for one extension-host activation.
    constructor(baselineProvider, output) {
        this.baselineProvider = baselineProvider;
        this.output = output;
        this.operations = new operationManager_1.OperationManager(output);
        this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.discover()));
        const stateWatcher = vscode.workspace.createFileSystemWatcher('**/#/.data-state.json');
        this.disposables.push(stateWatcher, stateWatcher.onDidCreate(() => this.discover()), stateWatcher.onDidDelete(() => this.discover()));
        this.registerCommands();
        this.discover();
    }
    // Add and remove SCM providers to match current local workspace state files.
    discover() {
        const folders = vscode.workspace.workspaceFolders || [];
        const initialized = new Map(folders.filter((folder) => this.hasOrdinaryState(folder))
            .map((folder) => [folder.uri.toString(), folder]));
        // Dispose providers whose folder or ordinary state file no longer exists.
        for (const [key, repository] of this.repositories) {
            if (!initialized.has(key)) {
                repository.dispose();
                this.repositories.delete(key);
            }
        }
        // Create and asynchronously populate each newly initialized provider.
        for (const [key, folder] of initialized) {
            if (!this.repositories.has(key)) {
                const repository = new repository_1.WorkspaceDataRepository(folder, this.baselineProvider, this.output);
                this.repositories.set(key, repository);
                void this.refreshRepository(repository, false);
            }
        }
    }
    // Register user commands once and route their workspace selection through this controller.
    registerCommands() {
        this.disposables.push(vscode.commands.registerCommand('workspaceData.openChange', (resource) => {
            if (resource instanceof resource_1.WorkspaceDataResourceState) {
                return this.repositoryForUri(resource.resourceUri)?.openChange(resource);
            }
            return undefined;
        }), vscode.commands.registerCommand('workspaceData.refresh', async () => {
            const repository = await this.pickRepository();
            if (repository) {
                await this.refreshRepository(repository, true);
            }
        }), vscode.commands.registerCommand('workspaceData.load', async () => {
            const folder = await this.pickFolder(false);
            if (!folder || !await this.ensurePrerequisites(folder)
                || !await this.ensureAuthentication(folder) || !await this.confirmLoadOverwrite(folder)) {
                return;
            }
            const activeDataEditor = this.activeWorkspaceDataEditor(folder);
            if (await this.operations.run(folder, `Loading Workspace Data for ${folder.name}`, ['load'])) {
                await this.reloadActiveWorkspaceDataEditor(activeDataEditor);
                this.discover();
                const repository = this.repositories.get(folder.uri.toString());
                if (repository) {
                    await this.refreshRepository(repository, true);
                }
            }
        }), vscode.commands.registerCommand('workspaceData.publish', () => this.runPublication(false)), vscode.commands.registerCommand('workspaceData.publishAndMergeOwned', () => this.runPublication(true)));
    }
    // Cache one successful user-wide prerequisite check while sharing concurrent activation checks.
    async ensurePrerequisites(folder) {
        if (this.prerequisitesReady) {
            return true;
        }
        if (!this.prerequisiteCheck) {
            this.prerequisiteCheck = this.checkPrerequisites(folder);
        }
        try {
            const ready = await this.prerequisiteCheck;
            this.prerequisitesReady = ready;
            return ready;
        }
        finally {
            this.prerequisiteCheck = undefined;
        }
    }
    // Guide installation explicitly and execute it only after the user selects the install action.
    async checkPrerequisites(folder) {
        const cli = new cli_1.WorkspaceDataCli(folder, this.output);
        try {
            await cli.capabilities();
            return true;
        }
        catch (error) {
            if (error instanceof cli_1.GitHubCliUnavailableError) {
                const selection = await vscode.window.showErrorMessage('Workspace Data requires GitHub CLI, but gh is not available on PATH.', 'Open GitHub CLI Setup');
                if (selection === 'Open GitHub CLI Setup') {
                    await vscode.env.openExternal(vscode.Uri.parse('https://cli.github.com/'));
                }
                return false;
            }
            const detail = error instanceof Error ? error.message : String(error);
            this.output.appendLine(`Workspace Data prerequisite check failed: ${detail}`);
            const selection = await vscode.window.showWarningMessage('Workspace Data requires SorinGFS/gh-workspace-data with compatible inspection and Load capabilities.', 'Install or Upgrade', 'View Documentation');
            if (selection === 'View Documentation') {
                await vscode.env.openExternal(vscode.Uri.parse('https://github.com/SorinGFS/gh-workspace-data#install-and-get-started'));
                return false;
            }
            if (selection !== 'Install or Upgrade') {
                return false;
            }
            try {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Installing or upgrading gh-workspace-data',
                    cancellable: true
                }, async (_progress, token) => cli.installOrUpgrade(token));
                await cli.capabilities();
                void vscode.window.showInformationMessage('The gh-workspace-data prerequisite is ready.');
                return true;
            }
            catch (installError) {
                const message = installError instanceof Error ? installError.message : String(installError);
                this.output.appendLine(`Workspace Data prerequisite installation failed: ${message}`);
                this.output.show(true);
                void vscode.window.showErrorMessage(`Workspace Data: ${message}`);
                return false;
            }
        }
    }
    // Guide unauthenticated users to GitHub CLI setup before any remote mutation is attempted.
    async ensureAuthentication(folder) {
        try {
            await new cli_1.WorkspaceDataCli(folder, this.output).verifyAuthentication();
            return true;
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.output.appendLine(`Workspace Data authentication check failed: ${detail}`);
            const selection = await vscode.window.showWarningMessage('Workspace Data requires an authenticated GitHub CLI account for github.com.', 'Open Authentication Setup');
            if (selection === 'Open Authentication Setup') {
                await vscode.env.openExternal(vscode.Uri.parse('https://cli.github.com/manual/gh_auth_login'));
            }
            return false;
        }
    }
    // Confirm destructive loading only when current status or dirty editors contain unpublished work.
    async confirmLoadOverwrite(folder) {
        const repository = this.repositories.get(folder.uri.toString());
        let report;
        if (repository) {
            try {
                report = await repository.refresh();
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.output.appendLine(`Workspace Data pre-load refresh failed for ${folder.name}: ${message}`);
                void vscode.window.showErrorMessage(`Workspace Data: ${message}`);
                return false;
            }
        }
        if (!(0, model_1.loadNeedsConfirmation)(report, this.hasDirtyWorkspaceDataDocument(folder))) {
            return true;
        }
        const selection = await vscode.window.showWarningMessage(model_1.loadOverwritePrompt, { modal: true }, 'Overwrite');
        return selection === 'Overwrite';
    }
    // Detect unsaved workspace-data editors that the local status protocol cannot observe yet.
    hasDirtyWorkspaceDataDocument(folder) {
        return vscode.workspace.textDocuments.some((document) => document.isDirty
            && this.isWorkspaceDataUri(folder, document.uri));
    }
    // Capture the active model and generation so only edits covered by confirmation can be reverted.
    activeWorkspaceDataEditor(folder) {
        const document = vscode.window.activeTextEditor?.document;
        return document && this.isWorkspaceDataUri(folder, document.uri)
            ? { document, version: document.version }
            : undefined;
    }
    // Reload only the unchanged active model; preserve and report edits made while Load was running.
    async reloadActiveWorkspaceDataEditor(expected) {
        const activeDocument = vscode.window.activeTextEditor?.document;
        if (!expected || !activeDocument || activeDocument !== expected.document) {
            return;
        }
        if (activeDocument.version !== expected.version) {
            void vscode.window.showWarningMessage('The active Workspace Data editor changed while Load was running, so its contents were preserved. Review it before continuing.');
            return;
        }
        try {
            await vscode.commands.executeCommand('workbench.action.files.revert');
        }
        catch (error) {
            this.output.appendLine(`Workspace Data could not reload ${expected.document.uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    // Identify public or private materialized data beneath one local workspace without prefix ambiguity.
    isWorkspaceDataUri(folder, uri) {
        if (uri.scheme !== 'file') {
            return false;
        }
        const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
        return relative.startsWith('#/public/') || relative.startsWith('#/private/');
    }
    // Publish through the selected repository and refresh only after a successful CLI operation.
    async runPublication(mergeOwned) {
        const repository = await this.pickRepository();
        if (!repository || !await this.ensurePrerequisites(repository.folder)
            || !await this.ensureAuthentication(repository.folder)) {
            return;
        }
        const args = mergeOwned ? ['publish', '--merge-owned'] : ['publish'];
        const title = mergeOwned
            ? `Publishing and Merging Owned Workspace Data for ${repository.folder.name}`
            : `Publishing Workspace Data for ${repository.folder.name}`;
        if (await this.operations.run(repository.folder, title, args, vscode.ProgressLocation.SourceControl)) {
            await this.refreshRepository(repository, true);
        }
    }
    // Refresh one repository and explain protocol states that need a user action.
    async refreshRepository(repository, notify) {
        if (!await this.ensurePrerequisites(repository.folder)) {
            return;
        }
        try {
            const report = await repository.refresh();
            if (notify) {
                await this.notifyState(report.state);
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.output.appendLine(`Workspace Data refresh failed for ${repository.folder.name}: ${message}`);
            if (notify) {
                void vscode.window.showErrorMessage(`Workspace Data: ${message}`);
            }
        }
    }
    // Translate non-ready status states into concise editor guidance.
    async notifyState(state) {
        if (state === 'reloadRequired') {
            const selection = await vscode.window.showWarningMessage('Workspace Data needs one successful load to create its inspection baseline.', 'Load');
            if (selection === 'Load') {
                await vscode.commands.executeCommand('workspaceData.load');
            }
        }
        else if (state === 'notInitialized') {
            void vscode.window.showInformationMessage('Workspace Data is not initialized in this folder.');
        }
    }
    // Prefer the active editor's workspace before asking among multiple initialized providers.
    async pickRepository() {
        const active = vscode.window.activeTextEditor
            ? this.repositoryForUri(vscode.window.activeTextEditor.document.uri)
            : undefined;
        if (active) {
            return active;
        }
        const repositories = [...this.repositories.values()];
        if (repositories.length === 0) {
            void vscode.window.showInformationMessage('No initialized Workspace Data folder is open.');
            return undefined;
        }
        if (repositories.length === 1) {
            return repositories[0];
        }
        const selected = await vscode.window.showQuickPick(repositories.map((repository) => ({ label: repository.folder.name, repository })), { placeHolder: 'Select a Workspace Data folder' });
        return selected?.repository;
    }
    // Select any local folder for load, or only initialized folders for dependent commands.
    async pickFolder(initializedOnly) {
        if (initializedOnly) {
            return (await this.pickRepository())?.folder;
        }
        const folders = (vscode.workspace.workspaceFolders || []).filter((folder) => folder.uri.scheme === 'file');
        if (folders.length === 0) {
            void vscode.window.showInformationMessage('Open a local Git workspace before loading Workspace Data.');
            return undefined;
        }
        const activeFolder = vscode.window.activeTextEditor
            ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
            : undefined;
        if (activeFolder?.uri.scheme === 'file') {
            return activeFolder;
        }
        if (folders.length === 1) {
            return folders[0];
        }
        const selected = await vscode.window.showQuickPick(folders.map((folder) => ({ label: folder.name, folder })), { placeHolder: 'Select a folder to load Workspace Data' });
        return selected?.folder;
    }
    // Find the provider owning a URI through the editor's canonical workspace-folder mapping.
    repositoryForUri(uri) {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        return folder ? this.repositories.get(folder.uri.toString()) : undefined;
    }
    // Recognize only ordinary local namespace and state objects without following filesystem links.
    hasOrdinaryState(folder) {
        if (folder.uri.scheme !== 'file') {
            return false;
        }
        try {
            const namespace = fs.lstatSync(path.join(folder.uri.fsPath, '#'));
            const state = fs.lstatSync(path.join(folder.uri.fsPath, '#', '.data-state.json'));
            return namespace.isDirectory() && !namespace.isSymbolicLink()
                && state.isFile() && !state.isSymbolicLink();
        }
        catch {
            return false;
        }
    }
    // Dispose every provider and command registration owned by this activation.
    dispose() {
        for (const repository of this.repositories.values()) {
            repository.dispose();
        }
        this.repositories.clear();
        for (const disposable of this.disposables.reverse()) {
            disposable.dispose();
        }
    }
}
// Register the read-only baseline scheme before constructing SCM providers that reference it.
function activate(context) {
    const output = vscode.window.createOutputChannel('Workspace Data');
    const baselineProvider = new baselineFileSystemProvider_1.BaselineFileSystemProvider();
    const registration = vscode.workspace.registerFileSystemProvider(resource_1.baselineScheme, baselineProvider, {
        isCaseSensitive: true,
        isReadonly: true
    });
    const controller = new WorkspaceDataController(baselineProvider, output);
    context.subscriptions.push(output, baselineProvider, registration, controller);
}
// All extension resources are owned by the activation context, so explicit deactivation is unnecessary.
function deactivate() { }
//# sourceMappingURL=extension.js.map