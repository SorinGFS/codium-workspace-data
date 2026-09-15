// Invoke gh-workspace-data through a bounded, shell-free process boundary owned by one workspace folder.

import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import {
    parseCapabilities,
    parseStatusReport,
    StatusReport,
    Visibility,
    WorkspaceDataCapabilities
} from './model';

const maximumOutputBytes = 101 * 1024 * 1024;

export class GitHubCliUnavailableError extends Error {}

export class WorkspaceDataCli {
    // Bind every invocation to one local workspace and one diagnostic channel.
    public constructor(
        private readonly folder: vscode.WorkspaceFolder,
        private readonly output: vscode.OutputChannel
    ) {}

    // Verify the installed CLI extension contract without requiring repository or authentication state.
    public async capabilities(token?: vscode.CancellationToken): Promise<WorkspaceDataCapabilities> {
        const bytes = await this.execute(['capabilities', '--json'], token, false);
        return parseCapabilities(bytes.toString('utf8'));
    }

    // Install or upgrade the required GitHub CLI extension after explicit user selection.
    public async installOrUpgrade(token?: vscode.CancellationToken): Promise<void> {
        await this.executeGitHubCli([
            'extension', 'install', 'SorinGFS/gh-workspace-data', '--force'
        ], token, true);
    }

    // Verify the active github.com account before an operation that requires remote access.
    public async verifyAuthentication(token?: vscode.CancellationToken): Promise<void> {
        await this.executeGitHubCli([
            'auth', 'status', '--active', '--hostname', 'github.com'
        ], token, false);
    }

    // Read local status through protocol version 1 without exposing process details to callers.
    public async status(token?: vscode.CancellationToken): Promise<StatusReport> {
        const bytes = await this.execute(['status', '--json'], token, false);
        return parseStatusReport(bytes.toString('utf8'));
    }

    // Read one baseline as binary so text encoding never changes source bytes.
    public show(
        visibility: Visibility,
        dataPath: string,
        revision: string,
        token?: vscode.CancellationToken
    ): Promise<Uint8Array> {
        return this.execute([
            'show', '--protocol', '1', '--visibility', visibility,
            '--revision', revision, '--path', dataPath
        ], token, false);
    }

    // Run a synchronization action while copying its user-facing output into the extension channel.
    public async synchronize(args: readonly string[], token?: vscode.CancellationToken): Promise<void> {
        await this.execute(args, token, true);
    }

    // Capture bounded process output, propagate cancellation, and reject every nonzero exit status.
    private execute(args: readonly string[], token: vscode.CancellationToken | undefined, echo: boolean): Promise<Buffer> {
        return this.executeGitHubCli(['workspace-data', ...args], token, echo);
    }

    // Capture bounded GitHub CLI output, propagate cancellation, and reject every nonzero exit status.
    private executeGitHubCli(
        args: readonly string[],
        token: vscode.CancellationToken | undefined,
        echo: boolean
    ): Promise<Buffer> {
        if (this.folder.uri.scheme !== 'file') {
            return Promise.reject(new Error('Workspace Data requires a local file workspace.'));
        }
        return new Promise((resolve, reject) => {
            const child = spawn('gh', args, {
                cwd: this.folder.uri.fsPath,
                windowsHide: true,
                shell: false
            });
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let outputBytes = 0;
            let settled = false;

            // Terminate only this command process when the editor operation is cancelled.
            const cancellation = token?.onCancellationRequested(() => child.kill());

            // Accumulate one stream under a shared safety bound and optionally mirror it for users.
            const collect = (target: Buffer[], chunk: Buffer): void => {
                outputBytes += chunk.length;
                if (outputBytes > maximumOutputBytes) {
                    child.kill();
                    if (!settled) {
                        settled = true;
                        reject(new Error('GitHub CLI produced more than 101 MiB of output.'));
                    }
                    return;
                }
                target.push(chunk);
                if (echo) {
                    this.output.append(chunk.toString('utf8'));
                }
            };

            child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
            child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));

            // Surface executor startup failures independently of command exit diagnostics.
            child.on('error', (error: NodeJS.ErrnoException) => {
                cancellation?.dispose();
                if (!settled) {
                    settled = true;
                    reject(error.code === 'ENOENT'
                        ? new GitHubCliUnavailableError('GitHub CLI is not installed or is not available on PATH.')
                        : new Error(`Unable to run GitHub CLI: ${error.message}`));
                }
            });

            // Resolve only successful commands and retain stderr as the authoritative failure detail.
            child.on('close', (code) => {
                cancellation?.dispose();
                if (settled) {
                    return;
                }
                settled = true;
                if (token?.isCancellationRequested) {
                    reject(new vscode.CancellationError());
                    return;
                }
                if (code !== 0) {
                    const detail = Buffer.concat(stderr).toString('utf8').trim()
                        || Buffer.concat(stdout).toString('utf8').trim();
                    reject(new Error(detail || `GitHub CLI exited with status ${String(code)}.`));
                    return;
                }
                resolve(Buffer.concat(stdout));
            });
        });
    }
}
