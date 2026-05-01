# GitHub Setup Guide

## One-Time Setup

### 1. Create Repository on GitHub
- Go to https://github.com/new
- Repository name: `claude-usage-tracker`
- Description: "Real-time Claude.ai usage monitoring with auto-refresh. Track 5-hour sessions, weekly limits, and Opus quotas."
- Choose: **Public** (so users can download and audit code)
- Add .gitignore: **None** (we have our own)
- Add license: **MIT** (we have our own)
- Click **Create repository**

### 2. Initialize Local Git

```bash
cd /Users/A.Kuthiala/Downloads/claude-usage-monitor

# Initialize git (if not already initialized)
git init

# Add all files
git add .

# Initial commit
git commit -m "Initial commit: Claude Usage Tracker v1.0.0"

# Add remote (replace YOUR_USERNAME)
git remote add origin https://github.com/YOUR_USERNAME/claude-usage-monitor.git

# Push to GitHub
git branch -M main
git push -u origin main
```

### 3. Create First Release

```bash
# Tag the current commit as v1.0.0
git tag v1.0.0

# Push the tag to GitHub
git push origin v1.0.0
```

This will automatically trigger the GitHub Actions workflow to create a release with a downloadable zip file.

---

## Future Releases

### When you want to release a new version:

1. **Update version** in `manifest.json`:
   ```json
   "version": "1.4.0"
   ```

2. **Update changelog** in `README.md`

3. **Commit changes**:
   ```bash
   git add manifest.json README.md
   git commit -m "Release v1.4.0"
   ```

4. **Tag and push**:
   ```bash
   git tag v1.4.0
   git push origin main
   git push origin v1.4.0
   ```

5. **GitHub Actions automatically**:
   - Creates the release page
   - Generates `claude-usage-monitor.zip`
   - Users can download from the Release tab

---

## What Users See

On your GitHub repo's "Releases" tab, users will see:

```
v1.3.0 (Latest)
├─ Release notes (from git tag message)
└─ claude-usage-monitor.zip (automatic)

v1.2.0
├─ Release notes
└─ claude-usage-monitor.zip
```

Users download the zip and follow the README installation steps.

---

## Sharing the Link

Share this in blogs, forums, etc:
```
https://github.com/YOUR_USERNAME/claude-usage-monitor/releases
```

Or direct link to latest:
```
https://github.com/YOUR_USERNAME/claude-usage-monitor/releases/download/v1.3.0/claude-usage-monitor.zip
```
