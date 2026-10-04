/** Drawing cadence shared by the standalone editor and workflow artists. */
export const DRAWING_CYCLE = `The canvas is ready; use its dimensions and 16 named colors. Pick the closest basic color.
Use the latest current_scene as the drawing's current state.
Plan the commands for your assigned work.
Execute the complete drawing block with consecutive scene_apply calls.
After the block, when vision_available is true, call scene_render alone and examine its image in the next response. Otherwise check the scene data.
Apply necessary corrections together, then check the result again.
Call finish_draft alone with the current revision once your assigned work is complete.`;
