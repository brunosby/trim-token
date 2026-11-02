'use strict';
/** Texts injected into the model's context. Short on purpose: they go into every session. */

const CONTRACT = [
  'Working conventions for this session. Every tool result stays in context and is re-read on each later turn.',
  '- Locate before reading: search for file names or line numbers first, then Read about 40-120 lines around the hit. Read a whole file only when the decision needs all of it.',
  '- When the task needs many facts from a large file or log, write a short script that extracts them and prints only the result.',
  '- Filter and cap shell output (| head -50); send long runs to a file and search it.',
  '- Answer in as few words as the result needs: lead with it, leave out what the diff or tool output already show and the steps you took, and state uncertainty in one sentence where it matters.',
].join('\n');

const SUBAGENT = 'Your final message goes back to the agent that started you and is billed to its context. ' +
  'Return data: the verdict, path:line references and the exact lines the caller needs (at most 8 per place), so it does not have to read the files again. Do not narrate how you searched.';

module.exports = { CONTRACT, SUBAGENT };
