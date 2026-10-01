# Workspace Data for VSCodium

Review materialized [`gh-workspace-data`](https://github.com/SorinGFS/gh-workspace-data) files in VSCodium or VS Code using native Source Control and diff editors.

The extension creates one **Workspace Data** Source Control provider for each workspace folder containing `#/.data-state.json`. It shows deterministic `added`, `modified`, and `deleted` files in separate **Public Changes** and **Private Changes** groups. Selecting a file compares it with the exact revision recorded by the last successful load or publish.

## Requirements

- VSCodium or VS Code 1.85 or newer
- GitHub CLI with the `SorinGFS/gh-workspace-data` extension installed
- A local file workspace hosted in a Git repository
- `gh workspace-data capabilities --json` reporting inspection and canonical-identity protocols 1, publication-result protocol 2, `publicationStatePersistence: "cli"`, and replacement-style loading (provided by gh-workspace-data 0.10.0)

No second Git repository is created under `#/`, and the editor does not determine repository mappings or query the latest remote revision. Mapping, authentication, authoritative publication/baseline metadata, loading, and remote publication remain owned by `gh-workspace-data`. The CLI is the sole writer of `.data-state.json`. Codium owns only a disposable, read-only derived SCM index.

## Usage

<details>
<summary><strong>Install, reveal the provider, inspect changes, and synchronize data</strong></summary>

This extension assumes the target project is managed by `gh-workspace-data`. See the [`gh-workspace-data` documentation](https://github.com/SorinGFS/gh-workspace-data#readme) for initialization, repository selection, loading, and publication behavior.

If GitHub CLI is unavailable, the extension offers to open its setup page. If `gh-workspace-data` is missing or does not report the required capabilities, the extension offers **Install or Upgrade** and **View Documentation**. Compatibility is determined from the reported inspection, identity, publication-result protocols, CLI-owned checkpoint persistence, and Load behavior rather than from the package version label. It runs `gh extension install SorinGFS/gh-workspace-data --force` only after the user explicitly selects **Install or Upgrade**; it never installs user-wide software silently.

Before Load or either Publish command, the extension checks the active GitHub CLI authentication for `github.com`. If authentication is unavailable, it offers **Open Authentication Setup** instead of starting the operation. Complete authentication in GitHub CLI, then run the command again.

### 1. Install and activate the editor extension

In VSCodium, install directly from Open VSX through the editor interface:

1. Open **Extensions** with `Ctrl+Shift+X`.
2. Search for `SorinGFS.codium-workspace-data`.
3. Select **Workspace Data** by **SorinGFS** and choose **Install**.

An Open VSX installation receives later releases according to the editor's extension auto-update settings.

Stock VS Code does not use Open VSX. For VS Code, or for a manual VSCodium installation, download the VSIX from the [latest GitHub release](https://github.com/SorinGFS/codium-workspace-data/releases/latest) and run **Extensions: Install from VSIX...** from the Command Palette. Manually installed VSIX copies normally require manual updates unless **Auto Update** is explicitly enabled for the extension. The corresponding command-line installations are:

```sh
codium --install-extension codium-workspace-data-<version>.vsix
code --install-extension codium-workspace-data-<version>.vsix
```

Open the target project's repository folder. The extension creates one **Workspace Data** Source Control provider for every open local workspace folder containing an ordinary `#/.data-state.json` file. If a provider does not appear immediately after installation, run **Developer: Reload Window** once.

### 2. Reveal Workspace Data in Source Control

Open Source Control with `Ctrl+Shift+G`. If only the Git repository is visible, reveal the Source Control **Repositories** view and select **Workspace Data**. Its **Public Changes** and **Private Changes** groups are hidden while clean and appear when their visibility contains changes.

The Workspace Data provider intentionally has no commit input box. Publishing is a pull-request operation owned by `gh-workspace-data`, not a Git commit in the target project.

### 3. Review changes

Add, edit, or delete ordinary files under:

```text
#/public/<concern>/...
#/private/<concern>/...
```

Saved filesystem changes trigger a debounced, single-flight local refresh. After initial reconciliation, the in-memory SCM index rehashes only invalidated files/subtrees; decoration and quick-diff lookups use a path cache. The appropriate Source Control group then shows each file as added, modified, or deleted. Explorer marks existing modified files with `M` and newly added files with `U`, using the corresponding theme colors. Deleted paths remain visible in Source Control but cannot carry an Explorer badge because the filesystem entry no longer exists.

Select a resource to open a native two-way diff against the exact baseline recorded by the last successful load or publish. Modified files also support the editor's quick-diff gutter. Added files compare with an empty baseline, and deleted files compare their loaded baseline with an empty result.

Use **Workspace Data: Refresh** when an explicit refresh is useful. Manual refresh and window refocus reread and fingerprint `.data-state.json` before completely reconciling local files, recovering missed data and metadata watcher events. Ordinary refreshes check a lightweight state-file signature; external checkpoint changes invalidate the derived baseline. Refresh verifies the canonical project identity locally but does not query GitHub for a newer revision.

### 4. Understand Load

**Workspace Data: Load** replaces existing public and private workspace data with the selected remote snapshots. Immediately before invoking Load, the extension refreshes local status and also checks dirty workspace-data editors. When it finds unpublished changes, it asks:

> You have unpublished changes, are you sure you want to overwrite the existing workspace data?

Choose **Overwrite** to discard those changes and continue, or cancel to retain them. After a successful Load, the extension immediately reloads the same active workspace-data editor from disk only if its model did not change while Load was running. If the model changed, the extension preserves its in-memory contents and warns you to review them instead of silently reverting the newer edits. Running `gh workspace-data load` directly has no editor confirmation; see the [`gh-workspace-data` documentation](https://github.com/SorinGFS/gh-workspace-data#readme) for command behavior.

### 5. Publish

Use **Workspace Data: Publish** to create or update pull requests for changed public and private data. Use the adjacent **Workspace Data: Publish and Merge Owned** toolbar button only when actor-owned pull requests should be merged immediately where repository rules permit it. Publication progress appears in the Source Control view without opening a cancellable notification. Per-workspace locking prevents overlapping load and publication operations.

Neither publication command loads or replaces `#/public` or `#/private`. The CLI atomically persists each successful metadata checkpoint before emitting protocol-2 JSON Lines notifications. Codium observes those notifications and reads the durable checkpoint to update its cached SCM baseline; it never writes `.data-state.json`. Files edited after capture remain modified. Successful checkpoints survive another visibility's failure, a deferred merge, or a notification-consumer failure. The CLI rejects differing upstream project trees before pushing rather than silently loading them; preserve local edits before an explicit, overwrite-confirmed Load.

The CLI holds `.data-state.lock` throughout initialization, Load, publication, and merging, preventing overlapping terminal/editor synchronization. Codium defers reconciliation while that lock exists and responds to its release. If an interrupted process leaves the lock behind, verify that no operation is running before removing that ordinary lock file. State-fingerprint mismatches stop metadata replacement rather than overwriting external changes.

If a refresh or synchronization operation fails, open **View: Toggle Output** and select **Workspace Data** for the CLI diagnostic.

### 6. Continue after merging in GitHub

For the normal review-first editor workflow:

1. Save and review changes, then choose **Workspace Data: Publish**.
2. Review and merge the PRs in GitHub.
3. Continue editing in Codium. No Load is required solely because you merged your own published changes, provided the merged project data matches what you published.
4. Publish the next changes. An open PR is updated; after it is merged, the next changed publication creates a new PR. Publishing unchanged data does not create a new PR.

The published snapshot already became the local baseline when the CLI persisted its checkpoint, before the manual merge. Edits made after capture remain local changes. GitHub merges are not automatically polled: **Refresh** reconciles local files against the recorded baseline but neither fetches remote data nor clears merged PR metadata.

For a recorded, unchanged actor-owned PR, **Publish and Merge Owned** verifies its recorded head and can acknowledge a completed manual GitHub merge without merging again or loading. A changed publication replaces that visibility's old PR metadata; public and private metadata are independent. Non-owned PRs remain review-first. Use Load to reconcile their merged metadata when you intend to receive the selected remote snapshots, preserving unpublished work first.

Use **Load** when you want the selected remote snapshots, including other people's changes, or want to reconcile merged PR metadata. It replaces local data rather than combining changes. Publish or back up work you still need before loading; after a remote-content mismatch, preserve local edits, load, and reapply the intended changes.

### 7. Distinguish editor publication from terminal publication

The editor's **Publish** runs `gh workspace-data publish`; **Publish and Merge Owned** runs `gh workspace-data publish --merge-owned`. Given the same workspace, authentication, and repository overrides, direct CLI calls and editor commands use identical remote logic and CLI-owned checkpoint persistence.

You can alternate either publication mode between the terminal and editor without an intervening Load. Commands in Codium's integrated terminal also update the shared checkpoint. Codium detects disk changes rather than consuming that terminal's stdout; use **Refresh** if a watcher update was missed. Terminal operations cannot silently overlap editor synchronization because the CLI rejects competing operations through its shared lock.

The remaining interface differences are presentation and Load protection: editor commands show native progress and diagnostics; **Workspace Data: Load** checks saved and dirty-editor changes and asks before overwriting, while terminal `gh workspace-data load` has no editor confirmation. Both Load variants replace data, so preserve unpublished work first.

See the CLI documentation's [interface comparison](https://github.com/SorinGFS/gh-workspace-data#terminal-publication-versus-editor-publication) and [publication-cycle guidance](https://github.com/SorinGFS/gh-workspace-data#loading-and-publication) for the complete workflows.

</details>

## Commands

- **Workspace Data: Load**
- **Workspace Data: Refresh**
- **Workspace Data: Publish**
- **Workspace Data: Publish and Merge Owned**

Refresh uses Codium's local in-memory index against the CLI-owned baseline. `gh workspace-data status --json` remains available as an independent full local verification command. Baseline documents are fetched lazily with `gh workspace-data show`, verified by that command, cached under immutable revision-bearing URIs, and exposed through a read-only file system provider.

## Privacy

The extension has no telemetry and implements no direct network client. It invokes GitHub CLI for authentication checks and delegates authenticated baseline reads and synchronization operations to the installed `gh-workspace-data` extension.

## Upgrade compatibility

Use Codium 0.2.0 with gh-workspace-data 0.10.0 or newer reporting protocol 2 and CLI-owned persistence. Earlier protocol-1 editors expect to write publication checkpoints and are incompatible with this ownership change. Upgrade both components and reload the editor window before publishing. Existing valid version-2 state requires no destructive Load merely to upgrade.

## Open VSX

The extension is published in the [Open VSX Registry](https://open-vsx.org/extension/SorinGFS/codium-workspace-data). Each Open VSX release uses the same VSIX artifact attached to its corresponding GitHub release.
