"use strict";
// Translate protocol changes into native SCM resources and immutable virtual baseline identifiers.
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
exports.WorkspaceDataResourceState = exports.baselineScheme = void 0;
exports.createBaselineUri = createBaselineUri;
exports.parseBaselineUri = parseBaselineUri;
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
exports.baselineScheme = 'workspace-data-baseline';
// Encode every identity component required to prevent an open baseline from silently changing.
function createBaselineUri(descriptor) {
    const query = new URLSearchParams({
        root: descriptor.root,
        revision: descriptor.revision,
        kind: descriptor.kind
    });
    return vscode.Uri.from({
        scheme: exports.baselineScheme,
        authority: 'loaded',
        path: `/${descriptor.visibility}/${descriptor.path}`,
        query: query.toString()
    });
}
// Decode and validate an extension-owned baseline URI before dispatching a read.
function parseBaselineUri(uri) {
    if (uri.scheme !== exports.baselineScheme || uri.authority !== 'loaded') {
        throw vscode.FileSystemError.FileNotFound(uri);
    }
    const segments = uri.path.slice(1).split('/');
    const visibility = segments.shift();
    const dataPath = segments.join('/');
    const query = new URLSearchParams(uri.query);
    const root = query.get('root');
    const revision = query.get('revision');
    const kind = query.get('kind');
    if (!['public', 'private'].includes(visibility || '') || segments.length < 2 || !root || !revision
        || !['baseline', 'empty'].includes(kind || '')) {
        throw vscode.FileSystemError.FileNotFound(uri);
    }
    return {
        root,
        visibility: visibility,
        path: dataPath,
        revision,
        kind: kind
    };
}
// Represent one workspace-data change using the editor's standard SCM resource contract.
class WorkspaceDataResourceState {
    change;
    baselineUri;
    comparisonUri;
    resourceUri;
    command;
    contextValue;
    decorations;
    // Bind protocol metadata to local, baseline, and comparison resources used by SCM and diff views.
    constructor(folder, change, baselineUri, comparisonUri) {
        this.change = change;
        this.baselineUri = baselineUri;
        this.comparisonUri = comparisonUri;
        this.resourceUri = vscode.Uri.joinPath(folder.uri, ...change.workspacePath.split('/'));
        this.command = {
            command: 'workspaceData.openChange',
            title: 'Open Workspace Data Change',
            arguments: [this]
        };
        this.contextValue = change.status;
        const labels = {
            added: ['A', 'Added', 'diff-added'],
            modified: ['M', 'Modified', 'diff-modified'],
            deleted: ['D', 'Deleted', 'diff-removed']
        };
        const [letter, label, icon] = labels[change.status];
        this.decorations = {
            strikeThrough: change.status === 'deleted',
            tooltip: `${label}: ${change.workspacePath}`,
            iconPath: new vscode.ThemeIcon(icon)
        };
        this.command.title = `${letter} ${path.posix.basename(change.path)}`;
    }
}
exports.WorkspaceDataResourceState = WorkspaceDataResourceState;
//# sourceMappingURL=resource.js.map