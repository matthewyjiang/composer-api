# Repository Instructions

- Use Conventional Commits for every commit message: `<type>: <summary>`.
- Keep commit subjects factual and neutral.
- Do not commit Cursor API keys or private backend origins. Keep them in local environment files or `~/.config/api-for-cursor/config.json` only.

## Restart the running service

The user service loads `dist/`. TypeScript changes do not take effect until you rebuild and restart:

```bash
npm run build && cursor-api service restart
```

Equivalent systemd command:

```bash
npm run build && systemctl --user restart cursor-api.service && systemctl --user --no-pager status cursor-api.service
```
