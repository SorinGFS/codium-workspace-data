// Verify the packaged command surface exposes both publication actions in the SCM toolbar.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));

// Keep the owned-merge command adjacent to ordinary publication with a visible icon.
test('contributes the publish and merge owned toolbar button', () => {
    const command = manifest.contributes.commands.find(
        (candidate) => candidate.command === 'workspaceData.publishAndMergeOwned'
    );
    const menu = manifest.contributes.menus['scm/title'].find(
        (candidate) => candidate.command === 'workspaceData.publishAndMergeOwned'
    );

    assert.equal(command.icon, '$(git-merge)');
    assert.equal(menu.when, 'scmProvider == workspaceData');
    assert.equal(menu.group, 'navigation@4');
});
