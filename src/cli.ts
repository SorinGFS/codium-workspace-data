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

import { PublicationEvent, safeSegments } from './state';
import { PublicationResultStream } from './publicationStream';

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

    // Verify the canonical Git-origin identity once without hashing or loading materialized data.
    public async identity(): Promise<string> {
        const bytes = await this.execute(['identity', '--json'], undefined, false);
        const value = JSON.parse(bytes.toString('utf8'));
        if (!value || value.protocolVersion !== 1 || typeof value.projectIdentity !== 'string'
            || safeSegments(value.projectIdentity).length < 3) {
            throw new Error('Invalid workspace-data canonical project identity.');
        }
        return value.projectIdentity;
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

    // Consume authoritative publication checkpoints without loading files or reconstructing remote state.
    public async publish(
        mergeOwned: boolean,
        acknowledge: (event: PublicationEvent) => Promise<void>,
        token?: vscode.CancellationToken
    ): Promise<void> {
        const results = new PublicationResultStream(acknowledge);
        await this.executeGitHubCli(['workspace-data', 'publish', ...(mergeOwned ? ['--merge-owned'] : [])], token, true, results);
    }

    // Capture bounded process output, propagate cancellation, and reject every nonzero exit status.
    private execute(args: readonly string[], token: vscode.CancellationToken | undefined, echo: boolean): Promise<Buffer> {
        return this.executeGitHubCli(['workspace-data', ...args], token, echo);
    }

    // Capture bounded GitHub CLI output, propagate cancellation, and reject every nonzero exit status.
    private executeGitHubCli(
        args: readonly string[],
        token: vscode.CancellationToken | undefined,
        echo: boolean,
        results?: PublicationResultStream
    ): Promise<Buffer> {
        if (this.folder.uri.scheme !== 'file') {
            return Promise.reject(new Error('Workspace Data requires a local file workspace.'));
        }
        if (token?.isCancellationRequested) {
            return Promise.reject(new vscode.CancellationError());
        }
        return new Promise((resolve, reject) => {
            const child = spawn('gh', args, {
                cwd: this.folder.uri.fsPath,
                windowsHide: true,
                shell: false,
                env: { ...process.env, GH_PROMPT_DISABLED: '1' }
            });
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let outputBytes = 0;
            let settled = false;
            let outputFailure: Error | undefined;

            // Terminate only this command process when the editor operation is cancelled.
            const cancellation = token?.onCancellationRequested(() => child.kill());

            // Accumulate one stream under a shared safety bound and optionally mirror it for users.
            const collect = (target: Buffer[], chunk: Buffer): void => {
                if (outputFailure) {
                    return;
                }
                outputBytes += chunk.length;
                if (outputBytes > maximumOutputBytes) {
                    outputFailure = new Error('GitHub CLI produced more than 101 MiB of output; review remote outcomes.');
                    child.kill();
                    return;
                }
                target.push(chunk);
                if (echo) {
                    this.output.append(chunk.toString('utf8'));
                }
            };

            child.stdout.on('data', (chunk: Buffer) => {
                if (results) {
                    if (outputFailure) {
                        return;
                    }
                    outputBytes += chunk.length;
                    if (outputBytes > maximumOutputBytes) {
                        outputFailure = new Error('Publication metadata exceeded 101 MiB; review remote outcomes.');
                        child.kill();
                        return;
                    }
                    results.push(chunk);
                } else {
                    collect(stdout, chunk);
                }
            });
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
            child.on('close', async (code) => {
                cancellation?.dispose();
                if (settled) {
                    return;
                }
                settled = true;
                try {
                    // Commit earlier successful visibility outcomes before handling partial failure/cancellation.
                    await results?.finish();
                    if (outputFailure) {
                        throw outputFailure;
                    }
                    if (token?.isCancellationRequested) {
                        throw new vscode.CancellationError();
                    }
                    if (code !== 0) {
                        const detail = Buffer.concat(stderr).toString('utf8').trim()
                            || Buffer.concat(stdout).toString('utf8').trim();
                        throw new Error(detail || `GitHub CLI exited with status ${String(code)}.`);
                    }
                    resolve(Buffer.concat(stdout));
                } catch (error) {
                    reject(error);
                }
            });
        });
    }
}
