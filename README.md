# Workspace Data for VSCodium

Review materialized [`gh-workspace-data`](https://github.com/SorinGFS/gh-workspace-data) files in VSCodium or VS Code using native Source Control and diff editors.

The extension creates one **Workspace Data** Source Control provider for each workspace folder containing `#/.data-state.json`. It shows deterministic `added`, `modified`, and `deleted` files in separate **Public Changes** and **Private Changes** groups. Selecting a file compares it with the exact revision recorded by the last successful load or publish.

## Requirements

- VSCodium or VS Code 1.85 or newer
- GitHub CLI with the `SorinGFS/gh-workspace-data` extension installed
- A local file workspace hosted in a Git repository
- `gh workspace-data capabilities --json` reporting inspection protocol 1 and replacement-style loading

No second Git repository is created under `#/`, and the editor does not determine repository mappings or query the latest remote revision. Mapping, authentication, baselines, loading, and publication remain owned by `gh-workspace-data`.

## Usage

<details>
<summary><strong>Install, reveal the provider, inspect changes, and synchronize data</strong></summary>

This extension assumes the target project is managed by `gh-workspace-data`. See the [`gh-workspace-data` documentation](https://github.com/SorinGFS/gh-workspace-data#readme) for initialization, repository selection, loading, and publication behavior.

If GitHub CLI is unavailable, the extension offers to open its setup page. If `gh-workspace-data` is missing or does not report the required capabilities, the extension offers **Install or Upgrade** and **View Documentation**. Compatibility is determined from the reported inspection protocol and Load behavior rather than from the package version label. It runs `gh extension install SorinGFS/gh-workspace-data --force` only after the user explicitly selects **Install or Upgrade**; it never installs user-wide software silently.

Before Load or either Publish command, the extension checks the active GitHub CLI authentication for `github.com`. If authentication is unavailable, it offers **Open Authentication Setup** instead of starting the operation. Complete authentication in GitHub CLI, then run the command again.

### 1. Install and activate the editor extension

Download the VSIX from the [latest GitHub release](https://github.com/SorinGFS/codium-workspace-data/releases/latest), then use **Extensions: Install from VSIX...** or:

```sh
codium --install-extension codium-workspace-data-<version>.vsix
```

Open the target project's repository folder and run **Developer: Reload Window** after installation. The extension creates one **Workspace Data** Source Control provider for every open local workspace folder containing ordinary `#/.data-state.json` state.

### 2. Reveal Workspace Data in Source Control

Open Source Control with `Ctrl+Shift+G`. If only the Git repository is visible, reveal the Source Control **Repositories** view and select **Workspace Data**. Its **Public Changes** and **Private Changes** groups are hidden while clean and appear when their visibility contains changes.

The Workspace Data provider intentionally has no commit input box. Publishing is a pull-request operation owned by `gh-workspace-data`, not a Git commit in the target project.

### 3. Review changes

Add, edit, or delete ordinary files under:

```text
#/public/<concern>/...
#/private/<concern>/...
```

Saved filesystem changes trigger a debounced local refresh. The appropriate Source Control group then shows each file as added, modified, or deleted. Explorer marks existing modified files with `M` and newly added files with `U`, using the corresponding theme colors. Deleted paths remain visible in Source Control but cannot carry an Explorer badge because the filesystem entry no longer exists.

Select a resource to open a native two-way diff against the exact baseline recorded by the last successful load or publish. Modified files also support the editor's quick-diff gutter. Added files compare with an empty baseline, and deleted files compare their loaded baseline with an empty result.

Use **Workspace Data: Refresh** when an explicit refresh is useful. Refresh is local-only and does not query GitHub for a newer revision.

### 4. Understand Load

**Workspace Data: Load** replaces existing public and private workspace data with the selected remote snapshots. Immediately before invoking Load, the extension refreshes local status and also checks dirty workspace-data editors. When it finds unpublished changes, it asks:

> You have unpublished changes, are you sure you want to overwrite the existing workspace data?

Choose **Overwrite** to discard those changes and continue, or cancel to retain them. After a successful Load, the extension immediately reloads the same active workspace-data editor from disk only if its model did not change while Load was running. If the model changed, the extension preserves its in-memory contents and warns you to review them instead of silently reverting the newer edits. Running `gh workspace-data load` directly has no editor confirmation; see the [`gh-workspace-data` documentation](https://github.com/SorinGFS/gh-workspace-data#readme) for command behavior.

### 5. Publish

Use **Workspace Data: Publish** to create or update pull requests for changed public and private data. Use the adjacent **Workspace Data: Publish and Merge Owned** toolbar button only when actor-owned pull requests should be merged immediately where repository rules permit it. Per-workspace locking prevents overlapping load and publication operations.

If a refresh or synchronization operation fails, open **View: Toggle Output** and select **Workspace Data** for the CLI diagnostic.

</details>

## Commands

- **Workspace Data: Load**
- **Workspace Data: Refresh**
- **Workspace Data: Publish**
- **Workspace Data: Publish and Merge Owned**

Refresh runs the local-only `gh workspace-data status --json` protocol. Baseline documents are fetched lazily with `gh workspace-data show`, verified by that command, cached under immutable revision-bearing URIs, and exposed through a read-only file system provider.

## Privacy

The extension has no telemetry and implements no direct network client. It invokes GitHub CLI for authentication checks and delegates authenticated baseline reads and synchronization operations to the installed `gh-workspace-data` extension.

## Open VSX

The package is intended for publication to [Open VSX](https://open-vsx.org/).
