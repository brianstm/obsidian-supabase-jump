# Changelog

All notable changes to SupaBase Jump will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.2]: https://github.com/brianstm/obsidian-supabase-jump/releases/tag/1.0.2
[1.0.3]: https://github.com/brianstm/obsidian-supabase-jump/releases/tag/1.0.3