"use strict";
// Invoke gh-workspace-data through a bounded, shell-free process boundary owned by one workspace folder.
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
exports.WorkspaceDataCli = exports.GitHubCliUnavailableError = void 0;
const node_child_process_1 = require("node:child_process");
const vscode = __importStar(require("vscode"));
const model_1 = require("./model");
const state_1 = require("./state");
const publicationStream_1 = require("./publicationStream");
const maximumOutputBytes = 101 * 1024 * 1024;
class GitHubCliUnavailableError extends Error {
}
exports.GitHubCliUnavailableError = GitHubCliUnavailableError;
class WorkspaceDataCli {
    folder;
    output;
    // Bind every invocation to one local workspace and one diagnostic channel.
    constructor(folder, output) {
        this.folder = folder;
        this.output = output;
    }
    // Verify the installed CLI extension contract without requiring repository or authentication state.
    async capabilities(token) {
        const bytes = await this.execute(['capabilities', '--json'], token, false);
        return (0, model_1.parseCapabilities)(bytes.toString('utf8'));
    }
    // Install or upgrade the required GitHub CLI extension after explicit user selection.
    async installOrUpgrade(token) {
        await this.executeGitHubCli([
            'extension', 'install', 'SorinGFS/gh-workspace-data', '--force'
        ], token, true);
    }
    // Verify the active github.com account before an operation that requires remote access.
    async verifyAuthentication(token) {
        await this.executeGitHubCli([
            'auth', 'status', '--active', '--hostname', 'github.com'
        ], token, false);
    }
    // Read local status through protocol version 1 without exposing process details to callers.
    async status(token) {
        const bytes = await this.execute(['status', '--json'], token, false);
        return (0, model_1.parseStatusReport)(bytes.toString('utf8'));
    }
    // Verify the canonical Git-origin identity once without hashing or loading materialized data.
    async identity() {
        const bytes = await this.execute(['identity', '--json'], undefined, false);
        const value = JSON.parse(bytes.toString('utf8'));
        if (!value || value.protocolVersion !== 1 || typeof value.projectIdentity !== 'string'
            || (0, state_1.safeSegments)(value.projectIdentity).length < 3) {
            throw new Error('Invalid workspace-data canonical project identity.');
        }
        return value.projectIdentity;
    }
    // Read one baseline as binary so text encoding never changes source bytes.
    show(visibility, dataPath, revision, token) {
        return this.execute([
            'show', '--protocol', '1', '--visibility', visibility,
            '--revision', revision, '--path', dataPath
        ], token, false);
    }
    // Run a synchronization action while copying its user-facing output into the extension channel.
    async synchronize(args, token) {
        await this.execute(args, token, true);
    }
    // Consume persisted checkpoint notifications without writing state, loading files, or reconstructing remote state.
    async publish(mergeOwned, observe, token) {
        await this.capabilities(token);
        const results = new publicationStream_1.PublicationResultStream(observe);
        await this.executeGitHubCli(['workspace-data', 'publish', ...(mergeOwned ? ['--merge-owned'] : [])], token, true, results);
    }
    // Capture bounded process output, propagate cancellation, and reject every nonzero exit status.
    execute(args, token, echo) {
        return this.executeGitHubCli(['workspace-data', ...args], token, echo);
    }
    // Capture bounded GitHub CLI output, propagate cancellation, and reject every nonzero exit status.
    executeGitHubCli(args, token, echo, results) {
        if (this.folder.uri.scheme !== 'file') {
            return Promise.reject(new Error('Workspace Data requires a local file workspace.'));
        }
        if (token?.isCancellationRequested) {
            return Promise.reject(new vscode.CancellationError());
        }
        return new Promise((resolve, reject) => {
            const child = (0, node_child_process_1.spawn)('gh', args, {
                cwd: this.folder.uri.fsPath,
                windowsHide: true,
                shell: false,
                env: { ...process.env, GH_PROMPT_DISABLED: '1' }
            });
            const stdout = [];
            const stderr = [];
            let outputBytes = 0;
            let settled = false;
            let outputFailure;
            // Terminate only this command process when the editor operation is cancelled.
            const cancellation = token?.onCancellationRequested(() => child.kill());
            // Accumulate one stream under a shared safety bound and optionally mirror it for users.
            const collect = (target, chunk) => {
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
            child.stdout.on('data', (chunk) => {
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
                }
                else {
                    collect(stdout, chunk);
                }
            });
            child.stderr.on('data', (chunk) => collect(stderr, chunk));
            // Surface executor startup failures independently of command exit diagnostics.
            child.on('error', (error) => {
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
                    // Drain persisted visibility notifications before handling partial failure/cancellation.
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
                }
                catch (error) {
                    reject(error);
                }
            });
        });
    }
}
exports.WorkspaceDataCli = WorkspaceDataCli;
//# sourceMappingURL=cli.js.map