# Workspace Data for VSCodium

Review materialized [`gh-workspace-data`](https://github.com/SorinGFS/gh-workspace-data) files in VSCodium or VS Code using native Source Control and diff editors.

The extension creates one **Workspace Data** Source Control provider for each workspace folder containing `#/.data-state.json`. It shows deterministic `added`, `modified`, and `deleted` files in separate **Public Changes** and **Private Changes** groups. Selecting a file compares it with the exact revision recorded by the last successful load or publish.

## Requirements

- VSCodium or VS Code 1.85 or newer
- GitHub CLI with the `SorinGFS/gh-workspace-data` extension installed
- A local file workspace hosted in a Git repository
- Synchronization state version 2, produced by `gh workspace-data` 0.6.0 or newer

No second Git repository is created under `#/`, and the editor does not determine repository mappings or query the latest remote revision. Mapping, authentication, baselines, loading, and publication remain owned by `gh-workspace-data`.

## Commands

- **Workspace Data: Load**
- **Workspace Data: Refresh**
- **Workspace Data: Publish**
- **Workspace Data: Publish and Merge Owned**

Refresh runs the local-only `gh workspace-data status --json` protocol. Baseline documents are fetched lazily with `gh workspace-data show`, verified by that command, cached under immutable revision-bearing URIs, and exposed through a read-only file system provider.

## Privacy

The extension has no telemetry. It sends no requests itself; authenticated baseline reads and synchronization operations are delegated to the installed GitHub CLI extension.

## Open VSX

The package uses only stable extension APIs and is intended for publication to [Open VSX](https://open-vsx.org/).
