// Serialize synchronization per workspace folder and present cancellable native progress.

import * as vscode from 'vscode';
import { WorkspaceDataCli } from './cli';

export class OperationManager {
    private readonly activeRoots = new Set<string>();

    // Retain the shared output destination used by all serialized operations.
    public constructor(private readonly output: vscode.OutputChannel) {}

    // Run one mutating CLI operation with serialized access and its selected native progress surface.
    public async run(
        folder: vscode.WorkspaceFolder,
        title: string,
        args: readonly string[],
        progressLocation: vscode.ProgressLocation = vscode.ProgressLocation.Notification
    ): Promise<boolean> {
        const key = folder.uri.toString();
        if (this.activeRoots.has(key)) {
            void vscode.window.showInformationMessage(`A Workspace Data operation is already running for ${folder.name}.`);
            return false;
        }
        this.activeRoots.add(key);
        this.output.appendLine(`\n> gh workspace-data ${args.join(' ')} (${folder.uri.fsPath})`);
        try {
            // Keep destructive Load cancellable while publication uses unobtrusive Source Control progress.
            const progressOptions: vscode.ProgressOptions = progressLocation === vscode.ProgressLocation.SourceControl
                ? { location: vscode.ProgressLocation.SourceControl }
                : { location: vscode.ProgressLocation.Notification, title, cancellable: true };
            await vscode.window.withProgress(progressOptions, async (_progress, token) => {
                await new WorkspaceDataCli(folder, this.output).synchronize(args, token);
            });
            return true;
        } catch (error) {
            if (!(error instanceof vscode.CancellationError)) {
                const message = error instanceof Error ? error.message : String(error);
                this.output.appendLine(message);
                this.output.show(true);
                void vscode.window.showErrorMessage(`Workspace Data: ${message}`);
            }
            return false;
        } finally {
            this.activeRoots.delete(key);
        }
    }
}
