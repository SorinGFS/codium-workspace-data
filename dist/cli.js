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
    // Capture bounded process output, propagate cancellation, and reject every nonzero exit status.
    execute(args, token, echo) {
        return this.executeGitHubCli(['workspace-data', ...args], token, echo);
    }
    // Capture bounded GitHub CLI output, propagate cancellation, and reject every nonzero exit status.
    executeGitHubCli(args, token, echo) {
        if (this.folder.uri.scheme !== 'file') {
            return Promise.reject(new Error('Workspace Data requires a local file workspace.'));
        }
        return new Promise((resolve, reject) => {
            const child = (0, node_child_process_1.spawn)('gh', args, {
                cwd: this.folder.uri.fsPath,
                windowsHide: true,
                shell: false
            });
            const stdout = [];
            const stderr = [];
            let outputBytes = 0;
            let settled = false;
            // Terminate only this command process when the editor operation is cancelled.
            const cancellation = token?.onCancellationRequested(() => child.kill());
            // Accumulate one stream under a shared safety bound and optionally mirror it for users.
            const collect = (target, chunk) => {
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
            child.stdout.on('data', (chunk) => collect(stdout, chunk));
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
exports.WorkspaceDataCli = WorkspaceDataCli;
//# sourceMappingURL=cli.js.map