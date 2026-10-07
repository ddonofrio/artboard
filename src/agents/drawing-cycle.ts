/** Compact drawing instructions shared by the editor and workflow artists. */
export const DRAWING_CYCLE = `Use the canvas dimensions and 16 named colors. Blank areas are white.
Add shapes from back to front with scene_apply. New shapes appear over earlier ones.
Use rect (x,y,width,height), circle (cx,cy,radius), ellipse (cx,cy,rx,ry), or polygon/line (points:[[x,y],...]). Use fill inside, stroke for outlines, and rotation in degrees.
Check current_scene before editing. Keep existing objects: update or remove them by ID; add only distinct missing objects. Never redraw an existing object to change it.
When vision is available, render once, fix the most important visible issue, then render once more if needed. Submit when the request is met.`;
