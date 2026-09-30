# The Orchestrator

One project manager, **Patches**, runs researchers and builders across all your projects. You start a task, it plans, builds in its own worktree, and comes back to you with a PR to test or a question to answer. Merging is always yours.

It is a plugin for [bb](https://github.com/get-bb/bb) and runs agents on your own Claude Code login.

## Run it

You need a Mac, Node 22+, git, the GitHub CLI (`gh auth login`), and Claude Code signed in (`claude`).

```
git clone https://github.com/samuelshirley/the-orchestrator.git
cd the-orchestrator
npm start
```

That one command installs, starts bb if it is not running, builds and installs the plugin, and opens the app. Run it again any time: work in progress picks up where it left off.

Then open **The Orchestrator** in bb's sidebar. The first time, a setup wizard asks what to call you and which folder The Orchestrator may work in (it suggests `~/Documents/Github`), lists the git repos in that folder so you can tick the ones to add as projects, and says whether GitHub and Claude are signed in.

Or open the folder in Claude Code and say: **"Set up and run this program."** It will run the same command.

## Use it

1. The setup wizard adds your first projects. Later, add more in the left rail: **Add existing folder…** for a repo already on your machine, **Add project** for a new one (a folder in the folder you chose and a private repo on your own GitHub account), or **Set up…** to open the wizard again and change the folder.
2. Press **+** next to Tasks and say what you want. That message is the task's brief.
3. Answer what lands in **Needs you**. Test and merge the PR when it is ready.

## Good to know

- Everything runs on your machine, on your own Claude account and usage limits.
- At most 4 builds run at once, and new work pauses at 90% of your Claude usage or when memory is low.
- The mic needs `brew install ffmpeg` and the Xcode command line tools.

## Develop

```
npm test
npm run typecheck
bb plugin build && bb plugin reload the-orchestrator
```

How it all works: [docs/how-it-works.md](docs/how-it-works.md). What must not break: [CLAUDE.md](CLAUDE.md).
