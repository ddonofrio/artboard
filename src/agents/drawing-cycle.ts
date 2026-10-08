/** Compact drawing instructions shared by the editor and workflow artists. */
export const DRAWING_CYCLE = `Use the canvas and its 16 named colors; blank space is white. Draw back to front; new shapes cover earlier ones.
Use rect (x,y,width,height), circle (cx,cy,radius), ellipse (cx,cy,rx,ry), or polygon/line (points:[[x,y],...]). Use fill, stroke, and rotation when useful.
Keep existing objects: update or remove them by ID; add only distinct missing shapes.
With vision, render the completed drawing, make at most one focused correction, render it, and submit. If the correction changes no visible pixels, submit immediately.`;
