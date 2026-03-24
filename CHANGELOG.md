# Changelog

All notable changes to SupaBase Jump will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
