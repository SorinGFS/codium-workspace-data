"use strict";
// Define and validate the complete editor-facing contract for workspace-data inspection protocol version 1.
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadOverwritePrompt = void 0;
exports.loadNeedsConfirmation = loadNeedsConfirmation;
exports.parseCapabilities = parseCapabilities;
exports.parseStatusReport = parseStatusReport;
exports.loadOverwritePrompt = 'You have unpublished changes, are you sure you want to overwrite the existing workspace data?';
// Narrow unknown JSON values before any protocol fields are consumed.
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
// Validate one repository summary and its availability/revision invariant.
function parseRepositoryStatus(value) {
    if (!isRecord(value) || !['available', 'missing'].includes(String(value.availability))
        || !(value.baselineRevision === null || typeof value.baselineRevision === 'string')
        || !(value.pullRequest === null || isRecord(value.pullRequest))) {
        throw new Error('Invalid workspace-data repository status.');
    }
    const availability = value.availability;
    const baselineRevision = value.baselineRevision;
    if ((availability === 'available' && !/^[a-f0-9]{40,64}$/.test(baselineRevision || ''))
        || (availability === 'missing' && baselineRevision !== null)) {
        throw new Error('Invalid workspace-data repository baseline.');
    }
    return { availability, baselineRevision, pullRequest: value.pullRequest };
}
// Validate one portable concern-relative path without accepting traversal or platform separators.
function isDataPath(value) {
    return typeof value === 'string' && !value.startsWith('/') && !value.endsWith('/')
        && !value.includes('\\') && value.split('/').length >= 2
        && value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}
// Validate one SCM change and the baseline semantics implied by its status.
function parseChange(value) {
    if (!isRecord(value) || !['public', 'private'].includes(String(value.visibility))
        || !['added', 'modified', 'deleted'].includes(String(value.status)) || !isDataPath(value.path)
        || !isRecord(value.baseline)) {
        throw new Error('Invalid workspace-data change entry.');
    }
    const visibility = value.visibility;
    const status = value.status;
    const dataPath = value.path;
    const available = value.baseline.available;
    const size = value.baseline.size;
    if (value.id !== `${visibility}:${dataPath}` || value.workspacePath !== `#/${visibility}/${dataPath}`
        || typeof available !== 'boolean' || (status === 'added') === available
        || (available && (!Number.isSafeInteger(size) || Number(size) < 0))
        || (!available && size !== undefined)) {
        throw new Error('Invalid workspace-data change entry.');
    }
    return {
        id: value.id,
        visibility,
        status,
        path: dataPath,
        workspacePath: value.workspacePath,
        baseline: available ? { available: true, size: size } : { available: false }
    };
}
// Require load confirmation for detected baseline changes or dirty workspace-data editors.
function loadNeedsConfirmation(report, hasDirtyDocument) {
    return hasDirtyDocument || (report?.state === 'ready' && report.changes.length > 0);
}
// Parse the prerequisite contract and require every behavior consumed by this extension.
function parseCapabilities(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new Error('gh workspace-data returned invalid capability JSON.');
    }
    if (!isRecord(value) || value.command !== 'gh workspace-data'
        || typeof value.version !== 'string' || value.version.length === 0
        || !Array.isArray(value.inspectionProtocolVersions)
        || !value.inspectionProtocolVersions.every((version) => Number.isSafeInteger(version))
        || !value.inspectionProtocolVersions.includes(1) || value.loadBehavior !== 'replace') {
        throw new Error('The installed gh-workspace-data extension does not report the required capabilities.');
    }
    return {
        command: 'gh workspace-data',
        version: value.version,
        inspectionProtocolVersions: value.inspectionProtocolVersions,
        loadBehavior: 'replace'
    };
}
// Parse exactly one supported status response and reject structurally unsafe or contradictory data.
function parseStatusReport(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new Error('gh workspace-data returned invalid JSON.');
    }
    if (!isRecord(value) || value.protocolVersion !== 1) {
        throw new Error(`Unsupported workspace-data inspection protocol version: ${isRecord(value) ? String(value.protocolVersion) : 'unknown'}.`);
    }
    if (typeof value.projectIdentity !== 'string'
        || !['ready', 'notInitialized', 'reloadRequired'].includes(String(value.state))
        || !isRecord(value.repositories) || !Array.isArray(value.changes)) {
        throw new Error('Invalid workspace-data status response.');
    }
    const state = value.state;
    const repositories = {};
    if (state === 'ready') {
        repositories.public = parseRepositoryStatus(value.repositories.public);
        repositories.private = parseRepositoryStatus(value.repositories.private);
    }
    else if (Object.keys(value.repositories).length !== 0 || value.changes.length !== 0) {
        throw new Error(`Invalid workspace-data ${state} response.`);
    }
    const changes = value.changes.map(parseChange);
    const identifiers = new Set(changes.map((change) => change.id));
    if (identifiers.size !== changes.length || (state !== 'ready' && changes.length !== 0)) {
        throw new Error('Invalid duplicate or unavailable workspace-data changes.');
    }
    return {
        protocolVersion: 1,
        projectIdentity: value.projectIdentity,
        state,
        repositories,
        changes
    };
}
//# sourceMappingURL=model.js.map