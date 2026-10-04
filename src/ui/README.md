# Browser interface

This directory contains a new English work-in-progress page using Vite, vanilla TypeScript, and CSS. The HTML shell and existing Artboard logo supply the content. It has no drawing controls, model configuration, agent execution, or persistence endpoints.

UI modules import only other UI modules. ESLint enforces this boundary. Browser integration uses an explicit service contract when introduced; UI code does not import orchestration or Node adapters. Vite development and preview remain ordinary static application servers.
