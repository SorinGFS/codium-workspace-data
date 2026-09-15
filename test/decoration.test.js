// Verify Explorer decoration mapping without launching an editor extension host.
'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

// Supply only the stable editor value types exercised by decoration mapping.
class FileDecoration {
    constructor(badge, tooltip, color) {
        this.badge = badge;
        this.tooltip = tooltip;
        this.color = color;
    }
}

// Retain theme identifiers so tests can verify theme-aware status colors.
class ThemeColor {
    constructor(id) {
        this.id = id;
    }
}

// Load the compiled repository against a bounded vscode API substitute.
function loadRepositoryClass() {
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'vscode') {
            return { FileDecoration, ThemeColor };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return require('../dist/repository.js').WorkspaceDataRepository;
    } finally {
        Module._load = originalLoad;
    }
}

const WorkspaceDataRepository = loadRepositoryClass();

// Construct only the status state needed by the pure provider callback.
function createRepository(status) {
    const root = path.resolve('decoration-workspace');
    const repository = Object.create(WorkspaceDataRepository.prototype);
    repository.folder = { uri: { scheme: 'file', fsPath: root } };
    repository.report = {
        changes: [{
            id: `private:scripts/${status}.md`,
            visibility: 'private',
            status,
            path: `scripts/${status}.md`,
            workspacePath: `#/private/scripts/${status}.md`,
            baseline: status === 'added' ? { available: false } : { available: true, size: 1 }
        }]
    };
    return {
        repository,
        uri: {
            scheme: 'file',
            fsPath: path.join(root, '#', 'private', 'scripts', `${status}.md`)
        }
    };
}

// Mark modified workspace data with the conventional M and modified theme color.
test('decorates modified files', () => {
    const { repository, uri } = createRepository('modified');
    const decoration = repository.provideFileDecoration(uri);

    assert.equal(decoration.badge, 'M');
    assert.equal(decoration.color.id, 'gitDecoration.modifiedResourceForeground');
});

// Mark newly added workspace data as untracked without decorating absent deletions.
test('decorates added but not deleted files', () => {
    const added = createRepository('added');
    const deleted = createRepository('deleted');

    assert.equal(added.repository.provideFileDecoration(added.uri).badge, 'U');
    assert.equal(added.repository.provideFileDecoration(added.uri).color.id,
        'gitDecoration.untrackedResourceForeground');
    assert.equal(deleted.repository.provideFileDecoration(deleted.uri), undefined);
});
