"use strict";
// Serialize synchronization per workspace folder and present cancellable native progress.
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
exports.OperationManager = void 0;
const vscode = __importStar(require("vscode"));
const cli_1 = require("./cli");
class OperationManager {
    output;
    activeRoots = new Set();
    // Retain the shared output destination used by all serialized operations.
    constructor(output) {
        this.output = output;
    }
    // Run one mutating CLI operation without allowing overlapping load or publication in the same folder.
    async run(folder, title, args) {
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
                await new cli_1.WorkspaceDataCli(folder, this.output).synchronize(args, token);
            });
            return true;
        }
        catch (error) {
            if (!(error instanceof vscode.CancellationError)) {
                const message = error instanceof Error ? error.message : String(error);
                this.output.appendLine(message);
                this.output.show(true);
                void vscode.window.showErrorMessage(`Workspace Data: ${message}`);
            }
            return false;
        }
        finally {
            this.activeRoots.delete(key);
        }
    }
}
exports.OperationManager = OperationManager;
//# sourceMappingURL=operationManager.js.map