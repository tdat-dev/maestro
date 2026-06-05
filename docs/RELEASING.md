# Releasing Maestro (auto-update)

Maestro ships with the Tauri updater. An installed app checks
`https://github.com/tdat-dev/maestro/releases/latest/download/latest.json` on
launch and, if a newer **signed** build exists, prompts the user to install it.

> Change the endpoint in `src-tauri/tauri.conf.json` → `plugins.updater.endpoints`
> if your GitHub owner/repo is not `tdat-dev/maestro`.

## One-time setup

1. **Signing key** — already generated at `.tauri/maestro_updater.key` (private,
   gitignored) with its public key baked into `tauri.conf.json`. **Back this file
   up somewhere safe.** If you lose it, existing installs can never be updated.
2. **GitHub repo** — create `tdat-dev/maestro` on GitHub and push:
   ```powershell
   git remote add origin https://github.com/tdat-dev/maestro.git
   git push -u origin master
   ```
   The repo (or at least its **Releases**) must be **public** — the updater
   fetches the manifest and installer assets without auth. A private repo will
   make auto-update fail for end users.
3. **Install the updater-enabled build once.** The very first `0.1.0` you
   installed had no updater inside it, so it cannot self-update. Install the new
   signed `…-setup.exe` (below) once, manually. From then on updates are automatic.

## Cutting a new version

1. **Bump the version** in all three to the same value (e.g. `0.1.1`):
   - `package.json` → `version`
   - `src-tauri/tauri.conf.json` → `version`
   - `src-tauri/Cargo.toml` → `[package] version`

2. **Build, signed** (PowerShell, from the project root):
   ```powershell
   $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content ".tauri/maestro_updater.key" -Raw
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
   npm run tauri build
   ```
   This produces, under `src-tauri/target/release/bundle/nsis/`:
   - `maestro_<ver>_x64-setup.exe` — the installer
   - `maestro_<ver>_x64-setup.exe.sig` — its signature (a short base64 string)

3. **Write `latest.json`** (paste the entire contents of the `.sig` file into
   `signature`):
   ```json
   {
     "version": "0.1.1",
     "notes": "What changed in this release",
     "pub_date": "2026-06-05T00:00:00Z",
     "platforms": {
       "windows-x86_64": {
         "signature": "<paste contents of maestro_0.1.1_x64-setup.exe.sig>",
         "url": "https://github.com/tdat-dev/maestro/releases/download/v0.1.1/maestro_0.1.1_x64-setup.exe"
       }
     }
   }
   ```

4. **Publish a GitHub Release** tagged `v0.1.1` and upload **two** assets:
   - `maestro_0.1.1_x64-setup.exe`
   - `latest.json`

   Mark it as the **latest** release. Done — open Maestro on any install and it
   will offer the update.

## Easier long-term: GitHub Actions

Instead of the manual steps above, the `tauri-apps/tauri-action` GitHub Action
builds, signs, generates `latest.json`, and publishes the release automatically
on every tag push. Store the private key as the repo secret
`TAURI_SIGNING_PRIVATE_KEY` (and an empty `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
Ask and I'll wire the workflow file.
