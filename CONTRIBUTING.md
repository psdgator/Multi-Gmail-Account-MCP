# Contributing

Thanks for helping! Issues and pull requests are welcome at <https://github.com/psdgator/Multi-Gmail-Account-MCP>.

- **Bugs:** include the output of `gmail-mcp-multi doctor` (remove addresses if you like), your OS, your Node version and the MCP client.
- **Security issues:** email antony@psdgator.com instead of opening an issue.
- **Pull requests:**
  1. Read [docs/development.md](docs/development.md) for the architecture.
  2. Keep tools provider-neutral (Gmail and IMAP) where possible.
  3. Never add a sending or deleting tool below `full` mode.
  4. Add tests. `npm test` must pass (it runs offline against fake Gmail/IMAP servers).
  5. If you add or change a tool, run `npm run docs` and commit `docs/tools.md`.
  6. Note user-facing changes in `CHANGELOG.md`.

By contributing you agree that your contributions are licensed under the MIT License.
