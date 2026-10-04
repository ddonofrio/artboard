# Browser interface

The browser interface uses Vite, vanilla TypeScript, and CSS. It contains prompt, canvas, and monitor columns in the same proportions as Adventure. Prompt and monitor fit their content; the canvas frame fits its image. The background is `#171b22`. Frames use VGA box-drawing characters and the locally bundled IBM VGA 8x16 font at its native 16-pixel size. Outer frames use double lines; inner boxes and buttons use single lines. Frame titles have white brackets and yellow text. Top edges split around their titles instead of drawing behind them.

All interface text is in English. Prompt contains a text area, a borderless Send control on its bottom-right edge, local checkboxes for batch input and editing the current scene, and a numeric layer count from 1 to 9. Send is gray and disabled when the input is empty, and white when it contains non-whitespace text. Canvas contains only the empty 640 by 480 drawing surface, scaled to the column width at a 4:3 aspect ratio. Monitor contains Stats and Real time log. Stats shows numerical tool-call, success, failure, retry, and average run-time values, initialized to zero. The log and all statistics are static; controls do not start execution.

Each framed element establishes its own positioning context so nested borders stay inside their own boxes. ResizeObserver updates the glyph edges when a box changes size. The interface has no menus, tabs, keyboard shortcuts, API settings, file controls, or prompt inspectors.

The UI is not connected to drawing execution, agents, model endpoints, or persistence yet. Typing, changing checkboxes, and pressing Send do not start a run or send requests. UI modules import only other UI modules. ESLint enforces this boundary. Browser integration requires an explicit service contract before connecting execution.

The unmodified font is by VileR, from [The Ultimate Oldschool PC Font Pack](https://int10h.org/oldschool-pc-fonts/), under CC BY-SA 4.0. Its license and attribution are included in `public/fonts`.
