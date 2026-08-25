# hey dude!

dude is a lightweight + opinionated orchestration layer for autonomous remote runs of [pi-agent](https://github.com/earendil-works/pi)

I wanted a platform to run llm agents outside of my personal computer, while giving programmatic access to the resources it needs.

It uses 1password to manage required credentials, obsidian for communication and documentation, and discord for one-off triggers.

the agent runs periodically, checking in on tasks in a particular obsidian file.

it's deployed via nix flakes, and exposes three services:
1. periodic triggers (configurable, defaults to every 6 hours)
2. on-demand triggers via discord
3. obsidian sync service via obsidian-headless


credit to brother qt the foster cat for the pfp.

## deployment

This repo contains an action to open a PR to update itself in my [VPS nix repo](https://github.com/johndikeman/dotfiles/tree/vps_nix). pushes to that branch trigger a deploy-rs action which redeploys the configuration, with auto-rollback baked in via nix home-manager.
