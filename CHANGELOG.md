# Changelog

All notable changes to SupaBase Jump will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-11-20

Run **Database setup → Run setup** again after updating (or paste the new SQL by hand). Everything keeps working without it, but version history, private live channels and smarter conflict handling need it.

### Added

- Colored cursors and selections for your other devices while live editing, plus small badges showing who has the note open
- Version history for every note, with preview and one click restore
- Restore notes that were deleted on any device
- Conflict copies when a note changed on two devices before they could sync, so nothing gets overwritten
- A clickable status bar with quick actions, and a ribbon button for mobile
- Device names, shown in live editing, history and conflict copies
- A file size limit so huge files don't eat your storage
- Option to sync or skip open tabs and layout (skipped by default)
- Version history entry in the file menu and new commands for history, restoring, reconnecting and copying the setup SQL
- Settings now use Obsidian's new settings layout, so every option shows up in settings search
- A self-hosting guide covering Linux, macOS, Windows, Raspberry Pi and NAS, with HTTPS options for mobile

### Changed

- Live editing was rebuilt on top of the editor itself. Edits are applied exactly as typed, which keeps cursors steady and works with split panes
- Typing is batched into small packets so live editing stays smooth and stays under Realtime limits
- Big notes are split into chunks so they can be shared live too
- Each device now keeps a small sync index. Files are only uploaded when their content really changed, which stops two devices from bouncing the same file back and forth
- Changes that come in while the app was closed are fetched incrementally instead of downloading the whole vault every time
- Renaming an attachment now moves it in storage instead of uploading it again
- One-click setup now does everything in a single step, including the storage bucket
- Password and access token moved to Obsidian's secret storage. Existing values are moved over for you
- Sign in no longer stores a session in local storage
- The plugin no longer syncs its own settings file between devices
- Minimum Obsidian version is now 1.13.2
- License is now plain MIT

### Fixed

- Opening the same note on two devices at the same time could double its text
- Full sync stopped after the first 1000 files
- Deletes and renames made while offline were never sent
- Failed uploads were dropped instead of retried, so offline edits could be lost
- Folder deletes and renames only touched the folder, not the files inside
- After waking an iPhone, live editing could stay disconnected until the note was reopened
- Platform specific settings never matched their files, so they synced everywhere anyway
- Every upload asked the auth server who you were, which slowed down big syncs
- Typing a wrong password could create a confusing new account prompt instead of saying the password was wrong
- The manual setup SQL in settings was out of date
- Background polling now pauses while the app is hidden to save battery

## [1.1.7] - 2026-07-31

### Fixed

- ESLint fix and checks

## [1.1.6] - 2026-07-31

### Fixed

- **iOS Realtime recovery** - When Obsidian is backgrounded or the screen dims, iOS kills the Realtime WebSocket. The plugin now reconnects on foreground resume (`visibilitychange` / `focus`), force-resets the socket, and runs a silent catch-up pull so external writes are not missed
- **Fallback polling while disconnected** - If the Realtime channel stays down, a 15s silent `fetchOnly` loop keeps pulling remote changes until the channel resubscribes
- Disconnect notices are throttled to once per 60s to avoid spam on iOS

## [1.1.5] - 2026-03-25

### Fixed

- ESLint fixs

## [1.1.4] - 2026-03-24

### Fixed

- `.DS_Store` and other OS system files (e.g. `Thumbs.db`, `desktop.ini`) are now silently skipped instead of crashing with a Postgres null-byte error
- Binary extension list expanded to cover cryptographic signatures (`.sig`, `.key`, `.p12`), databases (`.db`, `.sqlite`), and executables so they are stored in Storage rather than the text column
- Simultaneous edits on two devices no longer get overwritten: `postgres_changes` pulls are now skipped while a Yjs CRDT session is active, letting the CRDT broadcast layer own all merging during co-editing
- Yjs-merged state is persisted to disk when closing a note so `mtime`-based conflict resolution sees up-to-date content on the next sync
- `.obsidian/` and other config-dir files were always pulled (local `mtime` was treated as 0); now resolved using `vault.adapter.stat` for accurate comparison
- Realtime channel reconnects automatically on `CHANNEL_ERROR`, `TIMED_OUT`, or `CLOSED` status
- Push debounce reduced from 2 s to 1 s for snappier propagation

## [1.1.3] - 2026-03-19

### Fixed

- ESLint fixs

## [1.1.2] - 2026-03-19

### Fixed

- ESLint fixs

## [1.1.1] - 2026-03-19

### Fixed

- Fixed the bug where if DB has newer content than local disk, the local disk will be overwritten with the DB content even if the user has edited the file locally.

## [1.1.0] - 2026-03-18

### Added

- **Real-time collaborative editing** - Two devices using the same account can now edit the same note simultaneously without conflicts. Yjs CRDTs are used for automatic, conflict-free merging; updates are broadcast ephemerally over a Supabase Realtime channel so the database is not bloated. Syncs instantly as you type with a character-level patches to the editor (no full replace, no duplication).
- **Platform-specific config paths** - Settings now include a toggle panel listing the most common Obsidian config files (`appearance.json`, `themes/`, `snippets/`, `plugins/`, `community-plugins.json`, `hotkeys.json`, `workspace.json`). Toggle a path to make it sync only to the current platform (mobile or desktop). A free-text "Custom paths" field covers anything not in the list.
- **`platform` column in `vault_files`** - Each row is tagged as `'all'`, `'mobile'`, or `'desktop'`. Pull operations skip rows tagged for a different platform.

## [1.0.7] - 2026-03-17

### Fixed

- UI name capitalization
- ESLint fixs

## [1.0.6] - 2026-03-17

### Added

- **Frontmatter parsing** - Markdown frontmatter properties and tags are now extracted on every push and stored in dedicated `frontmatter` (jsonb) and `tags` (text[]) columns in `vault_files`, enabling rich SQL queries directly from your Supabase dashboard (e.g. filter by tag, author, status, date, etc.)
- **Config folder sync** - The `.obsidian/` directory is now synced automatically, including themes, appearance settings, snippets, and other plugin config files
    - A 5-second polling watcher detects changes Obsidian writes directly to disk (bypasses vault events)
    - Toggle on/off per vault via **Settings → Sync config folder** (default: on)
    - Works with the full Obsidian config directory regardless of its configured name

### Changed

- Database schema: `vault_files` gains `frontmatter jsonb` and `tags text[]` columns; existing tables are migrated automatically via `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
- A GIN index on `tags` is created for fast array queries

## [1.0.5] - 2026-03-16

### Fixed

- UI name capitalization
- ESLint fixs

## [1.0.4] - 2026-03-16

### Fixed

- UI name capitalization
- ESLint fixs

## [1.0.3] - 2026-03-16

### Fixed

- UI name capitalization

## [1.0.2] - 2026-03-16

### Added

- **Real-time sync** with Supabase using PostgreSQL Realtime
- **Binary file support** via Supabase Storage (images, PDFs, etc.)
- **Text file sync** stored directly in PostgreSQL
- **One-click setup** via Supabase Management API
    - Automatic database table creation
    - Automatic storage bucket creation
    - Automatic RLS policy setup
    - Automatic Realtime publication configuration
- **Authentication** with Supabase Auth (email/password)
    - Auto sign-up if account doesn't exist
    - Email confirmation support
- **Conflict resolution** based on modification time (higher mtime wins)
- **Selective sync** with excluded folders support
- **Status bar indicator** showing connection state (🔴/🟢/🔄/⚠️)
- **Manual sync controls**
    - "Sync now" button (full two-way sync)
    - "Fetch now" button (pull-only sync)
- **Command palette integration**
    - "Force sync now"
    - "Fetch from database"
    - "Show sync status"
- **Automatic sync**
    - Sync on startup (optional)
    - Periodic sync with configurable interval (0-60 minutes)
    - Debounced local file change detection (2 seconds)
- **Vault event listeners**
    - File create, modify, delete, rename
    - Echo-loop prevention for remote-triggered writes
- **Mobile support** (iOS and Android)
    - Uses Obsidian's `requestUrl` API for CORS-free networking
    - No Node.js built-ins (pure Web APIs)
- **Base64url encoding** for storage keys to handle special characters in filenames
- **Settings UI**
    - Initial setup section with progress feedback
    - Credential management
    - Vault ID auto-generation
    - Excluded folders configuration
    - Sync interval slider
    - Last sync timestamp display
    - Manual setup guide (fallback)

### Technical Details

- **Database schema**: `vault_files` table with RLS policies
- **Storage bucket**: `vault-attachments` (private)
- **Realtime**: PostgreSQL publication on `vault_files`
- **Row ID format**: `{vaultId}::{filePath}` (slashes → `__SLASH__`)
- **Storage key format**: `{userId}/{vaultId}/{base64url(filePath)}{ext}`
- **Build system**: esbuild (ES2018 target, CJS output)
- **Type checking**: TypeScript with strict mode
- **Linting**: ESLint with Obsidian plugin

### Known Limitations

- No merge conflict UI (last-write-wins only)
- No version history (single-version sync)
- No selective file sync (all-or-nothing per folder)
- Supabase Management API bucket creation may fail on some project types (manual fallback provided)
