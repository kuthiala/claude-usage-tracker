# Contributing

Thanks for your interest in improving Claude Usage Monitor!

## How to Report Issues

1. Check existing issues first to avoid duplicates
2. Provide:
   - Clear description of the bug or feature request
   - Steps to reproduce (for bugs)
   - Your browser version and OS
   - Screenshots if applicable

## How to Submit Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Make your changes
4. Test thoroughly:
   - Load unpacked into Chrome
   - Test regular and incognito windows
   - Test with/without Claude tabs open
   - Test auto-refresh if modified
5. Commit with clear messages: `git commit -m "Add feature: brief description"`
6. Push to your fork
7. Open a pull request with:
   - Clear title and description
   - Reference any related issues
   - Explanation of changes

## Code Guidelines

- **No dependencies** — Keep it lightweight, no npm packages needed
- **No minification** — Code should be readable for users to audit
- **Comments** — Only for non-obvious logic
- **Permissions** — Don't add new permissions without strong justification
- **Privacy** — Don't add external API calls or analytics

## Testing Checklist

Before submitting a PR:
- [ ] Extension loads without errors
- [ ] Feature works in regular window
- [ ] Feature works in incognito window
- [ ] No console errors when visiting claude.ai
- [ ] Auto-refresh still works (if modified background.js)
- [ ] Popup displays correctly (if modified popup)
- [ ] Inline bar appears (if modified content.js)

## Release Process

To create a new release:

1. Update version in `manifest.json`
2. Update `README.md` changelog
3. Commit: `git commit -m "Release v1.x.x"`
4. Tag: `git tag v1.x.x`
5. Push: `git push origin main --tags`
6. Create GitHub Release with changelog
7. Users can download and install from the release page

## Questions?

Open a discussion or issue on GitHub!
