# Installing Caret

Caret builds are **not signed with a paid certificate yet**, so each OS will ask
you to confirm the first launch. The steps below are the current ones for each
platform — several widely-copied instructions no longer work on recent macOS.

## macOS

Download the `.zip` for your chip (`arm64` for Apple Silicon, `x64` for Intel),
unzip it, and move `Caret.app` to `/Applications`.

On first launch macOS will say Caret **"cannot be opened because Apple cannot
check it for malicious software"**.

**macOS 15 (Sequoia) and later:**

1. Try to open Caret. Dismiss the warning.
2. Open **System Settings → Privacy & Security**.
3. Scroll to Security. There will be a line about Caret being blocked, with an
   **Open Anyway** button. Click it.
4. Authenticate, then confirm **Open Anyway** in the dialog that follows.

Sequoia removed the old Control-click → Open bypass, so instructions telling you
to right-click the app will not work. The Privacy & Security route is the only
one.

**macOS 14 and earlier:** Control-click `Caret.app` → **Open** → **Open**.

You only have to do this once.

### "Caret is damaged and can't be opened"

This is what an **unsigned arm64 binary** looks like, not a corrupt download.
Every Apple Silicon binary must carry at least an ad-hoc signature to execute at
all. Caret's builds are ad-hoc signed, so if you see this, the download was
genuinely truncated — re-download it.

If you built from source yourself, sign the app before running it:

```bash
codesign --force --deep --sign - /Applications/Caret.app
```

## Windows

Download the `.exe` installer and run it. SmartScreen will show **"Windows
protected your PC"**: click **More info**, then **Run anyway**.

A portable `.exe` is also published if you would rather not install.

## Linux

**AppImage** — download, make it executable, run it:

```bash
chmod +x Caret-*.AppImage
./Caret-*.AppImage
```

**Debian / Ubuntu:**

```bash
sudo dpkg -i caret_*.deb
```

**Fedora / RHEL:**

```bash
sudo rpm -i caret-*.rpm
```

## What Caret needs on your machine

- **Node.js 20+** and **npm** — Caret installs the design layer's own
  dependencies into your project's `.caret/` directory on first open, which
  takes about a minute.
- **git** — the design→app sync bookmark is a commit hash, and the "Undo sync"
  snapshot is a git object. Caret works without git, but sync does not.
- **An MCP-capable agent**, if you want one. Everything in the editor works
  without one. See [connect-an-agent.md](connect-an-agent.md).

## Building from source

```bash
npm install
npm run build
npm run package        # or package:mac / package:win / package:linux
```

Artifacts land in `release/`.
