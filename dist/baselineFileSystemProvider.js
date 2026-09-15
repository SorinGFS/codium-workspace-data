"use strict";
// Expose exact loaded baselines as immutable files while caching revision-bearing URI results.
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
exports.BaselineFileSystemProvider = void 0;
const vscode = __importStar(require("vscode"));
const resource_1 = require("./resource");
class BaselineFileSystemProvider {
    readers = new Map();
    cache = new Map();
    changeEmitter = new vscode.EventEmitter();
    onDidChangeFile = this.changeEmitter.event;
    // Associate virtual URI roots with the workspace repository that owns baseline access.
    register(root, reader) {
        this.readers.set(root, reader);
        return new vscode.Disposable(() => {
            if (this.readers.get(root) === reader) {
                this.readers.delete(root);
            }
        });
    }
    // Resolve file metadata from the same immutable byte cache used for reads.
    async stat(uri) {
        const bytes = await this.readFile(uri);
        return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: bytes.byteLength };
    }
    // Read and cache one exact baseline, rejecting stale uncached descriptors instead of changing content.
    readFile(uri) {
        const key = uri.toString();
        const existing = this.cache.get(key);
        if (existing) {
            return existing;
        }
        const descriptor = (0, resource_1.parseBaselineUri)(uri);
        const read = descriptor.kind === 'empty'
            ? Promise.resolve(new Uint8Array())
            : this.readers.get(descriptor.root)?.readBaseline(descriptor.visibility, descriptor.path, descriptor.revision) ?? Promise.reject(vscode.FileSystemError.Unavailable('The workspace-data source is no longer open.'));
        const retained = read.catch((error) => {
            this.cache.delete(key);
            throw error instanceof vscode.FileSystemError
                ? error
                : vscode.FileSystemError.Unavailable(error instanceof Error ? error.message : String(error));
        });
        this.cache.set(key, retained);
        return retained;
    }
    // Baselines are individual immutable files rather than browsable virtual directories.
    readDirectory(uri) {
        throw vscode.FileSystemError.FileNotADirectory(uri);
    }
    // Reject every mutation through the read-only provider contract.
    writeFile(uri) {
        throw vscode.FileSystemError.NoPermissions(uri);
    }
    // Reject directory creation because baseline namespace structure comes only from protocol state.
    createDirectory(uri) {
        throw vscode.FileSystemError.NoPermissions(uri);
    }
    // Reject deletion because virtual baseline lifetimes are cache-managed.
    delete(uri) {
        throw vscode.FileSystemError.NoPermissions(uri);
    }
    // Reject renames because revision-bearing identifiers are immutable.
    rename(oldUri) {
        throw vscode.FileSystemError.NoPermissions(oldUri);
    }
    // Baseline identifiers never emit changes; refreshed baselines receive new URIs.
    watch() {
        return new vscode.Disposable(() => undefined);
    }
    // Release extension-host event resources when the provider deactivates.
    dispose() {
        this.changeEmitter.dispose();
        this.readers.clear();
        this.cache.clear();
    }
}
exports.BaselineFileSystemProvider = BaselineFileSystemProvider;
//# sourceMappingURL=baselineFileSystemProvider.js.map