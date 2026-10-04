<p align="center">
  <img src="assets/artboard-logo.svg" alt="Artboard logo" width="144">
</p>

<h1 align="center">Artboard</h1>

<p align="center"><strong>A canvas for AI agents. A new adventure in every frame.</strong></p>

## Why I am building this

As a kid, I was fascinated by graphical adventures. A few colours and a handful of pixels could turn a screen into a world worth exploring. Every room suggested a story, every strange object might matter later, and every unopened door was an invitation.

That fascination never left me. Years later, I decided to build an adventure of my own, with a possibility I could only have imagined back then: a world created as you play, where the story and its scenes can unfold differently every time.

That project is **Adventure**, an AI-powered graphical adventure generator inspired by the spirit of the games I grew up with. **Artboard** is its drawing component: the canvas and tools that let agents bring those worlds into view.

## What is Artboard?

Artboard is a drawing toolkit for composing scenes with the visual character of 1980s graphical adventures. It gives an AI agent explicit drawing operations, so the agent can build a scene from shapes, lines, colours, and filled areas.

The agent decides what to draw and how to compose it. Artboard provides the means to put that composition on a canvas.

Its primary integration surface is **MCP (Model Context Protocol)**, allowing the Adventure engine and other compatible agents to use its drawing capabilities. MCP transport and the small browser command interface are under development; the current implementation exposes the toolkit as a TypeScript library and a Node CLI.

## For Humans

Think of Artboard as a drawing desk an agent can operate. A description such as “a clearing at dawn, with a castle on the horizon” becomes a composition assembled through drawing commands.

The intended look is deliberately retro: low-resolution scenes, clear silhouettes, expressive colour choices, and the atmosphere of classic graphical adventures. The reference is a visual language, leaving room for new stories and worlds.

## For Agents

Artboard is being developed around simple, composable drawing tools:

- Draw circles, rectangles, triangles, and lines.
- Fill areas and apply colours.
- Position and combine primitives to build a scene.
- Draw on a canvas through MCP.

These operations give agents a practical vocabulary for constructing images, including agents running on local language models. The approach focuses on tool-driven composition rather than requiring a dedicated image-generation model.

## How it fits into Adventure

**Adventure** creates the evolving experience: the story, the choices, and the world that responds to the player.

**Artboard** supplies the drawing capabilities used to represent that world.

Artboard is designed as a reusable component. Adventure is its original home, but other agents can use the same toolkit to compose their own scenes.

## Project Status

**Under development.** The drawing application is being explored and refined, and its visual style is still evolving.

The repository contains the drawing core, a separate editor/reviewer workflow, Node adapters, and a DOS-style browser interface with prompt, canvas, and monitor columns. The UI is not connected to drawing execution or agents yet. Artboard is the maintained drawing component of Adventure. Story generation, narration, player choices, and game sessions stay in Adventure.

## Start

```sh
npm ci
npm run dev
```

Use Node.js 22.12 or newer. On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`. The browser shows the unconnected DOS-style UI. No model connection is required to start it. See the [browser interface](src/ui/README.md) for its controls and integration boundary.

## Structure

```text
src/core/           Drawing contracts, tools, rendering, catalogs, and history
src/agents/         Drawing editor/reviewer workflow and model transport
src/adapters/node/  Filesystem persistence and image encoding
src/ui/             Three-column DOS-style browser interface
scripts/            Node commands and reproducible artifact generation
tests/              Drawing, agent, and browser UI invariants
schemas/            Generated scene and tool JSON contracts
```

Core, agents, Node adapters, and UI have separate responsibilities and import boundaries enforced by lint. The UI does not import agent orchestration or Node adapters. Vite builds the browser application and separate reusable library entries.

- [Drawing core](src/core/README.md)
- [Drawing agents](src/agents/README.md)
- [Node adapter](src/adapters/node/README.md)
- [Browser interface](src/ui/README.md)
- [Setup, commands, model configuration, and validation](DEVELOPMENT.md)
- [Development contract](AGENTS.md)

---

Created by [Diego Donofrio](https://github.com/ddonofrio).

