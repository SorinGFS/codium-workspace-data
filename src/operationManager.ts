// Serialize synchronization per workspace folder and present cancellable native progress.

import * as vscode from 'vscode';
import { WorkspaceDataCli } from './cli';

export class OperationManager {
    private readonly activeRoots = new Set<string>();

    // Retain the shared output destination used by all serialized operations.
    public constructor(private readonly output: vscode.OutputChannel) {}

    // Run one mutating CLI operation without allowing overlapping load or publication in the same folder.
    public async run(
        folder: vscode.WorkspaceFolder,
        title: string,
        args: readonly string[]
    ): Promise<boolean> {
        const key = folder.uri.toString();
        if (this.activeRoots.has(key)) {
            void vscode.window.showInformationMessage(`A Workspace Data operation is already running for ${folder.name}.`);
            return false;
        }
        this.activeRoots.add(key);
        this.output.appendLine(`\n> gh workspace-data ${args.join(' ')} (${folder.uri.fsPath})`);
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title,
                cancellable: true
            }, async (_progress, token) => {
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
